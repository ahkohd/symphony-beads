import type { KeyEvent } from "@opentui/core";

export interface IssueDetailKeyActions {
  close: () => void;
  halfPageDown: () => void;
  halfPageUp: () => void;
  scrollToTop: () => void;
  scrollToBottom: () => void;
  openPr: () => void;
  copyPr: () => void;
  scrollDown: () => void;
  scrollUp: () => void;
  pageDown: () => void;
  pageUp: () => void;
}

function consumeKey(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

export function handleIssueDetailKeyEvent(key: KeyEvent, actions: IssueDetailKeyActions): void {
  if (key.name === "escape") {
    consumeKey(key);
    actions.close();
    return;
  }

  if (key.ctrl && key.name === "d") {
    consumeKey(key);
    actions.halfPageDown();
    return;
  }

  if (key.ctrl && key.name === "u") {
    consumeKey(key);
    actions.halfPageUp();
    return;
  }

  if (key.name === "g") {
    consumeKey(key);
    if (key.shift) {
      actions.scrollToBottom();
    } else {
      actions.scrollToTop();
    }
    return;
  }

  if (key.name === "o") {
    consumeKey(key);
    actions.openPr();
    return;
  }

  if (key.name === "y") {
    consumeKey(key);
    actions.copyPr();
    return;
  }

  if (key.name === "j" || key.name === "down") {
    consumeKey(key);
    actions.scrollDown();
    return;
  }

  if (key.name === "k" || key.name === "up") {
    consumeKey(key);
    actions.scrollUp();
    return;
  }

  if (key.name === "pagedown") {
    consumeKey(key);
    actions.pageDown();
    return;
  }

  if (key.name === "pageup") {
    consumeKey(key);
    actions.pageUp();
  }
}
