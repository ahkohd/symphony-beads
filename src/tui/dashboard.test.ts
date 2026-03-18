// ---------------------------------------------------------------------------
// Dashboard helper tests — pure function unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect } from "bun:test";
import { formatElapsed, formatCountdown, truncStr, formatTokens } from "./dashboard.tsx";

describe("formatElapsed", () => {
  test("seconds only", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(1000)).toBe("1s");
    expect(formatElapsed(59_000)).toBe("59s");
  });

  test("minutes and seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(90_000)).toBe("1m 30s");
    expect(formatElapsed(3_540_000)).toBe("59m 0s");
  });

  test("hours and minutes", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m");
    expect(formatElapsed(5_400_000)).toBe("1h 30m");
    expect(formatElapsed(7_200_000)).toBe("2h 0m");
  });

  test("rounds down partial seconds", () => {
    expect(formatElapsed(1500)).toBe("1s");
    expect(formatElapsed(999)).toBe("0s");
  });
});

describe("formatCountdown", () => {
  test("past due returns now", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    expect(formatCountdown(past)).toBe("now");
  });

  test("future time returns elapsed format", () => {
    const future = new Date(Date.now() + 65_000).toISOString();
    const result = formatCountdown(future);
    expect(result).toMatch(/^1m \d+s$/);
  });

  test("exactly now returns now", () => {
    const now = new Date().toISOString();
    expect(formatCountdown(now)).toBe("now");
  });
});

describe("truncStr", () => {
  test("short strings pass through", () => {
    expect(truncStr("hello", 10)).toBe("hello");
    expect(truncStr("hello", 5)).toBe("hello");
  });

  test("long strings get truncated with ellipsis", () => {
    const result = truncStr("hello world", 8);
    expect(result.length).toBe(8);
    expect(result.startsWith("hello w")).toBe(true);
  });

  test("empty string", () => {
    expect(truncStr("", 5)).toBe("");
  });
});

describe("formatTokens", () => {
  test("small numbers unchanged", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });

  test("thousands", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
  });

  test("millions", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(10_000_000)).toBe("10.0M");
  });
});

// ---------------------------------------------------------------------------
// Regression: total_tokens must include cache tokens (symphony-beads-xtp)
//
// The dashboard Header and kanban header display total tokens. Previously,
// the code computed this as `input_tokens + output_tokens`, which missed
// cache_read and cache_write tokens — often >99% of actual usage.
// The fix uses `total_tokens` from the snapshot, which is the pre-computed
// sum of all token types (input + output + cache_read + cache_write).
// ---------------------------------------------------------------------------
describe("total_tokens regression (symphony-beads-xtp)", () => {
  test("total_tokens includes cache tokens and exceeds input + output", () => {
    // Simulate a realistic snapshot where cache tokens dominate
    const totals = {
      input_tokens: 5,
      output_tokens: 3,
      cache_read_tokens: 6000,
      cache_write_tokens: 310,
      total_tokens: 6318, // = 5 + 3 + 6000 + 310
      total_cost: 0.05,
      seconds_running: 120,
    };

    // The correct total is total_tokens (6318), NOT input + output (8)
    const correctTotal = totals.total_tokens;
    const incorrectTotal = totals.input_tokens + totals.output_tokens;

    expect(correctTotal).toBe(6318);
    expect(incorrectTotal).toBe(8);
    expect(correctTotal).toBeGreaterThan(incorrectTotal);

    // Verify formatTokens renders the correct value
    expect(formatTokens(correctTotal)).toBe("6.3k");
    expect(formatTokens(incorrectTotal)).toBe("8"); // misleadingly low
  });

  test("dashboard.tsx uses total_tokens from snapshot (source code check)", async () => {
    // Read the source to verify the pattern is not regressed
    const source = await Bun.file("src/tui/dashboard.tsx").text();
    // Must use total_tokens, not input_tokens + output_tokens
    expect(source).toContain("snap?.totals?.total_tokens");
    expect(source).not.toMatch(/snap\?\.totals\.input_tokens\s*\+\s*snap\?\.totals\.output_tokens/);
    expect(source).not.toMatch(/totals\.input_tokens\s*\+\s*totals\.output_tokens/);
  });

  test("app.tsx uses total_tokens from snapshot (source code check)", async () => {
    const source = await Bun.file("src/tui/app.tsx").text();
    // Must use total_tokens, not input_tokens + output_tokens
    expect(source).toContain("snapshot.totals.total_tokens");
    expect(source).not.toMatch(/snapshot\.totals\.input_tokens\s*\+\s*snapshot\.totals\.output_tokens/);
  });
});
