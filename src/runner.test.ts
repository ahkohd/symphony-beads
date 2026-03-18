import { describe, expect, it } from "bun:test";
import { resolveModel, injectJsonMode, parseJsonLine } from "./runner.ts";
import { parseWorkflow } from "./config.ts";
import type { Issue, AgentEvent, TokenCount } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "bd-1",
    identifier: "bd-1",
    title: "Test issue",
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

const FULL_MODELS: Record<string, string> = {
  default: "claude-sonnet-4-5-20250929",
  P0: "claude-opus-4-6",
  P1: "claude-opus-4-6",
  P2: "claude-sonnet-4-5-20250929",
  P3: "claude-haiku-4-5-20251001",
  bug: "claude-opus-4-6",
  chore: "claude-haiku-4-5-20251001",
};

// ---------------------------------------------------------------------------
// resolveModel — resolution order
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
  it("returns null when models map is null", () => {
    const issue = makeIssue({ priority: 0, issue_type: "bug" });
    expect(resolveModel(issue, null)).toBeNull();
  });

  it("returns null when models map is empty and no match", () => {
    const issue = makeIssue();
    expect(resolveModel(issue, {})).toBeNull();
  });

  // -- Priority matching ---------------------------------------------------

  it("matches P0 priority", () => {
    const issue = makeIssue({ priority: 0 });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-opus-4-6");
  });

  it("matches P1 priority", () => {
    const issue = makeIssue({ priority: 1 });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-opus-4-6");
  });

  it("matches P2 priority", () => {
    const issue = makeIssue({ priority: 2 });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-sonnet-4-5-20250929");
  });

  it("matches P3 priority", () => {
    const issue = makeIssue({ priority: 3 });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-haiku-4-5-20251001");
  });

  it("falls back to default for unmapped priority (P4)", () => {
    const issue = makeIssue({ priority: 4 });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-sonnet-4-5-20250929");
  });

  it("falls back to default when priority is null", () => {
    const issue = makeIssue({ priority: null });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-sonnet-4-5-20250929");
  });

  // -- Issue type matching -------------------------------------------------

  it("matches bug issue type", () => {
    const issue = makeIssue({ issue_type: "bug" });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-opus-4-6");
  });

  it("matches chore issue type", () => {
    const issue = makeIssue({ issue_type: "chore" });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-haiku-4-5-20251001");
  });

  it("issue type matching is case-insensitive", () => {
    const issue = makeIssue({ issue_type: "BUG" });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-opus-4-6");
  });

  it("falls back to priority when issue type has no mapping", () => {
    const issue = makeIssue({ issue_type: "feature", priority: 0 });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-opus-4-6");
  });

  // -- Resolution order: type > priority > default -------------------------

  it("issue type takes precedence over priority", () => {
    // bug maps to opus, P3 maps to haiku — bug should win
    const issue = makeIssue({ issue_type: "bug", priority: 3 });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-opus-4-6");
  });

  it("priority takes precedence over default", () => {
    const models = { default: "model-default", P1: "model-p1" };
    const issue = makeIssue({ priority: 1 });
    expect(resolveModel(issue, models)).toBe("model-p1");
  });

  it("default used when no type or priority match", () => {
    const models = { default: "model-default" };
    const issue = makeIssue({ issue_type: "epic", priority: 4 });
    expect(resolveModel(issue, models)).toBe("model-default");
  });

  // -- Per-issue metadata override -----------------------------------------

  it("metadata model overrides everything", () => {
    const issue = makeIssue({
      issue_type: "bug",
      priority: 0,
      metadata: { model: "custom-model-override" },
    });
    expect(resolveModel(issue, FULL_MODELS)).toBe("custom-model-override");
  });

  it("metadata model overrides even with no models map match", () => {
    const issue = makeIssue({
      metadata: { model: "my-special-model" },
    });
    expect(resolveModel(issue, { default: "fallback" })).toBe("my-special-model");
  });

  it("ignores non-model metadata keys", () => {
    const issue = makeIssue({
      priority: 0,
      metadata: { foo: "bar" },
    });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-opus-4-6");
  });

  it("metadata with empty model string is treated as truthy (empty string)", () => {
    // Empty string is falsy in JS, so it falls through
    const issue = makeIssue({
      priority: 0,
      metadata: { model: "" },
    });
    // Empty string is falsy, so metadata override doesn't trigger
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-opus-4-6");
  });

  it("null metadata falls through to type/priority resolution", () => {
    const issue = makeIssue({
      issue_type: "chore",
      priority: 1,
      metadata: null,
    });
    expect(resolveModel(issue, FULL_MODELS)).toBe("claude-haiku-4-5-20251001");
  });
});

// ---------------------------------------------------------------------------
// Config parsing — models section
// ---------------------------------------------------------------------------

describe("parseWorkflow models config", () => {
  it("parses models as nested map under runner", () => {
    const wf = parseWorkflow(`---
runner:
  command: pi --no-session --model $SYMPHONY_MODEL
  models:
    default: claude-sonnet-4-5-20250929
    P0: claude-opus-4-6
    P1: claude-opus-4-6
    P2: claude-sonnet-4-5-20250929
    P3: claude-haiku-4-5-20251001
    bug: claude-opus-4-6
    chore: claude-haiku-4-5-20251001
---
Prompt.`);

    expect(wf.config.runner.models).not.toBeNull();
    const models = wf.config.runner.models as Record<string, string>;
    expect(models.default).toBe("claude-sonnet-4-5-20250929");
    expect(models.P0).toBe("claude-opus-4-6");
    expect(models.P1).toBe("claude-opus-4-6");
    expect(models.P2).toBe("claude-sonnet-4-5-20250929");
    expect(models.P3).toBe("claude-haiku-4-5-20251001");
    expect(models.bug).toBe("claude-opus-4-6");
    expect(models.chore).toBe("claude-haiku-4-5-20251001");
  });

  it("models is null by default when not specified", () => {
    const wf = parseWorkflow(`---
runner:
  command: pi --no-session
---
Prompt.`);

    expect(wf.config.runner.models).toBeNull();
  });

  it("command with $SYMPHONY_MODEL is preserved as string", () => {
    const wf = parseWorkflow(`---
runner:
  command: pi --no-session --model $SYMPHONY_MODEL
---
Prompt.`);

    expect(wf.config.runner.command).toBe("pi --no-session --model $SYMPHONY_MODEL");
  });

  it("models map works alongside other runner fields", () => {
    const wf = parseWorkflow(`---
runner:
  command: pi --no-session --model $SYMPHONY_MODEL
  turn_timeout_ms: 7200000
  stall_timeout_ms: 600000
  models:
    default: claude-sonnet-4-5-20250929
    P0: claude-opus-4-6
---
Prompt.`);

    expect(wf.config.runner.command).toBe("pi --no-session --model $SYMPHONY_MODEL");
    expect(wf.config.runner.turn_timeout_ms).toBe(7200000);
    expect(wf.config.runner.stall_timeout_ms).toBe(600000);
    expect(wf.config.runner.models).not.toBeNull();
    const models = wf.config.runner.models as Record<string, string>;
    expect(models.default).toBe("claude-sonnet-4-5-20250929");
    expect(models.P0).toBe("claude-opus-4-6");
  });

  it("backward compatible: no models config leaves runner.models null", () => {
    const wf = parseWorkflow("Just a prompt.");
    expect(wf.config.runner.models).toBeNull();
    expect(wf.config.runner.command).toBe("pi --no-session");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: config parse → resolveModel
// ---------------------------------------------------------------------------

describe("end-to-end model routing", () => {
  const wf = parseWorkflow(`---
runner:
  command: pi --no-session --model $SYMPHONY_MODEL
  models:
    default: claude-sonnet-4-5-20250929
    P0: claude-opus-4-6
    bug: claude-opus-4-6
    chore: claude-haiku-4-5-20251001
---
Prompt.`);

  it("resolves bug type from parsed config", () => {
    const issue = makeIssue({ issue_type: "bug", priority: 2 });
    const model = resolveModel(issue, wf.config.runner.models);
    expect(model).toBe("claude-opus-4-6");
  });

  it("resolves P0 priority from parsed config", () => {
    const issue = makeIssue({ priority: 0 });
    const model = resolveModel(issue, wf.config.runner.models);
    expect(model).toBe("claude-opus-4-6");
  });

  it("resolves default from parsed config for unmatched issue", () => {
    const issue = makeIssue({ issue_type: "feature", priority: 2 });
    const model = resolveModel(issue, wf.config.runner.models);
    expect(model).toBe("claude-sonnet-4-5-20250929");
  });

  it("resolves metadata override from parsed config", () => {
    const issue = makeIssue({
      issue_type: "chore",
      metadata: { model: "claude-opus-4-6" },
    });
    const model = resolveModel(issue, wf.config.runner.models);
    expect(model).toBe("claude-opus-4-6");
  });
});
