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
