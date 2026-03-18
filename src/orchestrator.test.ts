import { describe, expect, it } from "bun:test";
import type { Issue } from "./types.ts";

// ---------------------------------------------------------------------------
// We test the Orchestrator's pure logic by extracting the algorithms
// into standalone functions that mirror the private methods. This avoids
// needing to wire up the full async start() loop with real subprocesses.
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "bd-1",
    identifier: "bd-1",
    title: "Test",
    description: null,
    priority: null,
    state: "open",
    labels: [],
    blocked_by: [],
    issue_type: null,
    metadata: null,
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

// -- Replicate Orchestrator.sortForDispatch ----------------------------------

function sortForDispatch(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? 99;
    const pb = b.priority ?? 99;
    if (pa !== pb) return pa - pb;
    if (a.created_at && b.created_at && a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    return a.identifier.localeCompare(b.identifier);
  });
}

// -- Replicate Orchestrator.eligible -----------------------------------------

function eligible(
  issue: Issue,
  running: Set<string>,
  claimed: Set<string>,
  terminalStates: Set<string>,
): boolean {
  if (running.has(issue.id)) return false;
  if (claimed.has(issue.id)) return false;

  const s = issue.state.toLowerCase();
  if ((s === "open" || s === "todo") && issue.blocked_by.length > 0) {
    const blocked = issue.blocked_by.some(
      (b) => b.state !== null && !terminalStates.has(b.state.toLowerCase()),
    );
    if (blocked) return false;
  }

  return true;
}

// -- Replicate retry backoff calculation -------------------------------------

function computeRetryDelay(
  attempt: number,
  maxBackoffMs: number,
  isError: boolean,
): number {
  if (!isError) return 1_000; // continuation retry
  return Math.min(10_000 * Math.pow(2, attempt - 1), maxBackoffMs);
}

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

describe("Orchestrator sortForDispatch", () => {
  it("sorts by priority ascending (lower number = higher priority)", () => {
    const issues = [
      makeIssue({ id: "bd-a", identifier: "bd-a", priority: 3 }),
      makeIssue({ id: "bd-b", identifier: "bd-b", priority: 0 }),
      makeIssue({ id: "bd-c", identifier: "bd-c", priority: 1 }),
    ];
    const sorted = sortForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["bd-b", "bd-c", "bd-a"]);
  });

  it("treats null priority as 99 (lowest)", () => {
    const issues = [
      makeIssue({ id: "bd-a", identifier: "bd-a", priority: null }),
      makeIssue({ id: "bd-b", identifier: "bd-b", priority: 2 }),
    ];
    const sorted = sortForDispatch(issues);
    expect(sorted[0]!.id).toBe("bd-b");
    expect(sorted[1]!.id).toBe("bd-a");
  });

  it("breaks priority ties with created_at (oldest first)", () => {
    const issues = [
      makeIssue({ id: "bd-a", identifier: "bd-a", priority: 1, created_at: "2026-03-02" }),
      makeIssue({ id: "bd-b", identifier: "bd-b", priority: 1, created_at: "2026-03-01" }),
    ];
    const sorted = sortForDispatch(issues);
    expect(sorted[0]!.id).toBe("bd-b");
    expect(sorted[1]!.id).toBe("bd-a");
  });

  it("breaks priority+date ties with identifier alphabetically", () => {
    const issues = [
      makeIssue({ id: "bd-z", identifier: "bd-z", priority: 1 }),
      makeIssue({ id: "bd-a", identifier: "bd-a", priority: 1 }),
      makeIssue({ id: "bd-m", identifier: "bd-m", priority: 1 }),
    ];
    const sorted = sortForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual(["bd-a", "bd-m", "bd-z"]);
  });

  it("handles empty array", () => {
    expect(sortForDispatch([])).toEqual([]);
  });

  it("handles single issue", () => {
    const issues = [makeIssue({ id: "bd-only" })];
    const sorted = sortForDispatch(issues);
    expect(sorted).toHaveLength(1);
    expect(sorted[0]!.id).toBe("bd-only");
  });

  it("sorts complex mix correctly", () => {
    const issues = [
      makeIssue({ id: "bd-5", identifier: "bd-5", priority: null, created_at: "2026-01-01" }),
      makeIssue({ id: "bd-1", identifier: "bd-1", priority: 0, created_at: "2026-03-01" }),
      makeIssue({ id: "bd-2", identifier: "bd-2", priority: 1, created_at: "2026-02-01" }),
      makeIssue({ id: "bd-3", identifier: "bd-3", priority: 1, created_at: "2026-01-01" }),
      makeIssue({ id: "bd-4", identifier: "bd-4", priority: 2 }),
    ];
    const sorted = sortForDispatch(issues);
    expect(sorted.map((i) => i.id)).toEqual([
      "bd-1", // priority 0
      "bd-3", // priority 1, older
      "bd-2", // priority 1, newer
      "bd-4", // priority 2
      "bd-5", // priority null = 99
    ]);
  });
});

// ---------------------------------------------------------------------------
// Dispatch eligibility
// ---------------------------------------------------------------------------

describe("Orchestrator eligible", () => {
  const terminal = new Set(["closed", "cancelled", "duplicate"]);

  it("eligible for fresh issue", () => {
    const issue = makeIssue({ id: "bd-1" });
    expect(eligible(issue, new Set(), new Set(), terminal)).toBe(true);
  });

  it("not eligible if already running", () => {
    const issue = makeIssue({ id: "bd-1" });
    expect(eligible(issue, new Set(["bd-1"]), new Set(), terminal)).toBe(false);
  });

  it("not eligible if already claimed", () => {
    const issue = makeIssue({ id: "bd-1" });
    expect(eligible(issue, new Set(), new Set(["bd-1"]), terminal)).toBe(false);
  });

  it("not eligible if blocked by non-terminal issue", () => {
    const issue = makeIssue({
      id: "bd-1",
      state: "open",
      blocked_by: [{ id: "bd-0", identifier: "bd-0", state: "open" }],
    });
    expect(eligible(issue, new Set(), new Set(), terminal)).toBe(false);
  });

  it("eligible if blocker is in terminal state", () => {
    const issue = makeIssue({
      id: "bd-1",
      state: "open",
      blocked_by: [{ id: "bd-0", identifier: "bd-0", state: "closed" }],
    });
    expect(eligible(issue, new Set(), new Set(), terminal)).toBe(true);
  });

  it("eligible if blocker state is null (unknown)", () => {
    const issue = makeIssue({
      id: "bd-1",
      state: "open",
      blocked_by: [{ id: "bd-0", identifier: "bd-0", state: null }],
    });
    expect(eligible(issue, new Set(), new Set(), terminal)).toBe(true);
  });

  it("blocker check only applies to open/todo states", () => {
    const issue = makeIssue({
      id: "bd-1",
      state: "in_progress",
      blocked_by: [{ id: "bd-0", identifier: "bd-0", state: "open" }],
    });
    expect(eligible(issue, new Set(), new Set(), terminal)).toBe(true);
  });

  it("blocked if any blocker is non-terminal", () => {
    const issue = makeIssue({
      id: "bd-1",
      state: "open",
      blocked_by: [
        { id: "bd-0", identifier: "bd-0", state: "closed" },
        { id: "bd-2", identifier: "bd-2", state: "in_progress" },
      ],
    });
    expect(eligible(issue, new Set(), new Set(), terminal)).toBe(false);
  });

  it("eligible if all blockers are terminal", () => {
    const issue = makeIssue({
      id: "bd-1",
      state: "open",
      blocked_by: [
        { id: "bd-0", identifier: "bd-0", state: "closed" },
        { id: "bd-2", identifier: "bd-2", state: "cancelled" },
      ],
    });
    expect(eligible(issue, new Set(), new Set(), terminal)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Retry backoff calculation
// ---------------------------------------------------------------------------

describe("Orchestrator retry backoff", () => {
  it("continuation retry (no error) is always 1s", () => {
    expect(computeRetryDelay(1, 300_000, false)).toBe(1_000);
    expect(computeRetryDelay(5, 300_000, false)).toBe(1_000);
    expect(computeRetryDelay(100, 300_000, false)).toBe(1_000);
  });

  it("error retry starts at 10s for attempt 1", () => {
    expect(computeRetryDelay(1, 300_000, true)).toBe(10_000);
  });

  it("error retry doubles each attempt", () => {
    expect(computeRetryDelay(1, 300_000, true)).toBe(10_000);
    expect(computeRetryDelay(2, 300_000, true)).toBe(20_000);
    expect(computeRetryDelay(3, 300_000, true)).toBe(40_000);
    expect(computeRetryDelay(4, 300_000, true)).toBe(80_000);
    expect(computeRetryDelay(5, 300_000, true)).toBe(160_000);
  });

  it("error retry caps at max_retry_backoff_ms", () => {
    expect(computeRetryDelay(6, 300_000, true)).toBe(300_000);
    expect(computeRetryDelay(10, 300_000, true)).toBe(300_000);
    expect(computeRetryDelay(100, 300_000, true)).toBe(300_000);
  });

  it("respects custom max backoff", () => {
    expect(computeRetryDelay(1, 5_000, true)).toBe(5_000);
    expect(computeRetryDelay(3, 50_000, true)).toBe(40_000);
    expect(computeRetryDelay(4, 50_000, true)).toBe(50_000);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation state transitions (logic verification)
// ---------------------------------------------------------------------------

describe("Orchestrator reconciliation logic", () => {
  const activeStates = new Set(["open", "in_progress"]);
  const terminalStates = new Set(["closed", "cancelled", "duplicate"]);

  function isActive(state: string): boolean {
    return activeStates.has(state.toLowerCase());
  }

  function isTerminal(state: string): boolean {
    return terminalStates.has(state.toLowerCase());
  }

  type Action = "kill_and_remove" | "kill_and_cleanup" | "refresh";

  function reconcileAction(currentState: string): Action {
    if (isTerminal(currentState)) return "kill_and_cleanup";
    if (!isActive(currentState)) return "kill_and_remove";
    return "refresh";
  }

  it("terminal state triggers kill + cleanup", () => {
    expect(reconcileAction("closed")).toBe("kill_and_cleanup");
    expect(reconcileAction("cancelled")).toBe("kill_and_cleanup");
    expect(reconcileAction("duplicate")).toBe("kill_and_cleanup");
  });

  it("non-active, non-terminal state triggers kill + remove", () => {
    expect(reconcileAction("review")).toBe("kill_and_remove");
    expect(reconcileAction("blocked")).toBe("kill_and_remove");
  });

  it("active state triggers refresh (keep running)", () => {
    expect(reconcileAction("open")).toBe("refresh");
    expect(reconcileAction("in_progress")).toBe("refresh");
  });

  it("slots available check", () => {
    const maxConcurrent = 3;
    const slotsAvailable = (runningSize: number) => runningSize < maxConcurrent;

    expect(slotsAvailable(0)).toBe(true);
    expect(slotsAvailable(1)).toBe(true);
    expect(slotsAvailable(2)).toBe(true);
    expect(slotsAvailable(3)).toBe(false);
    expect(slotsAvailable(5)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot structure (verify type shape)
// ---------------------------------------------------------------------------

describe("Orchestrator snapshot structure", () => {
  it("counts reflect running state", () => {
    const running = new Map([["bd-1", {}], ["bd-2", {}]]);
    const retries = new Map([["bd-3", {}]]);
    const completed = new Set(["bd-4", "bd-5"]);
    const claimed = new Set(["bd-1", "bd-2", "bd-3"]);

    const counts = {
      running: running.size,
      retrying: retries.size,
      completed: completed.size,
      claimed: claimed.size,
    };

    expect(counts.running).toBe(2);
    expect(counts.retrying).toBe(1);
    expect(counts.completed).toBe(2);
    expect(counts.claimed).toBe(3);
  });
});
