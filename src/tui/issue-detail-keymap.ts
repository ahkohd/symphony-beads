export interface IssueDetailKeyLike {
  name: string;
  ctrl: boolean;
  shift: boolean;
}

export interface IssueDetailKeyHandlers {
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

export function handleIssueDetailKey(
  key: IssueDetailKeyLike,
  handlers: IssueDetailKeyHandlers,
): boolean {
  if (key.name === "escape") {
    handlers.close();
    return true;
  }

  if (key.ctrl && key.name === "d") {
    handlers.halfPageDown();
    return true;
  }

  if (key.ctrl && key.name === "u") {
    handlers.halfPageUp();
    return true;
  }

  if (key.name === "g") {
    if (key.shift) {
      handlers.scrollToBottom();
    } else {
      handlers.scrollToTop();
    }
    return true;
  }

  if (key.name === "o") {
    handlers.openPr();
    return true;
  }

  if (key.name === "y") {
    handlers.copyPr();
    return true;
  }

  if (key.name === "j" || key.name === "down") {
    handlers.scrollDown();
    return true;
  }

  if (key.name === "k" || key.name === "up") {
    handlers.scrollUp();
    return true;
  }

  if (key.name === "pagedown") {
    handlers.pageDown();
    return true;
  }

  if (key.name === "pageup") {
    handlers.pageUp();
    return true;
  }

  return false;
}
