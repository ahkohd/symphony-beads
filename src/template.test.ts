import { describe, expect, it } from "bun:test";
import { renderPrompt } from "./template.ts";
import type { Issue } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "bd-42",
    identifier: "bd-42",
    title: "Fix the widget",
    description: "The widget is broken when clicked twice.",
    priority: 1,
    state: "open",
    labels: ["bug", "urgent"],
    blocked_by: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Variable rendering
// ---------------------------------------------------------------------------

describe("renderPrompt variable substitution", () => {
  it("renders simple top-level variables", () => {
    const result = renderPrompt("Attempt: {{ attempt }}", makeIssue(), 3);
    expect(result).toBe("Attempt: 3");
  });

  it("renders dotted issue fields", () => {
    const result = renderPrompt(
      "ID={{ issue.identifier }} T={{ issue.title }}",
      makeIssue(),
      null,
    );
    expect(result).toBe("ID=bd-42 T=Fix the widget");
  });

  it("renders description", () => {
    const result = renderPrompt("{{ issue.description }}", makeIssue(), null);
    expect(result).toBe("The widget is broken when clicked twice.");
  });

  it("renders null description as empty string", () => {
    const result = renderPrompt("Desc=[{{ issue.description }}]", makeIssue({ description: null }), null);
    expect(result).toBe("Desc=[]");
  });

  it("renders priority", () => {
    const result = renderPrompt("P={{ issue.priority }}", makeIssue({ priority: 0 }), null);
    expect(result).toBe("P=0");
  });

  it("renders null priority as empty string", () => {
    const result = renderPrompt("P=[{{ issue.priority }}]", makeIssue({ priority: null }), null);
    expect(result).toBe("P=[]");
  });

  it("renders labels as comma-separated string", () => {
    const result = renderPrompt("Labels: {{ issue.labels }}", makeIssue(), null);
    expect(result).toBe("Labels: bug, urgent");
  });

  it("renders empty labels as empty string", () => {
    const result = renderPrompt("Labels: [{{ issue.labels }}]", makeIssue({ labels: [] }), null);
    expect(result).toBe("Labels: []");
  });

  it("renders attempt as empty string when null", () => {
    const result = renderPrompt("A=[{{ attempt }}]", makeIssue(), null);
    expect(result).toBe("A=[]");
  });

  it("handles spaces around variable names", () => {
    const result = renderPrompt("{{issue.title}} / {{ issue.title }} / {{  issue.title  }}", makeIssue(), null);
    expect(result).toBe("Fix the widget / Fix the widget / Fix the widget");
  });

  it("renders unknown variables as empty string", () => {
    const result = renderPrompt("X={{ nonexistent }}", makeIssue(), null);
    expect(result).toBe("X=");
  });

  it("renders unknown nested variables as empty string", () => {
    const result = renderPrompt("X={{ issue.nonexistent }}", makeIssue(), null);
    expect(result).toBe("X=");
  });
});

// ---------------------------------------------------------------------------
// Extra variables
// ---------------------------------------------------------------------------

describe("renderPrompt extra variables", () => {
  it("renders extra top-level variables", () => {
    const result = renderPrompt(
      "Feedback: {{ review_feedback }}",
      makeIssue(),
      null,
      { review_feedback: "Please fix tests" },
    );
    expect(result).toBe("Feedback: Please fix tests");
  });

  it("renders empty extra as empty string", () => {
    const result = renderPrompt(
      "Feedback: [{{ review_feedback }}]",
      makeIssue(),
      null,
      { review_feedback: "" },
    );
    expect(result).toBe("Feedback: []");
  });
});

// ---------------------------------------------------------------------------
// Sections (truthy blocks)
// ---------------------------------------------------------------------------

describe("renderPrompt sections", () => {
  it("renders section when value is truthy", () => {
    const result = renderPrompt(
      "{{#issue.description}}Has desc{{/issue.description}}",
      makeIssue(),
      null,
    );
    expect(result).toBe("Has desc");
  });

  it("hides section when value is null", () => {
    const result = renderPrompt(
      "{{#issue.description}}Has desc{{/issue.description}}",
      makeIssue({ description: null }),
      null,
    );
    expect(result).toBe("");
  });

  it("hides section when value is empty string", () => {
    const result = renderPrompt(
      "{{#issue.description}}Has desc{{/issue.description}}",
      makeIssue({ description: "" }),
      null,
    );
    expect(result).toBe("");
  });

  it("renders section with nested variable access", () => {
    const result = renderPrompt(
      "{{#issue.description}}Desc: {{ issue.description }}{{/issue.description}}",
      makeIssue(),
      null,
    );
    expect(result).toBe("Desc: The widget is broken when clicked twice.");
  });

  it("renders section for truthy attempt", () => {
    const result = renderPrompt(
      "{{#attempt}}Retry #{{ attempt }}{{/attempt}}",
      makeIssue(),
      2,
    );
    expect(result).toBe("Retry #2");
  });

  it("hides section when attempt is null (rendered as empty string which is falsy)", () => {
    const result = renderPrompt(
      "[{{#attempt}}Retry{{/attempt}}]",
      makeIssue(),
      null,
    );
    expect(result).toBe("[]");
  });
});

// ---------------------------------------------------------------------------
// Inverted sections
// ---------------------------------------------------------------------------

describe("renderPrompt inverted sections", () => {
  it("renders inverted section when value is null", () => {
    const result = renderPrompt(
      "{{^issue.description}}No description{{/issue.description}}",
      makeIssue({ description: null }),
      null,
    );
    expect(result).toBe("No description");
  });

  it("hides inverted section when value is truthy", () => {
    const result = renderPrompt(
      "{{^issue.description}}No desc{{/issue.description}}",
      makeIssue(),
      null,
    );
    expect(result).toBe("");
  });

  it("renders inverted section for empty array (labels)", () => {
    const result = renderPrompt(
      "{{^issue.blocked_by}}No blockers{{/issue.blocked_by}}",
      makeIssue({ blocked_by: [] }),
      null,
    );
    expect(result).toBe("No blockers");
  });

  it("hides inverted section for non-empty array", () => {
    const result = renderPrompt(
      "{{^issue.blocked_by}}No blockers{{/issue.blocked_by}}",
      makeIssue({ blocked_by: [{ id: "bd-1", identifier: "bd-1", state: "open" }] }),
      null,
    );
    expect(result).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Nested / deep access
// ---------------------------------------------------------------------------

describe("renderPrompt nested access", () => {
  it("renders state field", () => {
    const result = renderPrompt("State: {{ issue.state }}", makeIssue({ state: "in_progress" }), null);
    expect(result).toBe("State: in_progress");
  });

  it("renders id and identifier", () => {
    const result = renderPrompt(
      "{{ issue.id }} / {{ issue.identifier }}",
      makeIssue({ id: "bd-99", identifier: "bd-99" }),
      null,
    );
    expect(result).toBe("bd-99 / bd-99");
  });
});

// ---------------------------------------------------------------------------
// Full template integration
// ---------------------------------------------------------------------------

describe("renderPrompt full template", () => {
  it("renders a realistic workflow prompt", () => {
    const template = `Issue: {{ issue.identifier }}
Title: {{ issue.title }}
{{#issue.description}}
Description: {{ issue.description }}
{{/issue.description}}
{{^issue.description}}
No description provided.
{{/issue.description}}
Priority: {{ issue.priority }}
Labels: {{ issue.labels }}`;

    const result = renderPrompt(template, makeIssue(), null);
    expect(result).toContain("Issue: bd-42");
    expect(result).toContain("Title: Fix the widget");
    expect(result).toContain("Description: The widget is broken");
    expect(result).toContain("Priority: 1");
    expect(result).toContain("Labels: bug, urgent");
    expect(result).not.toContain("No description provided.");
  });
});
