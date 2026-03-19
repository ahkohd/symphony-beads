import { describe, expect, mock, test } from "bun:test";
import {
  handleIssueDetailKey,
  type IssueDetailKeyHandlers,
  type IssueDetailKeyLike,
} from "./issue-detail-keymap.ts";

type HandlerMockMap = {
  [K in keyof IssueDetailKeyHandlers]: ReturnType<typeof mock<IssueDetailKeyHandlers[K]>>;
};

function makeHandlers(): HandlerMockMap {
  return {
    close: mock(() => {}),
    halfPageDown: mock(() => {}),
    halfPageUp: mock(() => {}),
    scrollToTop: mock(() => {}),
    scrollToBottom: mock(() => {}),
    openPr: mock(() => {}),
    copyPr: mock(() => {}),
    scrollDown: mock(() => {}),
    scrollUp: mock(() => {}),
    pageDown: mock(() => {}),
    pageUp: mock(() => {}),
  };
}

function makeKey(overrides: Partial<IssueDetailKeyLike>): IssueDetailKeyLike {
  return {
    name: "",
    ctrl: false,
    shift: false,
    ...overrides,
  };
}

describe("handleIssueDetailKey", () => {
  test("escape closes overlay", () => {
    const handlers = makeHandlers();
    const handled = handleIssueDetailKey(makeKey({ name: "escape" }), handlers);

    expect(handled).toBe(true);
    expect(handlers.close).toHaveBeenCalledTimes(1);
  });

  test("ctrl-u/d trigger half-page scroll", () => {
    const handlers = makeHandlers();

    const upHandled = handleIssueDetailKey(makeKey({ name: "u", ctrl: true }), handlers);
    const downHandled = handleIssueDetailKey(makeKey({ name: "d", ctrl: true }), handlers);

    expect(upHandled).toBe(true);
    expect(downHandled).toBe(true);
    expect(handlers.halfPageUp).toHaveBeenCalledTimes(1);
    expect(handlers.halfPageDown).toHaveBeenCalledTimes(1);
  });

  test("g/G navigate to top and bottom", () => {
    const handlers = makeHandlers();

    const topHandled = handleIssueDetailKey(makeKey({ name: "g", shift: false }), handlers);
    const bottomHandled = handleIssueDetailKey(makeKey({ name: "g", shift: true }), handlers);

    expect(topHandled).toBe(true);
    expect(bottomHandled).toBe(true);
    expect(handlers.scrollToTop).toHaveBeenCalledTimes(1);
    expect(handlers.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  test("o/y trigger PR actions", () => {
    const handlers = makeHandlers();

    handleIssueDetailKey(makeKey({ name: "o" }), handlers);
    handleIssueDetailKey(makeKey({ name: "y" }), handlers);

    expect(handlers.openPr).toHaveBeenCalledTimes(1);
    expect(handlers.copyPr).toHaveBeenCalledTimes(1);
  });

  test("j/k and arrows map to line scroll", () => {
    const handlers = makeHandlers();

    handleIssueDetailKey(makeKey({ name: "j" }), handlers);
    handleIssueDetailKey(makeKey({ name: "down" }), handlers);
    handleIssueDetailKey(makeKey({ name: "k" }), handlers);
    handleIssueDetailKey(makeKey({ name: "up" }), handlers);

    expect(handlers.scrollDown).toHaveBeenCalledTimes(2);
    expect(handlers.scrollUp).toHaveBeenCalledTimes(2);
  });

  test("pageup/pagedown map to larger scroll", () => {
    const handlers = makeHandlers();

    handleIssueDetailKey(makeKey({ name: "pageup" }), handlers);
    handleIssueDetailKey(makeKey({ name: "pagedown" }), handlers);

    expect(handlers.pageUp).toHaveBeenCalledTimes(1);
    expect(handlers.pageDown).toHaveBeenCalledTimes(1);
  });

  test("unknown key is ignored", () => {
    const handlers = makeHandlers();
    const handled = handleIssueDetailKey(makeKey({ name: "z" }), handlers);

    expect(handled).toBe(false);
    expect(handlers.close).toHaveBeenCalledTimes(0);
  });
});
