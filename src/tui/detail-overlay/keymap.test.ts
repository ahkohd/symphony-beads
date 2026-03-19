import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { IssueDetailKeyActions } from "./keymap.ts";
import { handleIssueDetailKeyEvent } from "./keymap.ts";

function makeKey(name: string, overrides?: Partial<KeyEvent>): KeyEvent {
  return {
    name,
    sequence: name.length === 1 ? name : "",
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    preventDefault() {},
    stopPropagation() {},
    ...overrides,
  } as KeyEvent;
}

function actions(log: string[]): IssueDetailKeyActions {
  return {
    close: () => log.push("close"),
    halfPageDown: () => log.push("half-down"),
    halfPageUp: () => log.push("half-up"),
    scrollToTop: () => log.push("top"),
    scrollToBottom: () => log.push("bottom"),
    openPr: () => log.push("open-pr"),
    copyPr: () => log.push("copy-pr"),
    scrollDown: () => log.push("down"),
    scrollUp: () => log.push("up"),
    pageDown: () => log.push("pagedown"),
    pageUp: () => log.push("pageup"),
  };
}

describe("handleIssueDetailKeyEvent", () => {
  test("escape closes the overlay", () => {
    const log: string[] = [];
    handleIssueDetailKeyEvent(makeKey("escape"), actions(log));
    expect(log).toEqual(["close"]);
  });

  test("g/G keep top/bottom semantics", () => {
    const topLog: string[] = [];
    handleIssueDetailKeyEvent(makeKey("g"), actions(topLog));
    expect(topLog).toEqual(["top"]);

    const bottomLog: string[] = [];
    handleIssueDetailKeyEvent(makeKey("g", { shift: true }), actions(bottomLog));
    expect(bottomLog).toEqual(["bottom"]);
  });

  test("ctrl-u and ctrl-d map to half-page scroll", () => {
    const downLog: string[] = [];
    handleIssueDetailKeyEvent(makeKey("d", { ctrl: true }), actions(downLog));
    expect(downLog).toEqual(["half-down"]);

    const upLog: string[] = [];
    handleIssueDetailKeyEvent(makeKey("u", { ctrl: true }), actions(upLog));
    expect(upLog).toEqual(["half-up"]);
  });
});
