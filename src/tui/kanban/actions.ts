import type { CliRenderer } from "@opentui/core";
import { canOpenPr, copyTextToClipboard, openExternalUrl } from "../external-actions.ts";
import { fetchIssueDetail } from "../issue-data.ts";
import { IssueDetailOverlay } from "../issue-detail-overlay.ts";
import { NewIssueDialog } from "../new-issue-dialog.ts";
import { STATUS_ORDER } from "./constants.ts";
import { closeIssue, moveIssueStatus } from "./data.ts";
import type { Issue } from "./types.ts";

interface CreateKanbanIssueActionsOptions {
  renderer: CliRenderer;
  overlayRef: { current: boolean };
  getSelectedIssue: () => Issue | null;
  refresh: () => Promise<void>;
  setStatusMsg: (message: string) => void;
}

export interface KanbanIssueActions {
  moveForward: () => Promise<void>;
  moveBackward: () => Promise<void>;
  closeSelectedIssue: () => Promise<void>;
  sendToBacklog: () => Promise<void>;
  promoteFromBacklog: () => Promise<void>;
  showDetail: () => Promise<void>;
  openPr: () => Promise<void>;
  copyPrLink: () => Promise<void>;
  showCreateGuidance: () => void;
}

export function createKanbanIssueActions({
  renderer,
  overlayRef,
  getSelectedIssue,
  refresh,
  setStatusMsg,
}: CreateKanbanIssueActionsOptions): KanbanIssueActions {
  const moveForward = async (): Promise<void> => {
    const issue = getSelectedIssue();
    if (!issue) return;

    const currentIndex = STATUS_ORDER.indexOf(issue.status);
    if (currentIndex < 0 || currentIndex >= STATUS_ORDER.length - 1) {
      setStatusMsg("already at last status");
      return;
    }

    const nextStatus = STATUS_ORDER[currentIndex + 1];
    if (!nextStatus) return;

    setStatusMsg(`moving ${issue.id} to ${nextStatus}…`);
    const moved = await moveIssueStatus(issue.id, nextStatus);
    if (moved) {
      setStatusMsg(`moved ${issue.id} to ${nextStatus}`);
      await refresh();
      return;
    }

    setStatusMsg(`failed to move ${issue.id}`);
  };

  const moveBackward = async (): Promise<void> => {
    const issue = getSelectedIssue();
    if (!issue) return;

    const currentIndex = STATUS_ORDER.indexOf(issue.status);
    if (currentIndex <= 0) {
      setStatusMsg("already at first status");
      return;
    }

    const previousStatus = STATUS_ORDER[currentIndex - 1];
    if (!previousStatus) return;

    setStatusMsg(`moving ${issue.id} to ${previousStatus}…`);
    const moved = await moveIssueStatus(issue.id, previousStatus);
    if (moved) {
      setStatusMsg(`moved ${issue.id} to ${previousStatus}`);
      await refresh();
      return;
    }

    setStatusMsg(`failed to move ${issue.id}`);
  };

  const closeSelectedIssue = async (): Promise<void> => {
    const issue = getSelectedIssue();
    if (!issue) return;

    setStatusMsg(`closing ${issue.id}…`);
    const closed = await closeIssue(issue.id);
    if (closed) {
      setStatusMsg(`closed ${issue.id}`);
      await refresh();
      return;
    }

    setStatusMsg(`failed to close ${issue.id}`);
  };

  const sendToBacklog = async (): Promise<void> => {
    const issue = getSelectedIssue();
    if (!issue) return;

    if (issue.status === "deferred") {
      setStatusMsg(`${issue.id} is already deferred`);
      return;
    }

    setStatusMsg(`deferring ${issue.id}…`);
    const deferred = await moveIssueStatus(issue.id, "deferred");
    if (deferred) {
      setStatusMsg(`deferred ${issue.id}`);
      await refresh();
      return;
    }

    setStatusMsg(`failed to defer ${issue.id}`);
  };

  const promoteFromBacklog = async (): Promise<void> => {
    const issue = getSelectedIssue();
    if (!issue) return;

    if (issue.status !== "deferred") {
      setStatusMsg(`${issue.id} is not deferred`);
      return;
    }

    setStatusMsg(`promoting ${issue.id} to open…`);
    const promoted = await moveIssueStatus(issue.id, "open");
    if (promoted) {
      setStatusMsg(`promoted ${issue.id} to open`);
      await refresh();
      return;
    }

    setStatusMsg(`failed to promote ${issue.id}`);
  };

  const showDetail = async (): Promise<void> => {
    const issue = getSelectedIssue();
    if (!issue) return;

    overlayRef.current = true;
    const overlay = new IssueDetailOverlay(renderer);
    overlay.onClose(() => {
      overlayRef.current = false;
    });
    await overlay.show(issue.id);
  };

  const openPr = async (): Promise<void> => {
    const issue = getSelectedIssue();
    if (!issue) return;

    if (!canOpenPr(issue.status)) {
      setStatusMsg("PR open is available in review/closed");
      return;
    }

    setStatusMsg(`loading PR for ${issue.id}…`);
    const detail = await fetchIssueDetail(issue.id);
    const prUrl = detail?.pr_url;

    if (!prUrl) {
      setStatusMsg(`no PR found for ${issue.id}`);
      return;
    }

    setStatusMsg(`opening PR for ${issue.id}…`);
    const opened = await openExternalUrl(prUrl);
    setStatusMsg(opened ? `opened PR for ${issue.id}` : `failed to open PR for ${issue.id}`);
  };

  const copyPrLink = async (): Promise<void> => {
    const issue = getSelectedIssue();
    if (!issue) return;

    if (!canOpenPr(issue.status)) {
      setStatusMsg("PR copy is available in review/closed");
      return;
    }

    setStatusMsg(`loading PR for ${issue.id}…`);
    const detail = await fetchIssueDetail(issue.id);
    const prUrl = detail?.pr_url;

    if (!prUrl) {
      setStatusMsg(`no PR found for ${issue.id}`);
      return;
    }

    setStatusMsg(`copying PR for ${issue.id}…`);
    const copied = await copyTextToClipboard(prUrl);
    setStatusMsg(copied ? `copied PR for ${issue.id}` : `failed to copy PR for ${issue.id}`);
  };

  const showCreateGuidance = (): void => {
    overlayRef.current = true;
    const dialog = new NewIssueDialog(renderer);
    dialog.onClose(() => {
      overlayRef.current = false;
    });
    dialog.show();
  };

  return {
    moveForward,
    moveBackward,
    closeSelectedIssue,
    sendToBacklog,
    promoteFromBacklog,
    showDetail,
    openPr,
    copyPrLink,
    showCreateGuidance,
  };
}
