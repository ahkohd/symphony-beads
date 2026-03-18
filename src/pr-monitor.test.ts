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
      {
        number: 1,
        title: "Issue PR",
        headRefName: "issue/bd-1",
        state: "OPEN",
        reviewDecision: "",
      },
      {
        number: 2,
        title: "Feature PR",
        headRefName: "feature/cool",
        state: "OPEN",
        reviewDecision: "",
      },
      {
        number: 3,
        title: "Another Issue",
        headRefName: "issue/bd-2",
        state: "MERGED",
        reviewDecision: "APPROVED",
      },
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
      {
        number: 1,
        title: "PR",
        headRefName: "issue/bd-1",
        state: "MERGED",
        reviewDecision: "APPROVED",
      },
    ];
    const filtered = filterAndMap(prs);
    expect(filtered[0]!.state).toBe("MERGED");
  });

  it("identifies changes-requested PRs", () => {
    const prs: GhPrRaw[] = [
      {
        number: 1,
        title: "PR",
        headRefName: "issue/bd-1",
        state: "OPEN",
        reviewDecision: "CHANGES_REQUESTED",
      },
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

  type Action = "close" | "reopen" | "skip" | "clear" | "skip-no-issue";

  /**
   * Simulates the check() loop logic with the processedPrs set.
   * Returns actions taken per PR so tests can assert behaviour.
   */
  function simulateCheck(prs: PrInfo[], processedPrs: Set<number>): Action[] {
    const actions: Action[] = [];
    for (const pr of prs) {
      if (pr.state === "OPEN" && pr.reviewDecision !== "CHANGES_REQUESTED") {
        processedPrs.delete(pr.number);
        actions.push("clear");
        continue;
      }
      if (processedPrs.has(pr.number)) {
        actions.push("skip");
        continue;
      }
      if (!pr.issueId) {
        processedPrs.add(pr.number);
        actions.push("skip-no-issue");
        continue;
      }
      if (pr.state === "MERGED") {
        processedPrs.add(pr.number);
        actions.push("close");
      } else if (pr.state === "OPEN" && pr.reviewDecision === "CHANGES_REQUESTED") {
        processedPrs.add(pr.number);
        actions.push("reopen");
      }
    }
    return actions;
  }

  it("processes a merged PR once then skips on subsequent ticks", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [
      { number: 10, state: "MERGED", reviewDecision: "APPROVED", issueId: "bd-1" },
    ];
    // First tick: should close
    expect(simulateCheck(prs, processed)).toEqual(["close"]);
    expect(processed.has(10)).toBe(true);
    // Second tick: should skip
    expect(simulateCheck(prs, processed)).toEqual(["skip"]);
  });

  it("processes a changes-requested PR once then skips", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [
      { number: 20, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", issueId: "bd-2" },
    ];
    expect(simulateCheck(prs, processed)).toEqual(["reopen"]);
    expect(processed.has(20)).toBe(true);
    expect(simulateCheck(prs, processed)).toEqual(["skip"]);
  });

  it("clears processed flag when PR transitions back to plain OPEN", () => {
    const processed = new Set<number>();

    // Tick 1: changes requested → reopen
    const changesReq: PrInfo[] = [
      { number: 30, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", issueId: "bd-3" },
    ];
    expect(simulateCheck(changesReq, processed)).toEqual(["reopen"]);
    expect(processed.has(30)).toBe(true);

    // Tick 2: developer pushed fixes, review dismissed → back to plain OPEN
    const openAgain: PrInfo[] = [
      { number: 30, state: "OPEN", reviewDecision: "", issueId: "bd-3" },
    ];
    expect(simulateCheck(openAgain, processed)).toEqual(["clear"]);
    expect(processed.has(30)).toBe(false);

    // Tick 3: PR gets merged → should process again
    const merged: PrInfo[] = [
      { number: 30, state: "MERGED", reviewDecision: "APPROVED", issueId: "bd-3" },
    ];
    expect(simulateCheck(merged, processed)).toEqual(["close"]);
    expect(processed.has(30)).toBe(true);
  });

  it("marks PRs without issue ID as processed", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [{ number: 40, state: "MERGED", reviewDecision: "", issueId: null }];
    expect(simulateCheck(prs, processed)).toEqual(["skip-no-issue"]);
    expect(processed.has(40)).toBe(true);
    // Should be skipped on next tick
    expect(simulateCheck(prs, processed)).toEqual(["skip"]);
  });

  it("handles mix of processed and unprocessed PRs", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [
      { number: 50, state: "MERGED", reviewDecision: "APPROVED", issueId: "bd-5" },
      { number: 51, state: "OPEN", reviewDecision: "", issueId: "bd-6" },
      { number: 52, state: "OPEN", reviewDecision: "CHANGES_REQUESTED", issueId: "bd-7" },
    ];
    // First tick
    expect(simulateCheck(prs, processed)).toEqual(["close", "clear", "reopen"]);
    // Second tick — merged and changes-requested are skipped, open is cleared
    expect(simulateCheck(prs, processed)).toEqual(["skip", "clear", "skip"]);
  });

  it("plain OPEN PR is never added to processed set", () => {
    const processed = new Set<number>();
    const prs: PrInfo[] = [{ number: 60, state: "OPEN", reviewDecision: "", issueId: "bd-8" }];
    simulateCheck(prs, processed);
    expect(processed.has(60)).toBe(false);
    simulateCheck(prs, processed);
    expect(processed.has(60)).toBe(false);
  });
});
