// ---------------------------------------------------------------------------
// Issue Detail Panel Overlay — OpenTUI component
// ---------------------------------------------------------------------------

import { type CliRenderer, createCliRenderer, type KeyEvent, type Renderable } from "@opentui/core";
import { handleIssueDetailKeyEvent } from "./detail-overlay/keymap.ts";
import { createIssueDetailOverlay, createIssueNotFoundOverlay } from "./detail-overlay/render.ts";
import {
  getDetailScrollbox,
  scrollDetail,
  scrollHalfPage,
  scrollToBottom,
  scrollToTop,
} from "./detail-overlay/scroll.ts";
import { canOpenPr, copyTextToClipboard, openExternalUrl } from "./external-actions.ts";
import { fetchIssueComments, fetchIssueDetail, type IssueDetail } from "./issue-data.ts";

export class IssueDetailOverlay {
  private renderer: CliRenderer;
  private overlayRoot: Renderable | null = null;
  private keyHandler: ((key: KeyEvent) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;
  private showToken = 0;
  private currentIssue: IssueDetail | null = null;
  private openingPr = false;
  private copyingPr = false;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
  }

  onClose(callback: () => void): void {
    this.onCloseCallback = callback;
  }

  async show(issueId: string): Promise<void> {
    this.teardown(false);
    const token = ++this.showToken;

    this.installKeyHandler();

    const [issue, comments] = await Promise.all([
      fetchIssueDetail(issueId),
      fetchIssueComments(issueId),
    ]);

    if (token !== this.showToken || this.keyHandler === null) {
      return;
    }

    if (!issue) {
      this.renderError(issueId);
      return;
    }

    this.renderDetail(issue, comments);
  }

  close(): void {
    this.showToken += 1;
    this.teardown(true);
  }

  get isVisible(): boolean {
    return this.overlayRoot !== null;
  }

  private teardown(notifyClose: boolean): void {
    const wasVisible = this.overlayRoot !== null || this.keyHandler !== null;

    if (this.keyHandler) {
      this.renderer.keyInput.off("keypress", this.keyHandler);
      this.keyHandler = null;
    }

    if (this.overlayRoot) {
      this.renderer.root.remove(this.overlayRoot.id);
      this.overlayRoot = null;
    }

    this.currentIssue = null;
    this.openingPr = false;
    this.copyingPr = false;

    if (notifyClose && wasVisible) {
      this.onCloseCallback?.();
    }
  }

  private renderError(issueId: string): void {
    const overlay = createIssueNotFoundOverlay(issueId);
    this.renderer.root.add(overlay);
    this.overlayRoot = this.renderer.root.getRenderable("issue-detail-overlay") ?? null;
    this.currentIssue = null;
    this.installKeyHandler();
  }

  private renderDetail(
    issue: IssueDetail,
    comments: Awaited<ReturnType<typeof fetchIssueComments>>,
  ): void {
    this.currentIssue = issue;

    const overlay = createIssueDetailOverlay(issue, comments);
    this.renderer.root.add(overlay);
    this.overlayRoot = this.renderer.root.getRenderable("issue-detail-overlay") ?? null;

    const scrollBox =
      (this.renderer.root as Renderable).getRenderable?.("issue-detail-scrollbox") ??
      this.overlayRoot?.getRenderable?.("issue-detail-scrollbox") ??
      null;

    if (scrollBox) {
      this.renderer.focusRenderable(scrollBox);
    }

    this.installKeyHandler();
  }

  private getScrollbox() {
    return getDetailScrollbox(this.renderer.root as Renderable, this.overlayRoot);
  }

  private async openCurrentIssuePr(): Promise<void> {
    const issue = this.currentIssue;
    if (!issue || this.openingPr) return;
    if (!canOpenPr(issue.status) || !issue.pr_url) return;

    this.openingPr = true;
    try {
      await openExternalUrl(issue.pr_url);
    } finally {
      this.openingPr = false;
    }
  }

  private async copyCurrentIssuePr(): Promise<void> {
    const issue = this.currentIssue;
    if (!issue || this.copyingPr) return;
    if (!canOpenPr(issue.status) || !issue.pr_url) return;

    this.copyingPr = true;
    try {
      await copyTextToClipboard(issue.pr_url);
    } finally {
      this.copyingPr = false;
    }
  }

  private installKeyHandler(): void {
    if (this.keyHandler) {
      this.renderer.keyInput.off("keypress", this.keyHandler);
    }

    this.keyHandler = (key: KeyEvent) => {
      handleIssueDetailKeyEvent(key, {
        close: () => this.close(),
        halfPageDown: () => scrollHalfPage(this.getScrollbox(), 1),
        halfPageUp: () => scrollHalfPage(this.getScrollbox(), -1),
        scrollToTop: () => scrollToTop(this.getScrollbox()),
        scrollToBottom: () => scrollToBottom(this.getScrollbox()),
        openPr: () => {
          void this.openCurrentIssuePr();
        },
        copyPr: () => {
          void this.copyCurrentIssuePr();
        },
        scrollDown: () => scrollDetail(this.getScrollbox(), 1),
        scrollUp: () => scrollDetail(this.getScrollbox(), -1),
        pageDown: () => scrollDetail(this.getScrollbox(), 10),
        pageUp: () => scrollDetail(this.getScrollbox(), -10),
      });
    };

    this.renderer.keyInput.on("keypress", this.keyHandler);
  }
}

export async function showIssueDetail(issueId: string): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: true,
  });

  const overlay = new IssueDetailOverlay(renderer);

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      renderer.destroy();
      resolve();
    };

    overlay.onClose(finish);

    void overlay.show(issueId).then(() => {
      if (!overlay.isVisible) {
        finish();
      }
    });
  });
}

if (import.meta.main) {
  const issueId = process.argv[2];
  if (!issueId) {
    console.error("Usage: bun run src/tui/issue-detail-overlay.ts <issue-id>");
    process.exit(1);
  }

  await showIssueDetail(issueId);
}
