export interface KanbanKeyLike {
  name: string;
  sequence: string;
  ctrl: boolean;
  meta: boolean;
  option: boolean;
  shift: boolean;
}

export interface KanbanKeyContext {
  searchMode: boolean;
  searchQuery: string;
}

export interface KanbanKeyHandlers {
  quit: () => void;
  refresh: () => void;
  enterSearchMode: () => void;
  exitSearchMode: () => void;
  clearSearch: () => void;
  searchBackspace: () => void;
  searchAppend: (text: string) => void;
  toggleSort: () => void;
  moveLeft: () => void;
  moveRight: () => void;
  moveUp: () => void;
  moveDown: () => void;
  jumpToTop: () => void;
  jumpToBottom: () => void;
  halfPageUp: () => void;
  halfPageDown: () => void;
  closeIssue: () => void;
  showDetail: () => void;
  moveForward: () => void;
  moveBackward: () => void;
  sendToBacklog: () => void;
  promoteFromBacklog: () => void;
  openPr: () => void;
  copyPr: () => void;
  showCreateGuidance: () => void;
}

function handleSearchModeKey(key: KanbanKeyLike, handlers: KanbanKeyHandlers): boolean {
  switch (key.name) {
    case "escape":
    case "return":
    case "enter":
      handlers.exitSearchMode();
      return true;

    case "backspace":
      handlers.searchBackspace();
      return true;

    default:
      if (!key.ctrl && !key.meta && !key.option && key.sequence.length === 1) {
        handlers.searchAppend(key.sequence);
      }
      return true;
  }
}

export function handleKanbanKey(
  key: KanbanKeyLike,
  context: KanbanKeyContext,
  handlers: KanbanKeyHandlers,
): boolean {
  if (context.searchMode) {
    return handleSearchModeKey(key, handlers);
  }

  switch (key.name) {
    case "q":
      handlers.quit();
      return true;

    case "r":
      handlers.refresh();
      return true;

    case "/":
      handlers.enterSearchMode();
      return true;

    case "escape":
      if (context.searchQuery.trim()) {
        handlers.clearSearch();
      }
      return true;

    case "s":
      handlers.toggleSort();
      return true;

    case "left":
    case "h":
      handlers.moveLeft();
      return true;

    case "right":
    case "l":
      handlers.moveRight();
      return true;

    case "up":
    case "k":
      handlers.moveUp();
      return true;

    case "down":
    case "j":
      handlers.moveDown();
      return true;

    case "g":
      if (key.shift) {
        handlers.jumpToBottom();
      } else {
        handlers.jumpToTop();
      }
      return true;

    case "u":
      if (key.ctrl) {
        handlers.halfPageUp();
      }
      return true;

    case "d":
      if (key.ctrl) {
        handlers.halfPageDown();
      } else {
        handlers.closeIssue();
      }
      return true;

    case "return":
    case "enter":
      handlers.showDetail();
      return true;

    case "m":
      if (key.shift) {
        handlers.moveBackward();
      } else {
        handlers.moveForward();
      }
      return true;

    case "M":
      handlers.moveBackward();
      return true;

    case "b":
      if (key.shift) {
        handlers.promoteFromBacklog();
      } else {
        handlers.sendToBacklog();
      }
      return true;

    case "B":
      handlers.promoteFromBacklog();
      return true;

    case "o":
      handlers.openPr();
      return true;

    case "y":
      handlers.copyPr();
      return true;

    case "n":
      handlers.showCreateGuidance();
      return true;

    default:
      return false;
  }
}
