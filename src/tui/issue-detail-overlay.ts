// ---------------------------------------------------------------------------
// Issue Detail Panel Overlay — OpenTUI component
//
// Displays a modal overlay with full issue details, comments, PR link, and
// agent session info. Esc to close. Uses ScrollBox for long descriptions.
//
// Usage:
//   const overlay = new IssueDetailOverlay(renderer);
//   await overlay.show("symphony-beads-ats");
//   // overlay auto-closes on Esc keypress
// ---------------------------------------------------------------------------

import {
  Box,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  type Renderable,
  ScrollBox,
  Text,
} from "@opentui/core";

import { copyTextToClipboard, openExternalUrl } from "./external-actions.ts";
import {
  fetchIssueComments,
  fetchIssueDetail,
  type IssueComment,
  type IssueDetail,
} from "./issue-data.ts";
import { handleIssueDetailKey } from "./issue-detail-keymap.ts";
import {
  buildComment,
  buildDependency,
  buildDescription,
  buildDivider,
  buildHeader,
  buildMetadata,
  buildPrLink,
  type VChild,
} from "./issue-detail-sections.ts";
import { canOpenPr } from "./pr-link-resolver.ts";

// -- Colors ------------------------------------------------------------------

const COLORS = {
  bg: "#1a1b26",
  bgOverlay: "#000000",
  surface: "#24283b",
  border: "#414868",
  text: "#c0caf5",
  textDim: "#565f89",
  accent: "#7aa2f7",
  green: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
} as const;

const PRIORITY_COLORS: Record<number, string> = {
  0: COLORS.red,
  1: COLORS.yellow,
  2: COLORS.accent,
  3: COLORS.textDim,
  4: COLORS.textDim,
};

const PRIORITY_LABELS: Record<number, string> = {
  0: "P0 Critical",
  1: "P1 High",
  2: "P2 Medium",
  3: "P3 Low",
  4: "P4 Backlog",
};

const STATUS_COLORS: Record<string, string> = {
  open: COLORS.green,
  in_progress: COLORS.cyan,
  review: COLORS.yellow,
  closed: COLORS.textDim,
  done: COLORS.textDim,
};

// -- Overlay -----------------------------------------------------------------

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

  /** Register a callback for when the overlay is closed. */
  onClose(callback: () => void): void {
    this.onCloseCallback = callback;
  }

  /**
   * Show the detail overlay for the given issue ID.
   * @param issueId — The issue identifier to display.
   */
  async show(issueId: string): Promise<void> {
    this.teardown(false);
    const token = ++this.showToken;

    // Install Esc handling immediately so close works even during data fetch.
    this.installKeyHandler();

    const [issue, comments] = await Promise.all([
      fetchIssueDetail(issueId),
      fetchIssueComments(issueId),
    ]);

    // Overlay was closed or superseded while we were fetching.
    if (token !== this.showToken || this.keyHandler === null) {
      return;
    }

    if (!issue) {
      this.renderError(issueId);
      return;
    }

    this.renderDetail(issue, comments);
  }

  /** Close the overlay and clean up. */
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

  // -- Rendering -------------------------------------------------------------

  private renderError(issueId: string): void {
    const overlay = Box(
      {
        id: "issue-detail-overlay",
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        backgroundColor: COLORS.bgOverlay,
        justifyContent: "center",
        alignItems: "center",
        zIndex: 100,
      },
      Box(
        {
          borderStyle: "rounded",
          borderColor: COLORS.red,
          backgroundColor: COLORS.surface,
          padding: 2,
          flexDirection: "column",
          gap: 1,
          width: "50%",
          maxHeight: "50%",
        },
        Text({ content: `Issue not found: ${issueId}`, fg: COLORS.red }),
        Text({ content: "Press Esc to close", fg: COLORS.textDim }),
      ),
    );

    this.renderer.root.add(overlay);
    this.overlayRoot = this.renderer.root.getRenderable("issue-detail-overlay") ?? null;
    this.currentIssue = null;
    this.installKeyHandler();
  }

  private renderDetail(issue: IssueDetail, comments: IssueComment[]): void {
    this.currentIssue = issue;

    const children: VChild[] = [];

    // -- Header: ID + Title --
    children.push(buildHeader(issue, COLORS));

    // -- Metadata row: status, priority, type, owner --
    children.push(buildMetadata(issue, COLORS, STATUS_COLORS, PRIORITY_COLORS, PRIORITY_LABELS));
    children.push(buildDivider(COLORS));

    // -- Description --
    if (issue.description) {
      children.push(Text({ content: " Description", fg: COLORS.accent, attributes: 1 }));
      children.push(buildDescription(issue.description, COLORS));
    }

    // -- PR Link --
    if (issue.pr_url) {
      children.push(buildDivider(COLORS));
      children.push(buildPrLink(issue.pr_url, COLORS));
    }

    // -- Comments --
    if (comments.length > 0) {
      children.push(buildDivider(COLORS));
      children.push(
        Text({
          content: ` Comments (${comments.length})`,
          fg: COLORS.accent,
          attributes: 1,
        }),
      );
      for (const comment of comments) {
        children.push(buildComment(comment, COLORS, formatTimestamp));
      }
    }

    // -- Dependencies --
    if (issue.dependencies.length > 0) {
      children.push(buildDivider(COLORS));
      children.push(
        Text({
          content: ` Dependencies (${issue.dependencies.length})`,
          fg: COLORS.accent,
          attributes: 1,
        }),
      );
      for (const dep of issue.dependencies) {
        children.push(buildDependency(dep, COLORS, STATUS_COLORS));
      }
    }

    const hasPrLink = Boolean(issue.pr_url);
    const footerText = hasPrLink
      ? " Esc close  \u2191\u2193/jk scroll  Ctrl-u/d half-page  g/G top/bottom  o open PR  y copy PR"
      : canOpenPr(issue.status)
        ? " Esc close  \u2191\u2193/jk scroll  Ctrl-u/d half-page  g/G top/bottom  no PR link found"
        : " Esc close  \u2191\u2193/jk scroll  Ctrl-u/d half-page  g/G top/bottom";

    // Filter out nulls
    const validChildren = children.filter((c): c is NonNullable<VChild> => c != null);

    // Build the modal panel inside a full-screen overlay
    const overlay = Box(
      {
        id: "issue-detail-overlay",
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        backgroundColor: COLORS.bgOverlay,
        justifyContent: "center",
        alignItems: "center",
        zIndex: 100,
      },
      Box(
        {
          borderStyle: "rounded",
          border: true,
          borderColor: COLORS.border,
          backgroundColor: COLORS.bg,
          width: "80%",
          height: "85%",
          maxWidth: 100,
          flexDirection: "column",
        },
        ScrollBox(
          {
            id: "issue-detail-scrollbox",
            backgroundColor: COLORS.bg,
            padding: 1,
            paddingX: 2,
            flexGrow: 1,
            stickyStart: "top",
            focusable: true,
            contentOptions: {
              flexDirection: "column",
              gap: 1,
            },
          },
          ...validChildren,
        ),
        Box(
          {
            border: ["top"],
            borderColor: COLORS.bg,
            paddingTop: 1,
            paddingLeft: 2,
            paddingRight: 2,
            paddingBottom: 1,
          },
          Text({ content: footerText, fg: COLORS.textDim, wrapMode: "none" }),
        ),
      ),
    );

    this.renderer.root.add(overlay);
    this.overlayRoot = this.renderer.root.getRenderable("issue-detail-overlay") ?? null;

    // Focus the scroll box so arrow keys work
    const scrollBox =
      (this.renderer.root as Renderable).getRenderable?.("issue-detail-scrollbox") ??
      (this.overlayRoot
        ? (this.overlayRoot as Renderable).getRenderable?.("issue-detail-scrollbox")
        : null);
    if (scrollBox) {
      this.renderer.focusRenderable(scrollBox);
    }

    this.installKeyHandler();
  }

  // -- Key handling ----------------------------------------------------------

  private getDetailScrollbox(): {
    scrollBy?: (
      delta: number | { x: number; y: number },
      unit?: "absolute" | "viewport" | "content" | "step",
    ) => void;
    scrollTo?: (position: number | { x: number; y: number }) => void;
    scrollHeight?: number;
    viewport?: { height: number };
  } | null {
    const byRoot = this.renderer.root?.getRenderable?.("issue-detail-scrollbox");
    const byOverlay = this.overlayRoot?.getRenderable?.("issue-detail-scrollbox");
    const byDescendant = this.overlayRoot?.findDescendantById?.("issue-detail-scrollbox");

    const scrollbox = byRoot ?? byOverlay ?? byDescendant ?? null;

    return (
      (scrollbox as
        | {
            scrollBy?: (
              delta: number | { x: number; y: number },
              unit?: "absolute" | "viewport" | "content" | "step",
            ) => void;
            scrollTo?: (position: number | { x: number; y: number }) => void;
            scrollHeight?: number;
            viewport?: { height: number };
          }
        | null
        | undefined) ?? null
    );
  }

  private scrollDetail(delta: number): void {
    const scrollbox = this.getDetailScrollbox();
    scrollbox?.scrollBy?.(delta, "step");
  }

  private scrollHalfPage(direction: 1 | -1): void {
    const scrollbox = this.getDetailScrollbox();
    if (!scrollbox?.scrollBy) return;

    const viewportHeight = scrollbox.viewport?.height ?? 0;
    const delta = Math.max(1, Math.floor(viewportHeight / 2));
    scrollbox.scrollBy(direction * delta, "step");
  }

  private scrollToTop(): void {
    const scrollbox = this.getDetailScrollbox();
    scrollbox?.scrollTo?.(0);
  }

  private scrollToBottom(): void {
    const scrollbox = this.getDetailScrollbox();
    if (!scrollbox?.scrollTo || !scrollbox.viewport) return;

    const viewportHeight = scrollbox.viewport.height;
    const scrollHeight = scrollbox.scrollHeight ?? 0;
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    scrollbox.scrollTo(maxScrollTop);
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
      const handled = handleIssueDetailKey(key, {
        close: () => {
          this.close();
        },
        halfPageDown: () => {
          this.scrollHalfPage(1);
        },
        halfPageUp: () => {
          this.scrollHalfPage(-1);
        },
        scrollToTop: () => {
          this.scrollToTop();
        },
        scrollToBottom: () => {
          this.scrollToBottom();
        },
        openPr: () => {
          void this.openCurrentIssuePr();
        },
        copyPr: () => {
          void this.copyCurrentIssuePr();
        },
        scrollDown: () => {
          this.scrollDetail(1);
        },
        scrollUp: () => {
          this.scrollDetail(-1);
        },
        pageDown: () => {
          this.scrollDetail(10);
        },
        pageUp: () => {
          this.scrollDetail(-10);
        },
      });

      if (handled) {
        key.preventDefault();
        key.stopPropagation();
      }
    };

    this.renderer.keyInput.on("keypress", this.keyHandler);
  }
}

// -- Utility functions -------------------------------------------------------

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// -- Standalone entry point --------------------------------------------------

/**
 * Show a detail overlay for a single issue and block until Esc is pressed.
 * Useful for testing or standalone usage:
 *   bun run src/tui/issue-detail-overlay.ts <issue-id>
 */
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

// Run standalone if invoked directly
if (import.meta.main) {
  const issueId = process.argv[2];
  if (!issueId) {
    console.error("Usage: bun run src/tui/issue-detail-overlay.ts <issue-id>");
    process.exit(1);
  }
  await showIssueDetail(issueId);
}
