import { describe, expect, it } from "bun:test";
import { resolveModel, injectJsonMode, parseJsonLine, isPiCommand } from "./runner.ts";
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

// ---------------------------------------------------------------------------
// isPiCommand — detect pi runner binary
// ---------------------------------------------------------------------------

describe("isPiCommand", () => {
  it("returns true for bare 'pi'", () => {
    expect(isPiCommand(["pi", "--no-session"])).toBe(true);
  });

  it("returns true for absolute path to pi", () => {
    expect(isPiCommand(["/usr/local/bin/pi", "--no-session"])).toBe(true);
  });

  it("returns true for relative path to pi", () => {
    expect(isPiCommand(["./node_modules/.bin/pi"])).toBe(true);
  });

  it("returns false for non-pi commands", () => {
    expect(isPiCommand(["claude", "--no-session"])).toBe(false);
    expect(isPiCommand(["aider", "--yes"])).toBe(false);
    expect(isPiCommand(["bash", "-c", "echo hi"])).toBe(false);
  });

  it("returns false for empty command", () => {
    expect(isPiCommand([])).toBe(false);
  });

  it("returns false for command containing pi as a substring", () => {
    expect(isPiCommand(["pipeline"])).toBe(false);
    expect(isPiCommand(["api-runner"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// injectJsonMode — insert --mode json into command array
// ---------------------------------------------------------------------------

describe("injectJsonMode", () => {
  it("inserts --mode json after the binary", () => {
    expect(injectJsonMode(["pi", "--no-session"])).toEqual([
      "pi", "--mode", "json", "--no-session",
    ]);
  });

  it("works with single-element command", () => {
    expect(injectJsonMode(["pi"])).toEqual(["pi", "--mode", "json"]);
  });

  it("preserves all arguments", () => {
    expect(injectJsonMode(["pi", "--no-session", "--model", "claude-sonnet"])).toEqual([
      "pi", "--mode", "json", "--no-session", "--model", "claude-sonnet",
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseJsonLine — token extraction from pi --mode json events
// ---------------------------------------------------------------------------

describe("parseJsonLine", () => {
  function makeTokens(): TokenCount {
    return { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0, cost: 0 };
  }

  function collectEvents(
    line: string,
    tokens?: TokenCount,
    textParts?: string[],
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    const tok = tokens ?? makeTokens();
    const parts = textParts ?? [];
    parseJsonLine(line, tok, parts, (ev) => events.push(ev));
    return events;
  }

  it("extracts token usage from message_end event including cache tokens", () => {
    const tokens = makeTokens();
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        usage: {
          input: 3,
          output: 54,
          cacheRead: 5825,
          cacheWrite: 322,
          totalTokens: 6204,
          cost: { input: 0.000015, output: 0.00135, cacheRead: 0.0029, cacheWrite: 0.002, total: 0.00629 },
        },
      },
    });

    const events = collectEvents(line, tokens);

    expect(tokens.input).toBe(3);
    expect(tokens.output).toBe(54);
    expect(tokens.cache_read).toBe(5825);
    expect(tokens.cache_write).toBe(322);
    expect(tokens.total).toBe(6204);
    expect(tokens.cost).toBeCloseTo(0.00629, 4);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("token_update");
    if (events[0]!.kind === "token_update") {
      expect(events[0]!.tokens.total).toBe(6204);
      expect(events[0]!.tokens.cache_read).toBe(5825);
    }
  });

  it("extracts tokens from message_end without cache fields (backwards compat)", () => {
    const tokens = makeTokens();
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 1500, output: 300 },
      },
    });

    const events = collectEvents(line, tokens);

    expect(tokens.input).toBe(1500);
    expect(tokens.output).toBe(300);
    expect(tokens.cache_read).toBe(0);
    expect(tokens.cache_write).toBe(0);
    expect(tokens.total).toBe(1800);
    expect(events).toHaveLength(1);
  });

  it("accumulates tokens across multiple message_end events", () => {
    const tokens = makeTokens();
    const textParts: string[] = [];

    const line1 = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 3, output: 54, cacheRead: 5825, cacheWrite: 322, totalTokens: 6204, cost: { total: 0.006 } },
      },
    });
    const line2 = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 1, output: 4, cacheRead: 6147, cacheWrite: 70, totalTokens: 6222, cost: { total: 0.004 } },
      },
    });

    parseJsonLine(line1, tokens, textParts, () => {});
    parseJsonLine(line2, tokens, textParts, () => {});

    expect(tokens.input).toBe(4);
    expect(tokens.output).toBe(58);
    expect(tokens.cache_read).toBe(11972);
    expect(tokens.cache_write).toBe(392);
    expect(tokens.total).toBe(12426);
    expect(tokens.cost).toBeCloseTo(0.01, 4);
  });

  it("extracts text from turn_end events", () => {
    const textParts: string[] = [];
    const line = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I made the changes." },
          { type: "tool_use", id: "t1" },
          { type: "text", text: "All done." },
        ],
      },
    });

    collectEvents(line, undefined, textParts);

    expect(textParts).toEqual(["I made the changes.", "All done."]);
  });

  it("ignores non-assistant message_end events", () => {
    const tokens = makeTokens();
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "user", usage: { input: 500, output: 100 } },
    });

    const events = collectEvents(line, tokens);
    expect(tokens.total).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("ignores non-JSON lines gracefully", () => {
    const tokens = makeTokens();
    const events = collectEvents("this is not json", tokens);
    expect(tokens.total).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("ignores events without a type field", () => {
    const tokens = makeTokens();
    const events = collectEvents(JSON.stringify({ foo: "bar" }), tokens);
    expect(events).toHaveLength(0);
  });

  it("handles agent_end event with authoritative totals from message list", () => {
    const tokens = makeTokens();
    // Simulate some accumulated tokens from message_end
    tokens.input = 10;
    tokens.output = 50;
    tokens.cache_read = 100;
    tokens.cache_write = 20;
    tokens.total = 180;
    tokens.cost = 0.001;

    // agent_end carries all messages with per-message usage
    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "do stuff" }] },
        {
          role: "assistant",
          usage: { input: 3, output: 54, cacheRead: 5825, cacheWrite: 322, totalTokens: 6204, cost: { total: 0.006 } },
        },
        { role: "toolResult", toolCallId: "t1" },
        {
          role: "assistant",
          usage: { input: 1, output: 4, cacheRead: 6147, cacheWrite: 70, totalTokens: 6222, cost: { total: 0.004 } },
        },
      ],
    });

    const events = collectEvents(line, tokens);

    // agent_end replaces accumulated values with authoritative totals
    expect(tokens.input).toBe(4);
    expect(tokens.output).toBe(58);
    expect(tokens.cache_read).toBe(11972);
    expect(tokens.cache_write).toBe(392);
    expect(tokens.total).toBe(12426);
    expect(tokens.cost).toBeCloseTo(0.01, 4);
    expect(events).toHaveLength(1);
    if (events[0]!.kind === "token_update") {
      expect(events[0]!.tokens.total).toBe(12426);
    }
  });

  it("handles session_end event with authoritative totals", () => {
    const tokens = makeTokens();
    tokens.input = 1000;
    tokens.output = 200;
    tokens.total = 1200;

    const line = JSON.stringify({
      type: "session_end",
      usage: { input_tokens: 2500, output_tokens: 500 },
    });

    const events = collectEvents(line, tokens);

    expect(tokens.input).toBe(2500);
    expect(tokens.output).toBe(500);
    expect(tokens.total).toBe(3000);
    expect(events).toHaveLength(1);
  });

  it("handles usage_summary event", () => {
    const tokens = makeTokens();
    const line = JSON.stringify({
      type: "usage_summary",
      usage: { input_tokens: 5000, output_tokens: 1200 },
    });

    const events = collectEvents(line, tokens);

    expect(tokens.input).toBe(5000);
    expect(tokens.output).toBe(1200);
    expect(tokens.total).toBe(6200);
    expect(events).toHaveLength(1);
  });

  it("handles message_end with missing usage gracefully", () => {
    const tokens = makeTokens();
    const line = JSON.stringify({
      type: "message_end",
      message: { role: "assistant" },
    });

    const events = collectEvents(line, tokens);
    expect(tokens.total).toBe(0);
    expect(events).toHaveLength(0);
  });

  it("skips empty text blocks in turn_end", () => {
    const textParts: string[] = [];
    const line = JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
          { type: "text", text: "real content" },
        ],
      },
    });

    collectEvents(line, undefined, textParts);
    expect(textParts).toEqual(["real content"]);
  });

  it("handles agent_end with no assistant messages gracefully", () => {
    const tokens = makeTokens();
    tokens.input = 100;
    tokens.output = 50;
    tokens.total = 150;

    const line = JSON.stringify({
      type: "agent_end",
      messages: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
    });

    const events = collectEvents(line, tokens);

    // No assistant messages → resets to zero (authoritative)
    expect(tokens.input).toBe(0);
    expect(tokens.output).toBe(0);
    expect(tokens.total).toBe(0);
    expect(events).toHaveLength(1);
  });

  it("handles cost tracking across message_end events", () => {
    const tokens = makeTokens();
    const textParts: string[] = [];

    parseJsonLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 10, output: 20, cost: { total: 0.005 } },
        },
      }),
      tokens,
      textParts,
      () => {},
    );

    parseJsonLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 5, output: 10, cost: { total: 0.003 } },
        },
      }),
      tokens,
      textParts,
      () => {},
    );

    expect(tokens.cost).toBeCloseTo(0.008, 4);
  });
});
