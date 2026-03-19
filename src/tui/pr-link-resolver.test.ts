import { describe, expect, test } from "bun:test";
import {
  extractPrNumber,
  extractPrNumberFromComments,
  extractPrUrl,
  extractPrUrlFromComments,
  parsePrListUrl,
  parsePrViewUrl,
  resolvePrUrlForIssue,
} from "./pr-link-resolver.ts";

describe("extractPrUrl", () => {
  test("extracts GitHub PR URL from text", () => {
    const text = "PR pushed: https://github.com/org/repo/pull/42";
    expect(extractPrUrl(text)).toBe("https://github.com/org/repo/pull/42");
  });

  test("returns null when no PR URL is present", () => {
    expect(extractPrUrl("no link here")).toBeNull();
  });
});

describe("extractPrNumber", () => {
  test("extracts PR number from URL", () => {
    expect(extractPrNumber("https://github.com/org/repo/pull/12")).toBe(12);
  });

  test("extracts PR number from '#123' format", () => {
    expect(extractPrNumber("PR pushed (#123)")).toBe(123);
  });

  test("returns null for non-PR text", () => {
    expect(extractPrNumber("nothing relevant")).toBeNull();
  });
});

describe("comment extraction", () => {
  test("extracts URL from text/body/content comment fields", () => {
    const comments = [{ body: "done" }, { content: "PR: https://github.com/org/repo/pull/99" }];

    expect(extractPrUrlFromComments(comments)).toBe("https://github.com/org/repo/pull/99");
  });

  test("extracts PR number from comment text", () => {
    const comments = [{ text: "PR pushed (#88)." }];
    expect(extractPrNumberFromComments(comments)).toBe(88);
  });

  test("returns null when comments are missing", () => {
    expect(extractPrUrlFromComments(null)).toBeNull();
    expect(extractPrNumberFromComments(undefined)).toBeNull();
  });
});

describe("GitHub JSON parsers", () => {
  test("parsePrListUrl returns first URL", () => {
    const raw = JSON.stringify([{ url: "https://github.com/org/repo/pull/7" }]);
    expect(parsePrListUrl(raw)).toBe("https://github.com/org/repo/pull/7");
  });

  test("parsePrViewUrl returns URL", () => {
    const raw = JSON.stringify({ url: "https://github.com/org/repo/pull/8" });
    expect(parsePrViewUrl(raw)).toBe("https://github.com/org/repo/pull/8");
  });

  test("parsers return null for malformed payloads", () => {
    expect(parsePrListUrl("bad json")).toBeNull();
    expect(parsePrViewUrl("bad json")).toBeNull();
  });
});

describe("resolvePrUrlForIssue", () => {
  test("prefers explicit pr_url and skips lookups", async () => {
    let byNumberCalls = 0;
    let byIssueCalls = 0;

    const result = await resolvePrUrlForIssue({
      issue: { pr_url: "https://github.com/org/repo/pull/1" },
      issueId: "issue-1",
      status: "review",
      lookupPrUrlByNumber: async () => {
        byNumberCalls += 1;
        return null;
      },
      lookupPrUrlViaGitHub: async () => {
        byIssueCalls += 1;
        return null;
      },
    });

    expect(result).toBe("https://github.com/org/repo/pull/1");
    expect(byNumberCalls).toBe(0);
    expect(byIssueCalls).toBe(0);
  });

  test("resolves PR from comment number before issue fallback", async () => {
    const byNumberCalls: number[] = [];
    const byIssueCalls: string[] = [];

    const result = await resolvePrUrlForIssue({
      issue: {
        id: "issue-2",
        comments: [{ text: "PR pushed (#222)" }],
      },
      issueId: "issue-2",
      status: "review",
      lookupPrUrlByNumber: async (prNumber) => {
        byNumberCalls.push(prNumber);
        return "https://github.com/org/repo/pull/222";
      },
      lookupPrUrlViaGitHub: async (issueId) => {
        byIssueCalls.push(issueId);
        return "https://github.com/org/repo/pull/999";
      },
    });

    expect(result).toBe("https://github.com/org/repo/pull/222");
    expect(byNumberCalls).toEqual([222]);
    expect(byIssueCalls).toEqual([]);
  });

  test("uses GitHub fallback only for review/closed statuses", async () => {
    const calls: string[] = [];

    const reviewResult = await resolvePrUrlForIssue({
      issue: { id: "issue-review" },
      issueId: "issue-review",
      status: "review",
      lookupPrUrlByNumber: async () => null,
      lookupPrUrlViaGitHub: async (issueId) => {
        calls.push(issueId);
        return "https://github.com/org/repo/pull/300";
      },
    });

    const openResult = await resolvePrUrlForIssue({
      issue: { id: "issue-open" },
      issueId: "issue-open",
      status: "open",
      lookupPrUrlByNumber: async () => null,
      lookupPrUrlViaGitHub: async (issueId) => {
        calls.push(issueId);
        return "https://github.com/org/repo/pull/301";
      },
    });

    expect(reviewResult).toBe("https://github.com/org/repo/pull/300");
    expect(openResult).toBeNull();
    expect(calls).toEqual(["issue-review"]);
  });
});
