import { describe, expect, test } from "bun:test";
import {
  bucketIssues,
  clampCursor,
  filterIssues,
  moveCursorHorizontal,
  moveCursorToRow,
  selectCard,
} from "./state.ts";
import type { Issue } from "./types.ts";

const BASE_ISSUE: Omit<Issue, "id" | "title" | "status" | "priority"> = {
  issue_type: "task",
  owner: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  closed_at: null,
};

function makeIssue(id: string, status: string, priority: number | null = null): Issue {
  return {
    ...BASE_ISSUE,
    id,
    title: `Title ${id}`,
    status,
    priority,
  };
}

describe("filterIssues", () => {
  test("matches query against id/title/status", () => {
    const issues = [makeIssue("abc-1", "open"), makeIssue("xyz-2", "closed")];

    expect(filterIssues(issues, "abc")).toHaveLength(1);
    expect(filterIssues(issues, "closed")).toHaveLength(1);
    expect(filterIssues(issues, "missing")).toHaveLength(0);
  });
});

describe("bucketIssues", () => {
  test("sorts closed by recency in default mode", () => {
    const older = { ...makeIssue("old", "closed"), closed_at: "2026-01-01T00:00:00Z" };
    const newer = { ...makeIssue("new", "closed"), closed_at: "2026-01-03T00:00:00Z" };

    const buckets = bucketIssues([older, newer], {});
    const closed = buckets.get("closed") ?? [];

    expect(closed.map((issue) => issue.id)).toEqual(["new", "old"]);
  });

  test("sorts by priority when mode is priority", () => {
    const p2 = makeIssue("p2", "open", 2);
    const p0 = makeIssue("p0", "open", 0);

    const buckets = bucketIssues([p2, p0], { open: "priority" });
    const open = buckets.get("open") ?? [];

    expect(open.map((issue) => issue.id)).toEqual(["p0", "p2"]);
  });
});

describe("cursor helpers", () => {
  test("clampCursor keeps cursor within column/card bounds", () => {
    const buckets = bucketIssues([makeIssue("one", "open")], {});
    const clamped = clampCursor({ col: 99, row: 99 }, buckets);

    expect(clamped.col).toBeGreaterThanOrEqual(0);
    expect(clamped.col).toBeLessThanOrEqual(4);
    expect(clamped.row).toBe(0);
  });

  test("moveCursorHorizontal preserves row when possible", () => {
    const buckets = bucketIssues([makeIssue("a", "open"), makeIssue("b", "in_progress")], {});
    const moved = moveCursorHorizontal({ col: 0, row: 0 }, 1, buckets);
    expect(moved).toEqual({ col: 1, row: 0 });
  });

  test("moveCursorToRow clamps to available rows", () => {
    const buckets = bucketIssues([makeIssue("a", "open")], {});
    expect(moveCursorToRow({ col: 0, row: 0 }, 5, buckets).row).toBe(0);
  });

  test("selectCard clamps row to existing cards", () => {
    const buckets = bucketIssues([makeIssue("a", "open")], {});
    expect(selectCard(0, 10, buckets)).toEqual({ col: 0, row: 0 });
  });
});
