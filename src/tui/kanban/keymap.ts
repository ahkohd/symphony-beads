import type { KeyEvent } from "@opentui/core";

export interface KanbanKeymapState {
  overlayActive: boolean;
  searchMode: boolean;
  searchQuery: string;
}

export interface KanbanKeymapActions {
  quit: () => void;
  refresh: () => void;
  setSearchMode: (enabled: boolean) => void;
  updateSearchQuery: (updater: (previous: string) => string) => void;
  clearSearch: () => void;
  setStatusMsg: (message: string) => void;
  toggleSort: () => void;
  moveColumnLeft: () => void;
  moveColumnRight: () => void;
  moveRowUp: () => void;
  moveRowDown: () => void;
  jumpToTop: () => void;
  jumpToBottom: () => void;
  moveHalfPageUp: () => void;
  moveHalfPageDown: () => void;
  closeIssue: () => void;
  showDetail: () => void;
  moveForward: () => void;
  moveBackward: () => void;
  deferIssue: () => void;
  promoteIssue: () => void;
  openPr: () => void;
  copyPrLink: () => void;
  showCreateGuidance: () => void;
}

function handleSearchModeKey(key: KeyEvent, actions: KanbanKeymapActions): boolean {
  switch (key.name) {
    case "escape":
    case "return":
    case "enter":
      actions.setSearchMode(false);
      return true;

    case "backspace":
      actions.updateSearchQuery((previous) => previous.slice(0, -1));
      return true;

    default:
      if (key.ctrl || key.meta || key.option) {
        return true;
      }

      if (key.sequence.length === 1) {
        actions.updateSearchQuery((previous) => `${previous}${key.sequence}`);
      }

      return true;
  }
}

export function handleKanbanKeyEvent(
  key: KeyEvent,
  state: KanbanKeymapState,
  actions: KanbanKeymapActions,
): void {
  if (state.overlayActive) {
    return;
  }

  if (state.searchMode) {
    handleSearchModeKey(key, actions);
    return;
  }

  switch (key.name) {
    case "q":
      actions.quit();
      break;

    case "r":
      actions.setStatusMsg("refreshing…");
      actions.refresh();
      break;

    case "/":
      actions.setSearchMode(true);
      actions.clearSearch();
      actions.setStatusMsg("");
      break;

    case "escape":
      if (state.searchQuery.trim()) {
        actions.clearSearch();
        actions.setStatusMsg("search cleared");
      }
      break;

    case "s":
      actions.toggleSort();
      break;

    case "left":
    case "h":
      actions.moveColumnLeft();
      break;

    case "right":
    case "l":
      actions.moveColumnRight();
      break;

    case "up":
    case "k":
      actions.moveRowUp();
      break;

    case "down":
    case "j":
      actions.moveRowDown();
      break;

    case "g":
      if (key.shift) {
        actions.jumpToBottom();
      } else {
        actions.jumpToTop();
      }
      break;

    case "u":
      if (key.ctrl) {
        actions.moveHalfPageUp();
      }
      break;

    case "d":
      if (key.ctrl) {
        actions.moveHalfPageDown();
      } else {
        actions.closeIssue();
      }
      break;

    case "return":
    case "enter":
      actions.showDetail();
      break;

    case "m":
      if (key.shift) {
        actions.moveBackward();
      } else {
        actions.moveForward();
      }
      break;

    case "M":
      actions.moveBackward();
      break;

    case "b":
      if (key.shift) {
        actions.promoteIssue();
      } else {
        actions.deferIssue();
      }
      break;

    case "B":
      actions.promoteIssue();
      break;

    case "o":
      actions.openPr();
      break;

    case "y":
      actions.copyPrLink();
      break;

    case "n":
      actions.showCreateGuidance();
      break;
  }
}
