import { describe, expect, it } from "bun:test";

/** Extract issue ID from branch name like "issue/symphony-beads-p00" */
function extractIssueId(branch: string): string | null {
  const match = branch.match(/^issue\/(.+)$/);
  return match?.[1] ?? null;
}

describe("PrMonitor extractIssueId", () => {
  it("extracts simple issue ID", () => {
    expect(extractIssueId("issue/bd-42")).toBe("bd-42");
  });

  it("extracts symphony-beads style ID", () => {
    expect(extractIssueId("issue/symphony-beads-p00")).toBe("symphony-beads-p00");
  });

  it("extracts complex issue ID with multiple segments", () => {
    expect(extractIssueId("issue/my-project-abc-123")).toBe("my-project-abc-123");
  });

  it("returns null for non-issue branches", () => {
    expect(extractIssueId("main")).toBeNull();
    expect(extractIssueId("feature/something")).toBeNull();
    expect(extractIssueId("fix/bug-123")).toBeNull();
  });

  it("returns null for empty branch", () => {
    expect(extractIssueId("")).toBeNull();
  });

  it("returns null for issue/ with no ID (regex requires 1+ chars)", () => {
    expect(extractIssueId("issue/")).toBeNull();
  });

  it("handles branch with dots and underscores", () => {
    expect(extractIssueId("issue/bd-42_v1.0")).toBe("bd-42_v1.0");
  });

  it("captures full path after issue/", () => {
    expect(extractIssueId("issue/sub/bd-42")).toBe("sub/bd-42");
  });

  it("is case-sensitive for prefix", () => {
    expect(extractIssueId("Issue/bd-42")).toBeNull();
    expect(extractIssueId("ISSUE/bd-42")).toBeNull();
  });
});

describe("PrMonitor PR filtering", () => {
  interface GhPrRaw {
    number: number;
    title: string;
    headRefName: string;
    state: string;
    reviewDecision: string;
  }

  interface PrInfo {
    number: number;
    title: string;
    branch: string;
    state: string;
    reviewDecision: string;
    issueId: string | null;
  }

  function filterAndMap(prs: GhPrRaw[]): PrInfo[] {
    return prs
      .filter((pr) => pr.headRefName.startsWith("issue/"))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        state: pr.state,
        reviewDecision: pr.reviewDecision || "",
        issueId: extractIssueId(pr.headRefName),
      }));
  }

  it("filters to only issue/ branches", () => {
    const prs: GhPrRaw[] = [
      { number: 1, title: "Issue PR", headRefName: "issue/bd-1", state: "OPEN", reviewDecision: "" },
      { number: 2, title: "Feature PR", headRefName: "feature/cool", state: "OPEN", reviewDecision: "" },
      { number: 3, title: "Another Issue", headRefName: "issue/bd-2", state: "MERGED", reviewDecision: "APPROVED" },
    ];
    const filtered = filterAndMap(prs);
    expect(filtered).toHaveLength(2);
    expect(filtered[0]!.issueId).toBe("bd-1");
    expect(filtered[1]!.issueId).toBe("bd-2");
  });

  it("maps reviewDecision empty string when missing", () => {
    const prs: GhPrRaw[] = [
      { number: 1, title: "PR", headRefName: "issue/bd-1", state: "OPEN", reviewDecision: "" },
    ];
    const filtered = filterAndMap(prs);
    expect(filtered[0]!.reviewDecision).toBe("");
  });

  it("identifies merged PRs", () => {
    const prs: GhPrRaw[] = [
      { number: 1, title: "PR", headRefName: "issue/bd-1", state: "MERGED", reviewDecision: "APPROVED" },
    ];
    const filtered = filterAndMap(prs);
    expect(filtered[0]!.state).toBe("MERGED");
  });

  it("identifies changes-requested PRs", () => {
    const prs: GhPrRaw[] = [
      { number: 1, title: "PR", headRefName: "issue/bd-1", state: "OPEN", reviewDecision: "CHANGES_REQUESTED" },
    ];
    const filtered = filterAndMap(prs);
    expect(filtered[0]!.state).toBe("OPEN");
    expect(filtered[0]!.reviewDecision).toBe("CHANGES_REQUESTED");
  });

  it("handles empty PR list", () => {
    expect(filterAndMap([])).toEqual([]);
  });
});

describe("PrMonitor state transition logic", () => {
  type Action = "close" | "reopen" | "none";

  function decideAction(state: string, reviewDecision: string, issueId: string | null): Action {
    if (!issueId) return "none";
    if (state === "MERGED") return "close";
    if (state === "OPEN" && reviewDecision === "CHANGES_REQUESTED") return "reopen";
    return "none";
  }

  it("merged PR triggers close", () => {
    expect(decideAction("MERGED", "APPROVED", "bd-1")).toBe("close");
  });

  it("merged PR triggers close regardless of review decision", () => {
    expect(decideAction("MERGED", "", "bd-1")).toBe("close");
    expect(decideAction("MERGED", "CHANGES_REQUESTED", "bd-1")).toBe("close");
  });

  it("open PR with changes requested triggers reopen", () => {
    expect(decideAction("OPEN", "CHANGES_REQUESTED", "bd-1")).toBe("reopen");
  });

  it("open PR without changes requested is no-op", () => {
    expect(decideAction("OPEN", "", "bd-1")).toBe("none");
    expect(decideAction("OPEN", "APPROVED", "bd-1")).toBe("none");
    expect(decideAction("OPEN", "REVIEW_REQUIRED", "bd-1")).toBe("none");
  });

  it("closed (not merged) PR is no-op", () => {
    expect(decideAction("CLOSED", "", "bd-1")).toBe("none");
  });

  it("null issue ID is always no-op", () => {
    expect(decideAction("MERGED", "APPROVED", null)).toBe("none");
    expect(decideAction("OPEN", "CHANGES_REQUESTED", null)).toBe("none");
  });
});

describe("PrMonitor processed-PR tracking", () => {
  interface PrInfo {
    number: number;
    state: string;
    reviewDecision: string;
    issueId: string | null;
  }

  /**
   * Simulates the check() loop logic: decides actions for a list of PRs,
   * tracking which have been processed to avoid duplicates.
   * Returns the list of actions taken.
   */
  function simulateCheck(
    prs: PrInfo[],
    processedPrs: Set<number>,
  ): Array<{ pr: number; action: "close" | "reopen" }> {
    const actions: Array<{ pr: number; action: "close" | "reopen" }> = [];

    for (const pr of prs) {
      if (!pr.issueId) continue;

      // OPEN without changes requested clears from processed set (rework)
      if (pr.state === "OPEN" && pr.reviewDecision !== "CHANGES_REQUESTED") {
        processedPrs.delete(pr.number);
        continue;
      }

      // Already handled — skip
      if (processedPrs.has(pr.number)) continue;

      if (pr.state === "MERGED") {
        actions.push({ pr: pr.number, action: "close" });
        processedPrs.add(pr.number);
      } else if (pr.state === "OPEN" && pr.reviewDecision === "CHANGES_REQUESTED") {
        actions.push({ pr: pr.number, action: "reopen" });
        processedPrs.add(pr.number);
      }
    }

    return actions;
  }

  it("processes a merged PR on the first tick", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [
      { number: 1, state: "MERGED", reviewDecision: "APPROVED", issueId: "bd-1" },
    ];
    const actions = simulateCheck(prs, processed);
    expect(actions).toEqual([{ pr: 1, action: "close" }]);
    expect(processed.has(1)).toBe(true);
  });

  it("skips already-processed merged PR on subsequent ticks", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [
      { number: 1, state: "MERGED", reviewDecision: "APPROVED", issueId: "bd-1" },
    ];
    simulateCheck(prs, processed); // first tick
    const actions = simulateCheck(prs, processed); // second tick
    expect(actions).toEqual([]); // no duplicate action
  });

  it("skips already-processed changes-requested PR on subsequent ticks", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [
      { number: 2, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", issueId: "bd-2" },
    ];
    simulateCheck(prs, processed);
    const actions = simulateCheck(prs, processed);
    expect(actions).toEqual([]);
  });

  it("clears processed state when PR transitions back to OPEN without changes requested", () => {
    const processed = new Set<number>();

    // Tick 1: PR has changes requested → reopen
    const prs1: PrInfo[] = [
      { number: 3, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", issueId: "bd-3" },
    ];
    const a1 = simulateCheck(prs1, processed);
    expect(a1).toEqual([{ pr: 3, action: "reopen" }]);

    // Tick 2: developer pushes fixes, review clears
    const prs2: PrInfo[] = [
      { number: 3, state: "OPEN", reviewDecision: "REVIEW_REQUIRED", issueId: "bd-3" },
    ];
    const a2 = simulateCheck(prs2, processed);
    expect(a2).toEqual([]);
    expect(processed.has(3)).toBe(false); // cleared from set

    // Tick 3: changes requested again → should re-process
    const prs3: PrInfo[] = [
      { number: 3, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", issueId: "bd-3" },
    ];
    const a3 = simulateCheck(prs3, processed);
    expect(a3).toEqual([{ pr: 3, action: "reopen" }]);
  });

  it("handles rework → merge cycle correctly", () => {
    const processed = new Set<number>();

    // Tick 1: changes requested
    const prs1: PrInfo[] = [
      { number: 4, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", issueId: "bd-4" },
    ];
    simulateCheck(prs1, processed);

    // Tick 2: developer pushes, review clears
    const prs2: PrInfo[] = [
      { number: 4, state: "OPEN", reviewDecision: "", issueId: "bd-4" },
    ];
    simulateCheck(prs2, processed);

    // Tick 3: PR merged
    const prs3: PrInfo[] = [
      { number: 4, state: "MERGED", reviewDecision: "APPROVED", issueId: "bd-4" },
    ];
    const a3 = simulateCheck(prs3, processed);
    expect(a3).toEqual([{ pr: 4, action: "close" }]);
  });

  it("skips PRs without issue IDs", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [
      { number: 5, state: "MERGED", reviewDecision: "APPROVED", issueId: null },
    ];
    const actions = simulateCheck(prs, processed);
    expect(actions).toEqual([]);
    expect(processed.has(5)).toBe(false);
  });

  it("handles multiple PRs independently", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [
      { number: 10, state: "MERGED", reviewDecision: "APPROVED", issueId: "bd-10" },
      { number: 11, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", issueId: "bd-11" },
      { number: 12, state: "OPEN", reviewDecision: "", issueId: "bd-12" },
    ];
    const a1 = simulateCheck(prs, processed);
    expect(a1).toEqual([
      { pr: 10, action: "close" },
      { pr: 11, action: "reopen" },
    ]);

    // Second tick — only PR 12 could become actionable
    const a2 = simulateCheck(prs, processed);
    expect(a2).toEqual([]); // 10 and 11 are already processed, 12 is OPEN/no-action
  });
});
