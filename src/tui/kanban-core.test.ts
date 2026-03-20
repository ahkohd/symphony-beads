import { describe, expect, test } from "bun:test";

import { formatIssueCount } from "./kanban-core.ts";

describe("formatIssueCount", () => {
  test("uses singular label for one issue", () => {
    expect(formatIssueCount(1)).toBe("1 issue");
  });

  test("uses plural label for zero and many issues", () => {
    expect(formatIssueCount(0)).toBe("0 issues");
    expect(formatIssueCount(2)).toBe("2 issues");
  });
});
