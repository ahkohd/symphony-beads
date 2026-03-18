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

import {
  fetchIssueComments,
  fetchIssueDetail,
  type IssueComment,
  type IssueDetail,
} from "./issue-data.ts";

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

// -- Types for VNode children ------------------------------------------------
type VChild = ReturnType<typeof Box> | ReturnType<typeof Text> | null;

// -- Overlay -----------------------------------------------------------------

export class IssueDetailOverlay {
  private renderer: CliRenderer;
  private overlayRoot: Renderable | null = null;
  private keyHandler: ((key: KeyEvent) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;
  private showToken = 0;

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
    this.installKeyHandler();
  }

  private renderDetail(issue: IssueDetail, comments: IssueComment[]): void {
    const children: VChild[] = [];

    // -- Header: ID + Title --
    children.push(this.buildHeader(issue));

    // -- Metadata row: status, priority, type, owner --
    children.push(this.buildMetadata(issue));
    children.push(this.buildDivider());

    // -- Description --
    if (issue.description) {
      children.push(Text({ content: " Description", fg: COLORS.accent, attributes: 1 }));
      children.push(this.buildDescription(issue.description));
    }

    // -- PR Link --
    if (issue.pr_url) {
      children.push(this.buildDivider());
      children.push(this.buildPrLink(issue.pr_url));
    }

    // -- Comments --
    if (comments.length > 0) {
      children.push(this.buildDivider());
      children.push(
        Text({
          content: ` Comments (${comments.length})`,
          fg: COLORS.accent,
          attributes: 1,
        }),
      );
      for (const comment of comments) {
        children.push(this.buildComment(comment));
      }
    }

    // -- Dependencies --
    if (issue.dependencies.length > 0) {
      children.push(this.buildDivider());
      children.push(
        Text({
          content: ` Dependencies (${issue.dependencies.length})`,
          fg: COLORS.accent,
          attributes: 1,
        }),
      );
      for (const dep of issue.dependencies) {
        children.push(this.buildDependency(dep));
      }
    }

    // -- Footer --
    children.push(this.buildDivider());
    children.push(
      Text({
        content: " Esc close  \u2191\u2193/jk scroll  Ctrl-u/d half-page",
        fg: COLORS.textDim,
      }),
    );

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
      ScrollBox(
        {
          id: "issue-detail-scrollbox",
          borderStyle: "rounded",
          border: true,
          borderColor: COLORS.border,
          backgroundColor: COLORS.bg,
          padding: 1,
          paddingX: 2,
          width: "80%",
          height: "85%",
          maxWidth: 100,
          stickyStart: "top",
          focusable: true,
          contentOptions: {
            flexDirection: "column",
            gap: 1,
          },
        },
        ...validChildren,
      ),
    );

    this.renderer.root.add(overlay);
    this.overlayRoot = this.renderer.root.getRenderable("issue-detail-overlay") ?? null;

    // Focus the scroll box so arrow keys work
    const scrollBox = this.overlayRoot
      ? (this.overlayRoot as Renderable).getRenderable?.("issue-detail-scrollbox")
      : null;
    if (scrollBox) {
      this.renderer.focusRenderable(scrollBox);
    }

    this.installKeyHandler();
  }

  private buildHeader(issue: IssueDetail): VChild {
    return Box(
      { flexDirection: "column", gap: 0 },
      Text({ content: ` ${issue.id}`, fg: COLORS.textDim }),
      Text({ content: ` ${issue.title}`, fg: COLORS.text, attributes: 1 }),
    );
  }

  private buildMetadata(issue: IssueDetail): VChild {
    const statusColor = STATUS_COLORS[issue.status] ?? COLORS.text;
    const priorityColor =
      issue.priority !== null ? (PRIORITY_COLORS[issue.priority] ?? COLORS.text) : COLORS.textDim;
    const priorityLabel =
      issue.priority !== null
        ? (PRIORITY_LABELS[issue.priority] ?? `P${issue.priority}`)
        : "\u2014";

    return Box(
      { flexDirection: "row", gap: 2, paddingLeft: 1 },
      Box(
        { flexDirection: "row", gap: 1 },
        Text({ content: "\u25CF", fg: statusColor }),
        Text({ content: issue.status, fg: statusColor }),
      ),
      Text({ content: priorityLabel, fg: priorityColor }),
      Text({ content: issue.issue_type, fg: COLORS.magenta }),
      issue.owner ? Text({ content: issue.owner, fg: COLORS.textDim }) : Text({ content: "" }),
    );
  }

  private buildDescription(description: string): VChild {
    return Box(
      { paddingLeft: 1, paddingRight: 1, flexDirection: "column" },
      Text({ content: description, fg: COLORS.text, wrapMode: "word" }),
    );
  }

  private buildDivider(): VChild {
    return Text({
      content: "\u2500".repeat(300),
      fg: COLORS.border,
      wrapMode: "none",
    });
  }

  private buildPrLink(url: string): VChild {
    return Box(
      { flexDirection: "row", gap: 1, paddingLeft: 1 },
      Text({ content: " PR:", fg: COLORS.accent, attributes: 1 }),
      Text({ content: url, fg: COLORS.cyan }),
    );
  }

  private buildComment(comment: IssueComment): VChild {
    const timestamp = comment.created_at ? formatTimestamp(comment.created_at) : "";

    return Box(
      { flexDirection: "column", gap: 0, paddingLeft: 1, paddingBottom: 1 },
      Box(
        { flexDirection: "row", gap: 1 },
        Text({ content: comment.author, fg: COLORS.cyan, attributes: 1 }),
        Text({ content: timestamp, fg: COLORS.textDim }),
      ),
      Box({ paddingLeft: 1 }, Text({ content: comment.body, fg: COLORS.text, wrapMode: "word" })),
    );
  }

  private buildDependency(dep: {
    id: string;
    title: string;
    status: string;
    dependency_type: string;
  }): VChild {
    const statusColor = STATUS_COLORS[dep.status] ?? COLORS.textDim;
    const typeLabel = dep.dependency_type === "blocks" ? "\u2298 blocks" : dep.dependency_type;

    return Box(
      {
        flexDirection: "column",
        gap: 0,
        paddingLeft: 1,
        paddingBottom: 1,
      },
      Box(
        { flexDirection: "row", gap: 1, paddingLeft: 1 },
        Text({ content: "\u25CF", fg: statusColor }),
        Text({ content: dep.status, fg: statusColor }),
        Text({ content: dep.id, fg: COLORS.accent }),
        Text({ content: `(${typeLabel})`, fg: COLORS.textDim }),
      ),
      Box(
        {
          flexDirection: "column",
          paddingLeft: 3,
          paddingRight: 1,
        },
        Text({ content: dep.title, fg: COLORS.text, wrapMode: "word" }),
      ),
    );
  }

  // -- Key handling ----------------------------------------------------------

  private getDetailScrollbox(): {
    scrollBy?: (
      delta: number | { x: number; y: number },
      unit?: "absolute" | "viewport" | "content" | "step",
    ) => void;
    viewport?: { height: number };
  } | null {
    return (
      (this.overlayRoot?.getRenderable?.("issue-detail-scrollbox") as
        | {
            scrollBy?: (
              delta: number | { x: number; y: number },
              unit?: "absolute" | "viewport" | "content" | "step",
            ) => void;
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

  private installKeyHandler(): void {
    if (this.keyHandler) {
      this.renderer.keyInput.off("keypress", this.keyHandler);
    }

    this.keyHandler = (key: KeyEvent) => {
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        this.close();
        return;
      }

      if (key.ctrl && key.name === "d") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollHalfPage(1);
        return;
      }

      if (key.ctrl && key.name === "u") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollHalfPage(-1);
        return;
      }

      if (key.name === "j" || key.name === "down") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollDetail(1);
        return;
      }

      if (key.name === "k" || key.name === "up") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollDetail(-1);
        return;
      }

      if (key.name === "pagedown") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollDetail(10);
        return;
      }

      if (key.name === "pageup") {
        key.preventDefault();
        key.stopPropagation();
        this.scrollDetail(-10);
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
