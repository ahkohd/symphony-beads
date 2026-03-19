import { describe, expect, mock, test } from "bun:test";
import {
  handleKanbanKey,
  type KanbanKeyContext,
  type KanbanKeyHandlers,
  type KanbanKeyLike,
} from "./kanban-keymap.ts";

type HandlerMockMap = {
  [K in keyof KanbanKeyHandlers]: ReturnType<typeof mock<KanbanKeyHandlers[K]>>;
};

function makeHandlers(): HandlerMockMap {
  return {
    quit: mock(() => {}),
    refresh: mock(() => {}),
    enterSearchMode: mock(() => {}),
    exitSearchMode: mock(() => {}),
    clearSearch: mock(() => {}),
    searchBackspace: mock(() => {}),
    searchAppend: mock((_text: string) => {}),
    toggleSort: mock(() => {}),
    moveLeft: mock(() => {}),
    moveRight: mock(() => {}),
    moveUp: mock(() => {}),
    moveDown: mock(() => {}),
    jumpToTop: mock(() => {}),
    jumpToBottom: mock(() => {}),
    halfPageUp: mock(() => {}),
    halfPageDown: mock(() => {}),
    closeIssue: mock(() => {}),
    showDetail: mock(() => {}),
    moveForward: mock(() => {}),
    moveBackward: mock(() => {}),
    sendToBacklog: mock(() => {}),
    promoteFromBacklog: mock(() => {}),
    openPr: mock(() => {}),
    copyPr: mock(() => {}),
    showCreateGuidance: mock(() => {}),
  };
}

function makeKey(overrides: Partial<KanbanKeyLike>): KanbanKeyLike {
  return {
    name: "",
    sequence: "",
    ctrl: false,
    meta: false,
    option: false,
    shift: false,
    ...overrides,
  };
}

const normalContext: KanbanKeyContext = {
  searchMode: false,
  searchQuery: "",
};

describe("handleKanbanKey search mode", () => {
  test("escape exits search mode", () => {
    const handlers = makeHandlers();
    const handled = handleKanbanKey(
      makeKey({ name: "escape", sequence: "\u001b" }),
      { searchMode: true, searchQuery: "abc" },
      handlers,
    );

    expect(handled).toBe(true);
    expect(handlers.exitSearchMode).toHaveBeenCalledTimes(1);
  });

  test("backspace updates search text", () => {
    const handlers = makeHandlers();
    const handled = handleKanbanKey(
      makeKey({ name: "backspace", sequence: "\b" }),
      { searchMode: true, searchQuery: "abc" },
      handlers,
    );

    expect(handled).toBe(true);
    expect(handlers.searchBackspace).toHaveBeenCalledTimes(1);
  });

  test("search mode appends plain characters", () => {
    const handlers = makeHandlers();
    const handled = handleKanbanKey(
      makeKey({ name: "a", sequence: "a" }),
      { searchMode: true, searchQuery: "" },
      handlers,
    );

    expect(handled).toBe(true);
    expect(handlers.searchAppend).toHaveBeenCalledWith("a");
  });

  test("search mode ignores modified characters", () => {
    const handlers = makeHandlers();
    const handled = handleKanbanKey(
      makeKey({ name: "a", sequence: "a", ctrl: true }),
      { searchMode: true, searchQuery: "" },
      handlers,
    );

    expect(handled).toBe(true);
    expect(handlers.searchAppend).toHaveBeenCalledTimes(0);
  });
});

describe("handleKanbanKey main mode", () => {
  test("q triggers quit", () => {
    const handlers = makeHandlers();
    const handled = handleKanbanKey(makeKey({ name: "q", sequence: "q" }), normalContext, handlers);

    expect(handled).toBe(true);
    expect(handlers.quit).toHaveBeenCalledTimes(1);
  });

  test("/ enters search mode", () => {
    const handlers = makeHandlers();
    const handled = handleKanbanKey(makeKey({ name: "/", sequence: "/" }), normalContext, handlers);

    expect(handled).toBe(true);
    expect(handlers.enterSearchMode).toHaveBeenCalledTimes(1);
  });

  test("escape clears active search query", () => {
    const handlers = makeHandlers();
    const handled = handleKanbanKey(
      makeKey({ name: "escape", sequence: "\u001b" }),
      { searchMode: false, searchQuery: "abc" },
      handlers,
    );

    expect(handled).toBe(true);
    expect(handlers.clearSearch).toHaveBeenCalledTimes(1);
  });

  test("g and G map to top/bottom navigation", () => {
    const handlers = makeHandlers();

    const topHandled = handleKanbanKey(
      makeKey({ name: "g", sequence: "g", shift: false }),
      normalContext,
      handlers,
    );
    const bottomHandled = handleKanbanKey(
      makeKey({ name: "g", sequence: "G", shift: true }),
      normalContext,
      handlers,
    );

    expect(topHandled).toBe(true);
    expect(bottomHandled).toBe(true);
    expect(handlers.jumpToTop).toHaveBeenCalledTimes(1);
    expect(handlers.jumpToBottom).toHaveBeenCalledTimes(1);
  });

  test("ctrl-u triggers half page up", () => {
    const handlers = makeHandlers();
    const handled = handleKanbanKey(
      makeKey({ name: "u", sequence: "\u0015", ctrl: true }),
      normalContext,
      handlers,
    );

    expect(handled).toBe(true);
    expect(handlers.halfPageUp).toHaveBeenCalledTimes(1);
  });

  test("d triggers close, ctrl-d triggers half page down", () => {
    const handlers = makeHandlers();

    const closeHandled = handleKanbanKey(
      makeKey({ name: "d", sequence: "d" }),
      normalContext,
      handlers,
    );
    const halfPageHandled = handleKanbanKey(
      makeKey({ name: "d", sequence: "\u0004", ctrl: true }),
      normalContext,
      handlers,
    );

    expect(closeHandled).toBe(true);
    expect(halfPageHandled).toBe(true);
    expect(handlers.closeIssue).toHaveBeenCalledTimes(1);
    expect(handlers.halfPageDown).toHaveBeenCalledTimes(1);
  });

  test("m/M and b/B preserve shifted behavior", () => {
    const handlers = makeHandlers();

    handleKanbanKey(makeKey({ name: "m", sequence: "m" }), normalContext, handlers);
    handleKanbanKey(makeKey({ name: "m", sequence: "M", shift: true }), normalContext, handlers);
    handleKanbanKey(makeKey({ name: "M", sequence: "M" }), normalContext, handlers);

    handleKanbanKey(makeKey({ name: "b", sequence: "b" }), normalContext, handlers);
    handleKanbanKey(makeKey({ name: "b", sequence: "B", shift: true }), normalContext, handlers);
    handleKanbanKey(makeKey({ name: "B", sequence: "B" }), normalContext, handlers);

    expect(handlers.moveForward).toHaveBeenCalledTimes(1);
    expect(handlers.moveBackward).toHaveBeenCalledTimes(2);
    expect(handlers.sendToBacklog).toHaveBeenCalledTimes(1);
    expect(handlers.promoteFromBacklog).toHaveBeenCalledTimes(2);
  });

  test("unknown keys are not handled", () => {
    const handlers = makeHandlers();
    const handled = handleKanbanKey(makeKey({ name: "z", sequence: "z" }), normalContext, handlers);

    expect(handled).toBe(false);
    expect(handlers.refresh).toHaveBeenCalledTimes(0);
  });
});
