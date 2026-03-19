// ---------------------------------------------------------------------------
// PR link resolution tests — unit tests for pr-link-resolver.ts
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, mock, test } from "bun:test";

const mockExec = mock(async (_cmd: string[], _opts?: unknown) => ({
  code: 0,
  stdout: "",
  stderr: "",
}));

mock.module("../exec.ts", () => ({
  exec: (...args: unknown[]) => mockExec(...(args as [string[], unknown?])),
}));

const { canOpenPr, resolvePrLink } = await import("./pr-link-resolver.ts");

beforeEach(() => {
  mockExec.mockReset();
  mockExec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
});

describe("canOpenPr", () => {
  test("allows review and closed statuses", () => {
    expect(canOpenPr("review")).toBe(true);
    expect(canOpenPr("closed")).toBe(true);
  });

  test("rejects non-review statuses", () => {
    expect(canOpenPr("open")).toBe(false);
    expect(canOpenPr("in_progress")).toBe(false);
    expect(canOpenPr("deferred")).toBe(false);
  });
});

describe("resolvePrLink", () => {
  const baseInput = {
    issueId: "symphony-beads-123",
    status: "review",
    explicitPrUrl: null,
    description: null,
    comments: null,
  };

  test("uses explicit pr_url before other sources", async () => {
    const result = await resolvePrLink({
      ...baseInput,
      explicitPrUrl: " https://github.com/org/repo/pull/10 ",
      description: "see https://github.com/org/repo/pull/11",
      comments: [{ text: "PR: https://github.com/org/repo/pull/12" }],
    });

    expect(result).toEqual({
      source: "issue_pr_url",
      url: "https://github.com/org/repo/pull/10",
    });
    expect(mockExec).toHaveBeenCalledTimes(0);
  });

  test("uses description link when pr_url field is missing", async () => {
    const result = await resolvePrLink({
      ...baseInput,
      description: "Tracking PR: https://github.com/org/repo/pull/42",
      comments: [{ text: "PR: https://github.com/org/repo/pull/99" }],
    });

    expect(result).toEqual({
      source: "description",
      url: "https://github.com/org/repo/pull/42",
    });
    expect(mockExec).toHaveBeenCalledTimes(0);
  });

  test("uses comment URL when no explicit or description URL exists", async () => {
    const result = await resolvePrLink({
      ...baseInput,
      comments: [{ body: "PR pushed: https://github.com/org/repo/pull/222" }],
    });

    expect(result).toEqual({
      source: "comments_url",
      url: "https://github.com/org/repo/pull/222",
    });
    expect(mockExec).toHaveBeenCalledTimes(0);
  });

  test("resolves comment PR number via gh pr view", async () => {
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify({ url: "https://github.com/org/repo/pull/333" }),
      stderr: "",
    });

    const result = await resolvePrLink({
      ...baseInput,
      status: "open",
      comments: [{ text: "PR pushed (#333)." }],
    });

    expect(result).toEqual({
      source: "comments_pr_number",
      url: "https://github.com/org/repo/pull/333",
    });
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      ["gh", "pr", "view", "333", "--json", "url"],
      expect.any(Object),
    );
  });

  test("falls back to github branch lookup for review/closed issues", async () => {
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ url: "https://github.com/org/repo/pull/123" }]),
      stderr: "",
    });

    const result = await resolvePrLink(baseInput);

    expect(result).toEqual({
      source: "github_head",
      url: "https://github.com/org/repo/pull/123",
    });
    expect(mockExec).toHaveBeenCalledTimes(1);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      [
        "gh",
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        "issue/symphony-beads-123",
        "--json",
        "url",
        "--limit",
        "1",
      ],
      expect.any(Object),
    );
  });

  test("falls back to github title lookup when branch lookup is empty", async () => {
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

    const result = await resolvePrLink(baseInput);

    expect(result).toEqual({
      source: "github_title",
      url: "https://github.com/org/repo/pull/456",
    });
    expect(mockExec).toHaveBeenCalledTimes(2);
    expect(mockExec).toHaveBeenNthCalledWith(
      1,
      [
        "gh",
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        "issue/symphony-beads-123",
        "--json",
        "url",
        "--limit",
        "1",
      ],
      expect.any(Object),
    );
    expect(mockExec).toHaveBeenNthCalledWith(
      2,
      [
        "gh",
        "pr",
        "list",
        "--state",
        "all",
        "--search",
        "symphony-beads-123 in:title",
        "--json",
        "url",
        "--limit",
        "1",
      ],
      expect.any(Object),
    );
  });

  test("does not perform github fallback for non-review/non-closed status", async () => {
    const result = await resolvePrLink({
      ...baseInput,
      status: "open",
    });

    expect(result).toEqual({
      source: "none",
      url: null,
    });
    expect(mockExec).toHaveBeenCalledTimes(0);
  });

  test("returns none when all lookups fail", async () => {
    mockExec.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "failed",
    });
    mockExec.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([]),
      stderr: "",
    });

    const result = await resolvePrLink(baseInput);

    expect(result).toEqual({
      source: "none",
      url: null,
    });
    expect(mockExec).toHaveBeenCalledTimes(2);
  });
});
