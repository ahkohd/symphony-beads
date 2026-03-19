import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import type { KanbanKeymapActions } from "./keymap.ts";
import { handleKanbanKeyEvent } from "./keymap.ts";

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

function createActions(log: string[]): KanbanKeymapActions {
  return {
    quit: () => log.push("quit"),
    refresh: () => log.push("refresh"),
    setSearchMode: (enabled) => log.push(`search:${enabled}`),
    updateSearchQuery: (_updater) => log.push("search:update"),
    clearSearch: () => log.push("search:clear"),
    setStatusMsg: (message) => log.push(`status:${message}`),
    toggleSort: () => log.push("sort"),
    moveColumnLeft: () => log.push("left"),
    moveColumnRight: () => log.push("right"),
    moveRowUp: () => log.push("up"),
    moveRowDown: () => log.push("down"),
    jumpToTop: () => log.push("top"),
    jumpToBottom: () => log.push("bottom"),
    moveHalfPageUp: () => log.push("half-up"),
    moveHalfPageDown: () => log.push("half-down"),
    closeIssue: () => log.push("close"),
    showDetail: () => log.push("detail"),
    moveForward: () => log.push("forward"),
    moveBackward: () => log.push("backward"),
    deferIssue: () => log.push("defer"),
    promoteIssue: () => log.push("promote"),
    openPr: () => log.push("open-pr"),
    copyPrLink: () => log.push("copy-pr"),
    showCreateGuidance: () => log.push("new"),
  };
}

describe("handleKanbanKeyEvent", () => {
  test("search mode routes character input to query updater", () => {
    const log: string[] = [];

    handleKanbanKeyEvent(
      makeKey("x", { sequence: "x" }),
      {
        overlayActive: false,
        searchMode: true,
        searchQuery: "",
      },
      createActions(log),
    );

    expect(log).toEqual(["search:update"]);
  });

  test("slash enters search mode and clears state", () => {
    const log: string[] = [];

    handleKanbanKeyEvent(
      makeKey("/"),
      {
        overlayActive: false,
        searchMode: false,
        searchQuery: "existing",
      },
      createActions(log),
    );

    expect(log).toEqual(["search:true", "search:clear", "status:"]);
  });

  test("m and M trigger the same move-backward behavior as before", () => {
    const plainLog: string[] = [];
    handleKanbanKeyEvent(
      makeKey("m"),
      { overlayActive: false, searchMode: false, searchQuery: "" },
      createActions(plainLog),
    );
    expect(plainLog).toEqual(["forward"]);

    const shiftedLog: string[] = [];
    handleKanbanKeyEvent(
      makeKey("m", { shift: true }),
      { overlayActive: false, searchMode: false, searchQuery: "" },
      createActions(shiftedLog),
    );
    expect(shiftedLog).toEqual(["backward"]);

    const capitalLog: string[] = [];
    handleKanbanKeyEvent(
      makeKey("M"),
      { overlayActive: false, searchMode: false, searchQuery: "" },
      createActions(capitalLog),
    );
    expect(capitalLog).toEqual(["backward"]);
  });

  test("ctrl-d scrolls half page instead of closing", () => {
    const log: string[] = [];

    handleKanbanKeyEvent(
      makeKey("d", { ctrl: true }),
      { overlayActive: false, searchMode: false, searchQuery: "" },
      createActions(log),
    );

    expect(log).toEqual(["half-down"]);
  });
});
