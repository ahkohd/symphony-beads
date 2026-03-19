import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockExec = mock(async (_cmd: string[], _opts?: unknown) => ({
  code: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../exec.ts", () => ({
  exec: (...args: unknown[]) => mockExec(...(args as [string[], unknown?])),
}));

const { PR_LINK_RESOLUTION_PRECEDENCE, canUsePrActions, resolvePrLink } = await import(
  "./pr-link-resolver.ts"
);

interface ResolverInput {
  issueId: string;
  status: string;
  prUrl: string | null;
  description: string | null;
  comments: unknown;
}

function makeInput(overrides: Partial<ResolverInput> = {}): ResolverInput {
  return {
    issueId: "symphony-beads-jf2.1",
    status: "review",
    prUrl: null,
    description: null,
    comments: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockExec.mockReset();
  mockExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
});

describe("canUsePrActions", () => {
  test("allows review and closed only", () => {
    expect(canUsePrActions("review")).toBe(true);
    expect(canUsePrActions("closed")).toBe(true);
    expect(canUsePrActions("open")).toBe(false);
    expect(canUsePrActions("in_progress")).toBe(false);
  });
});

describe("resolvePrLink", () => {
  test("documents precedence order", () => {
    expect(PR_LINK_RESOLUTION_PRECEDENCE).toEqual([
      "issue_field",
      "description",
      "comments_url",
      "comments_pr_number",
      "gh_head_branch",
      "gh_title_search",
    ]);
  });

  test("uses explicit issue pr_url before lower-precedence strategies", async () => {
    const result = await resolvePrLink(
      makeInput({
        prUrl: " https://github.com/org/repo/pull/10 ",
        description: "See https://github.com/org/repo/pull/11",
        comments: [{ text: "PR https://github.com/org/repo/pull/12" }],
      }),
    );

    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/10",
      source: "issue_field",
      prNumber: null,
    });
    expect(mockExec).toHaveBeenCalledTimes(0);
  });

  test("falls back to description URL", async () => {
    const result = await resolvePrLink(
      makeInput({
        description: "See https://github.com/org/repo/pull/42",
      }),
    );

    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/42",
      source: "description",
      prNumber: null,
    });
    expect(mockExec).toHaveBeenCalledTimes(0);
  });

  test("falls back to URL found in comments", async () => {
    const result = await resolvePrLink(
      makeInput({
        comments: [{ body: "PR is https://github.com/org/repo/pull/99" }],
      }),
    );

    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/99",
      source: "comments_url",
      prNumber: null,
    });
    expect(mockExec).toHaveBeenCalledTimes(0);
  });

  test("resolves PR number from comments via gh pr view", async () => {
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify({ url: "https://github.com/org/repo/pull/333" }),
      stderr: "",
    });

    const result = await resolvePrLink(
      makeInput({
        comments: [{ text: "PR pushed (#333)." }],
      }),
    );

    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/333",
      source: "comments_pr_number",
      prNumber: 333,
    });
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      ["gh", "pr", "view", "333", "--json", "url"],
      expect.any(Object),
    );
  });

  test("falls back to gh lookup by issue branch", async () => {
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ url: "https://github.com/org/repo/pull/123" }]),
      stderr: "",
    });

    const result = await resolvePrLink(makeInput());

    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/123",
      source: "gh_head_branch",
      prNumber: null,
    });
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      [
        "gh",
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        "issue/symphony-beads-jf2.1",
        "--json",
        "url",
        "--limit",
        "1",
      ],
      expect.any(Object),
    );
  });

  test("falls back to gh title search when branch lookup is empty", async () => {
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

    const result = await resolvePrLink(makeInput({ status: "closed", issueId: "issue-5" }));

    expect(result).toEqual({
      url: "https://github.com/org/repo/pull/456",
      source: "gh_title_search",
      prNumber: null,
    });
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      [
        "gh",
        "pr",
        "list",
        "--state",
        "all",
        "--search",
        "issue-5 in:title",
        "--json",
        "url",
        "--limit",
        "1",
      ],
      expect.any(Object),
    );
  });

  test("does not run gh list lookup for non-review/non-closed issues", async () => {
    const result = await resolvePrLink(makeInput({ status: "open" }));

    expect(result).toEqual({
      url: null,
      source: "not_found",
      prNumber: null,
    });
    expect(mockExec).toHaveBeenCalledTimes(0);
  });

  test("returns not_found and preserves comment PR number when view fails", async () => {
    mockExec.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "not found",
    });

    const result = await resolvePrLink(
      makeInput({
        status: "open",
        comments: [{ content: "PR (#777)" }],
      }),
    );

    expect(result).toEqual({
      url: null,
      source: "not_found",
      prNumber: 777,
    });
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});
