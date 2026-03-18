// ---------------------------------------------------------------------------
// Issue data fetching tests — unit tests for issue-data.ts
// ---------------------------------------------------------------------------

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import {
  fetchIssueDetail,
  fetchIssueComments,
  fetchAgentSession,
  type IssueDetail,
  type IssueComment,
  type AgentSessionInfo,
} from "./issue-data.ts";

// We mock the exec module to control subprocess output
const mockExec = mock(async () => ({ code: 0, stdout: "", stderr: "" }));

// Patch exec at module level
import * as execModule from "../exec.ts";
const originalExec = execModule.exec;

beforeEach(() => {
  mockExec.mockReset();
  // @ts-ignore — patching for test
  (execModule as any).exec = mockExec;
});

afterEach(() => {
  // @ts-ignore — restore
  (execModule as any).exec = originalExec;
});

// -- fetchIssueDetail --------------------------------------------------------

describe("fetchIssueDetail", () => {
  test("parses bd show --json output (array format)", async () => {
    const issueJson = [
      {
        id: "test-123",
        title: "Fix the bug",
        description: "A long description",
        status: "open",
        priority: 1,
        issue_type: "bug",
        owner: "agent@test",
        created_at: "2026-01-01T00:00:00Z",
        created_by: "Agent",
        updated_at: "2026-01-02T00:00:00Z",
        dependencies: [
          {
            id: "dep-1",
            title: "Dependency",
            status: "closed",
            priority: 2,
            issue_type: "task",
            dependency_type: "blocks",
          },
        ],
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(issueJson),
      stderr: "",
    });

    const result = await fetchIssueDetail("test-123");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("test-123");
    expect(result!.title).toBe("Fix the bug");
    expect(result!.description).toBe("A long description");
    expect(result!.status).toBe("open");
    expect(result!.priority).toBe(1);
    expect(result!.issue_type).toBe("bug");
    expect(result!.owner).toBe("agent@test");
    expect(result!.dependencies).toHaveLength(1);
    expect(result!.dependencies[0].id).toBe("dep-1");
    expect(result!.pr_url).toBeNull();
  });

  test("extracts PR URL from description", async () => {
    const issueJson = [
      {
        id: "test-456",
        title: "Feature",
        description:
          "See PR: https://github.com/org/repo/pull/42 for details",
        status: "review",
        priority: 2,
        issue_type: "feature",
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(issueJson),
      stderr: "",
    });

    const result = await fetchIssueDetail("test-456");
    expect(result).not.toBeNull();
    expect(result!.pr_url).toBe("https://github.com/org/repo/pull/42");
  });

  test("uses pr_url field directly if present", async () => {
    const issueJson = [
      {
        id: "test-789",
        title: "PR Test",
        description: "No PR in description",
        status: "open",
        pr_url: "https://github.com/org/repo/pull/99",
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(issueJson),
      stderr: "",
    });

    const result = await fetchIssueDetail("test-789");
    expect(result).not.toBeNull();
    expect(result!.pr_url).toBe("https://github.com/org/repo/pull/99");
  });

  test("returns null on command failure", async () => {
    mockExec.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "not found",
    });

    const result = await fetchIssueDetail("nonexistent");
    expect(result).toBeNull();
  });

  test("returns null on empty output", async () => {
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const result = await fetchIssueDetail("empty");
    expect(result).toBeNull();
  });

  test("handles missing optional fields gracefully", async () => {
    const issueJson = [{ id: "minimal" }];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(issueJson),
      stderr: "",
    });

    const result = await fetchIssueDetail("minimal");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("minimal");
    expect(result!.title).toBe("(untitled)");
    expect(result!.description).toBeNull();
    expect(result!.status).toBe("unknown");
    expect(result!.priority).toBeNull();
    expect(result!.issue_type).toBe("task");
    expect(result!.owner).toBeNull();
    expect(result!.dependencies).toEqual([]);
    expect(result!.pr_url).toBeNull();
  });
});

// -- fetchIssueComments ------------------------------------------------------

describe("fetchIssueComments", () => {
  test("parses bd comments --json output with text field", async () => {
    const commentsJson = [
      {
        id: "comment-1",
        author: "Agent",
        text: "PR pushed. Summary: did the thing.",
        created_at: "2026-03-18T04:15:04Z",
      },
      {
        id: "comment-2",
        author: "Human",
        text: "Looks good, merging.",
        created_at: "2026-03-18T05:00:00Z",
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(commentsJson),
      stderr: "",
    });

    const result = await fetchIssueComments("test-123");
    expect(result).toHaveLength(2);
    expect(result[0].author).toBe("Agent");
    expect(result[0].body).toBe("PR pushed. Summary: did the thing.");
    expect(result[0].created_at).toBe("2026-03-18T04:15:04Z");
    expect(result[1].author).toBe("Human");
    expect(result[1].body).toBe("Looks good, merging.");
  });

  test("falls back to body field when text is missing", async () => {
    const commentsJson = [
      {
        id: "comment-1",
        author: "Agent",
        body: "Comment with body field",
        created_at: "2026-03-18T04:15:04Z",
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(commentsJson),
      stderr: "",
    });

    const result = await fetchIssueComments("test-123");
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("Comment with body field");
  });

  test("falls back to content field", async () => {
    const commentsJson = [
      {
        id: "comment-1",
        author: "Agent",
        content: "Comment with content field",
        created_at: "2026-03-18T04:15:04Z",
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(commentsJson),
      stderr: "",
    });

    const result = await fetchIssueComments("test-123");
    expect(result).toHaveLength(1);
    expect(result[0].body).toBe("Comment with content field");
  });

  test("uses created_by as fallback for author", async () => {
    const commentsJson = [
      {
        id: "comment-1",
        created_by: "SystemUser",
        text: "Automated comment",
        created_at: "2026-03-18T04:15:04Z",
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(commentsJson),
      stderr: "",
    });

    const result = await fetchIssueComments("test-123");
    expect(result).toHaveLength(1);
    expect(result[0].author).toBe("SystemUser");
  });

  test("returns empty array on command failure", async () => {
    mockExec.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const result = await fetchIssueComments("nonexistent");
    expect(result).toEqual([]);
  });

  test("returns empty array on empty output", async () => {
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const result = await fetchIssueComments("empty");
    expect(result).toEqual([]);
  });

  test("returns empty array on non-array JSON", async () => {
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: '{"error": "not an array"}',
      stderr: "",
    });

    const result = await fetchIssueComments("bad-json");
    expect(result).toEqual([]);
  });
});

// -- fetchAgentSession -------------------------------------------------------

describe("fetchAgentSession", () => {
  // We can't easily mock fetch in Bun tests without a library,
  // so we test the error/offline path (fetch to nonexistent server)
  test("returns null when API is unreachable", async () => {
    const result = await fetchAgentSession(
      "test-123",
      "http://127.0.0.1:19999",
    );
    expect(result).toBeNull();
  });

  test("returns null with default API base when offline", async () => {
    // Default base (4500) is likely not running in tests
    const result = await fetchAgentSession("test-123");
    expect(result).toBeNull();
  });
});
