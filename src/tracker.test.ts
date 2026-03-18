import { describe, expect, it, beforeEach, mock } from "bun:test";
import type { ServiceConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Mock exec() via mock.module — must be before importing tracker
// ---------------------------------------------------------------------------

const execMock = mock(() =>
  Promise.resolve({ code: 0, stdout: "", stderr: "" }),
);

mock.module("./exec.ts", () => ({
  exec: execMock,
}));

import { BeadsTracker } from "./tracker.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ServiceConfig["tracker"]> = {}): ServiceConfig {
  return {
    tracker: {
      kind: "beads",
      project_path: "/test/project",
      active_states: ["open", "in_progress"],
      terminal_states: ["closed", "cancelled", "duplicate"],
      ...overrides,
    },
    polling: { interval_ms: 30000 },
    workspace: { root: "./workspaces" },
    hooks: { after_create: null, before_run: null, after_run: null, before_remove: null, timeout_ms: 60000 },
    agent: { max_concurrent: 5, max_turns: 20, max_retry_backoff_ms: 300000 },
    runner: { command: "pi -p", model: null, turn_timeout_ms: 3600000, stall_timeout_ms: 300000 },
    log: { file: null },
  };
}

const sampleIssues = [
  { id: "bd-1", title: "Bug fix", status: "open", priority: 1, labels: ["Bug"], deps: [] },
  { id: "bd-2", title: "Feature", status: "in_progress", priority: 2, labels: [], deps: [] },
  { id: "bd-3", title: "Done task", status: "closed", priority: 3, labels: [], deps: [] },
  { id: "bd-4", title: "Cancelled", status: "cancelled", priority: 4, labels: [], deps: [] },
];

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe("BeadsTracker normalization", () => {
  beforeEach(() => execMock.mockClear());

  it("normalizes issue fields from bd output", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([
        {
          id: "bd-10",
          title: "Test Issue",
          description: "A description",
          status: "open",
          priority: 2,
          labels: ["Feature", "UI"],
          deps: [],
          created_at: "2026-01-01",
          updated_at: "2026-01-02",
        },
      ]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();

    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue.id).toBe("bd-10");
    expect(issue.identifier).toBe("bd-10");
    expect(issue.title).toBe("Test Issue");
    expect(issue.description).toBe("A description");
    expect(issue.priority).toBe(2);
    expect(issue.state).toBe("open");
    expect(issue.labels).toEqual(["feature", "ui"]); // lowercased
    expect(issue.blocked_by).toEqual([]);
    expect(issue.created_at).toBe("2026-01-01");
  });

  it("defaults title to 'Untitled' when missing", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ id: "bd-11", status: "open" }]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues[0]!.title).toBe("Untitled");
  });

  it("defaults state to 'open' when status missing", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ id: "bd-12" }]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues[0]!.state).toBe("open");
  });

  it("handles null description and priority", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ id: "bd-13", status: "open" }]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues[0]!.description).toBeNull();
    expect(issues[0]!.priority).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Active / terminal state filtering
// ---------------------------------------------------------------------------

describe("BeadsTracker active state filtering", () => {
  beforeEach(() => execMock.mockClear());

  it("fetchCandidates returns only active-state issues", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(sampleIssues),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    const ids = issues.map((i) => i.id);

    expect(ids).toContain("bd-1"); // open
    expect(ids).toContain("bd-2"); // in_progress
    expect(ids).not.toContain("bd-3"); // closed
    expect(ids).not.toContain("bd-4"); // cancelled
  });

  it("active state check is case-insensitive", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ id: "bd-20", status: "OPEN" }]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues).toHaveLength(1);
  });

  it("isActive and isTerminal work correctly", () => {
    const tracker = new BeadsTracker(makeConfig());
    expect(tracker.isActive("open")).toBe(true);
    expect(tracker.isActive("in_progress")).toBe(true);
    expect(tracker.isActive("closed")).toBe(false);
    expect(tracker.isTerminal("closed")).toBe(true);
    expect(tracker.isTerminal("cancelled")).toBe(true);
    expect(tracker.isTerminal("duplicate")).toBe(true);
    expect(tracker.isTerminal("open")).toBe(false);
  });

  it("isActive/isTerminal are case-insensitive", () => {
    const tracker = new BeadsTracker(makeConfig());
    expect(tracker.isActive("OPEN")).toBe(true);
    expect(tracker.isActive("In_Progress")).toBe(true);
    expect(tracker.isTerminal("CLOSED")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Terminal ID filtering
// ---------------------------------------------------------------------------

describe("BeadsTracker terminal IDs", () => {
  beforeEach(() => execMock.mockClear());

  it("fetchTerminalIds returns only terminal-state issue IDs", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(sampleIssues),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const ids = await tracker.fetchTerminalIds();
    expect(ids).toContain("bd-3"); // closed
    expect(ids).toContain("bd-4"); // cancelled
    expect(ids).not.toContain("bd-1");
    expect(ids).not.toContain("bd-2");
  });
});

// ---------------------------------------------------------------------------
// Blocker extraction
// ---------------------------------------------------------------------------

describe("BeadsTracker blocker extraction", () => {
  beforeEach(() => execMock.mockClear());

  it("extracts blocked-by dependencies", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([
        { id: "bd-30", status: "open", deps: ["blocked-by:bd-29", "discovered-from:bd-28"] },
      ]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    const blockers = issues[0]!.blocked_by;

    expect(blockers).toHaveLength(1);
    expect(blockers[0]!.id).toBe("bd-29");
    expect(blockers[0]!.identifier).toBe("bd-29");
    expect(blockers[0]!.state).toBeNull();
  });

  it("extracts blocks dependencies", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([
        { id: "bd-31", status: "open", deps: ["blocks:bd-32"] },
      ]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues[0]!.blocked_by).toHaveLength(1);
    expect(issues[0]!.blocked_by[0]!.id).toBe("bd-32");
  });

  it("ignores non-blocker deps like discovered-from", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([
        { id: "bd-33", status: "open", deps: ["discovered-from:bd-20", "relates-to:bd-21"] },
      ]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues[0]!.blocked_by).toEqual([]);
  });

  it("handles no deps field", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ id: "bd-34", status: "open" }]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues[0]!.blocked_by).toEqual([]);
  });

  it("handles multiple blockers", async () => {
    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([
        { id: "bd-35", status: "open", deps: ["blocked-by:bd-10", "blocked-by:bd-11", "blocks:bd-12"] },
      ]),
      stderr: "",
    });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues[0]!.blocked_by).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// fetchStatesById
// ---------------------------------------------------------------------------

describe("BeadsTracker fetchStatesById", () => {
  beforeEach(() => execMock.mockClear());

  it("fetches individual issues by ID", async () => {
    execMock
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ id: "bd-40", title: "One", status: "open" }),
        stderr: "",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ id: "bd-41", title: "Two", status: "closed" }),
        stderr: "",
      });

    const tracker = new BeadsTracker(makeConfig());
    const results = await tracker.fetchStatesById(["bd-40", "bd-41"]);

    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe("bd-40");
    expect(results[1]!.id).toBe("bd-41");
  });

  it("returns empty array for empty input", async () => {
    const tracker = new BeadsTracker(makeConfig());
    const results = await tracker.fetchStatesById([]);
    expect(results).toEqual([]);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("skips issues that fail to fetch", async () => {
    execMock
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "not found" })
      .mockResolvedValueOnce({
        code: 0,
        stdout: JSON.stringify({ id: "bd-43", title: "OK", status: "open" }),
        stderr: "",
      });

    const tracker = new BeadsTracker(makeConfig());
    const results = await tracker.fetchStatesById(["bd-42", "bd-43"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe("bd-43");
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe("BeadsTracker error handling", () => {
  beforeEach(() => execMock.mockClear());

  it("returns empty array when bd list fails", async () => {
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "error" });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues).toEqual([]);
  });

  it("returns empty array when bd list returns invalid JSON", async () => {
    execMock.mockResolvedValueOnce({ code: 0, stdout: "not json", stderr: "" });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues).toEqual([]);
  });

  it("returns empty array when bd list returns non-array JSON", async () => {
    execMock.mockResolvedValueOnce({ code: 0, stdout: '{"key": "value"}', stderr: "" });

    const tracker = new BeadsTracker(makeConfig());
    const issues = await tracker.fetchCandidates();
    expect(issues).toEqual([]);
  });
});
