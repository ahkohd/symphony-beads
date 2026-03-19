// ---------------------------------------------------------------------------
// Issue data fetching tests — unit tests for issue-data.ts
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Create a mock exec function that we can control per-test
const mockExec = mock(async (_cmd: string[], _opts?: unknown) => ({
  code: 0,
  stdout: "",
  stderr: "",
}));

// Use Bun's mock.module to intercept the exec import
mock.module("../exec.ts", () => ({
  exec: (...args: unknown[]) => mockExec(...(args as [string[], unknown?])),
}));

// Import AFTER mocking so the mock is in place
const { fetchIssueDetail, fetchIssueComments } = await import("./issue-data.ts");

beforeEach(() => {
  mockExec.mockReset();
  // Restore default implementation
  mockExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
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
    expect(result!.dependencies[0]!.id).toBe("dep-1");
    expect(result!.pr_url).toBeNull();
  });

  test("extracts PR URL from description", async () => {
    const issueJson = [
      {
        id: "test-456",
        title: "Feature",
        description: "See PR: https://github.com/org/repo/pull/42 for details",
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

  test("extracts PR URL from issue comments", async () => {
    const issueJson = [
      {
        id: "test-comment-url",
        title: "Review issue",
        description: "No explicit PR URL",
        status: "review",
        comments: [{ text: "PR pushed: https://github.com/org/repo/pull/222" }],
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(issueJson),
      stderr: "",
    });

    const result = await fetchIssueDetail("test-comment-url");
    expect(result).not.toBeNull();
    expect(result!.pr_url).toBe("https://github.com/org/repo/pull/222");
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  test("extracts PR number from comments and resolves via gh pr view", async () => {
    const issueJson = [
      {
        id: "test-comment-pr-number",
        title: "Review issue",
        description: "No explicit PR URL",
        status: "review",
        comments: [{ text: "PR pushed (#333)." }],
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(issueJson),
      stderr: "",
    });
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify({ url: "https://github.com/org/repo/pull/333" }),
      stderr: "",
    });

    const result = await fetchIssueDetail("test-comment-pr-number");
    expect(result).not.toBeNull();
    expect(result!.pr_url).toBe("https://github.com/org/repo/pull/333");
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      ["gh", "pr", "view", "333", "--json", "url"],
      expect.any(Object),
    );
  });

  test("falls back to gh pr lookup by branch for review/closed issues", async () => {
    const issueJson = [
      {
        id: "test-branch-lookup",
        title: "Review issue",
        description: "No explicit PR URL",
        status: "review",
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(issueJson),
      stderr: "",
    });
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ url: "https://github.com/org/repo/pull/123" }]),
      stderr: "",
    });

    const result = await fetchIssueDetail("test-branch-lookup");
    expect(result).not.toBeNull();
    expect(result!.pr_url).toBe("https://github.com/org/repo/pull/123");
  });

  test("falls back to gh title search when branch lookup is empty", async () => {
    const issueJson = [
      {
        id: "test-title-lookup",
        title: "Closed issue",
        description: "No explicit PR URL",
        status: "closed",
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(issueJson),
      stderr: "",
    });
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([]),
      stderr: "",
    });
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ url: "https://github.com/org/repo/pull/456" }]),
      stderr: "",
    });

    const result = await fetchIssueDetail("test-title-lookup");
    expect(result).not.toBeNull();
    expect(result!.pr_url).toBe("https://github.com/org/repo/pull/456");
  });

  test("does not run gh lookup for non-review/non-closed issues", async () => {
    const issueJson = [
      {
        id: "test-open-no-gh",
        title: "Open issue",
        description: "No explicit PR URL",
        status: "open",
      },
    ];

    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(issueJson),
      stderr: "",
    });

    const result = await fetchIssueDetail("test-open-no-gh");
    expect(result).not.toBeNull();
    expect(result!.pr_url).toBeNull();
    expect(mockExec).toHaveBeenCalledTimes(1);
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
    expect(result[0]!.author).toBe("Agent");
    expect(result[0]!.body).toBe("PR pushed. Summary: did the thing.");
    expect(result[0]!.created_at).toBe("2026-03-18T04:15:04Z");
    expect(result[1]!.author).toBe("Human");
    expect(result[1]!.body).toBe("Looks good, merging.");
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
    expect(result[0]!.body).toBe("Comment with body field");
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
    expect(result[0]!.body).toBe("Comment with content field");
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
    expect(result[0]!.author).toBe("SystemUser");
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
