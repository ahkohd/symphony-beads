// ---------------------------------------------------------------------------
// New Issue Dialog — workflow guidance modal
//
// Creating issues directly from the Kanban TUI is intentionally disabled.
// This modal guides users to create issues through their agent/Beads CLI.
//
// Usage:
//   const dialog = new NewIssueDialog(renderer);
//   dialog.onClose(() => { /* refresh parent state */ });
//   dialog.show();
// ---------------------------------------------------------------------------

import {
  Box,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  type Renderable,
  Text,
} from "@opentui/core";

// -- Colors ------------------------------------------------------------------

const COLORS = {
  bg: "#1a1b26",
  bgOverlay: "#000000",
  border: "#414868",
  text: "#c0caf5",
  textDim: "#565f89",
  accent: "#7aa2f7",
  cyan: "#7dcfff",
} as const;

const GUIDANCE_MESSAGE = "Create issues through your agent using Beads (`bd create ...`).";

// -- Dialog ------------------------------------------------------------------

export class NewIssueDialog {
  private renderer: CliRenderer;
  private overlayRoot: Renderable | null = null;
  private keyHandler: ((key: KeyEvent) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
  }

  /** Register a callback for when the dialog is closed. */
  onClose(callback: () => void): void {
    this.onCloseCallback = callback;
  }

  /** Show the guidance dialog. */
  show(): void {
    this.teardown(false);

    const overlay = Box(
      {
        id: "new-issue-dialog-overlay",
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
          id: "new-issue-dialog-panel",
          borderStyle: "rounded",
          border: true,
          borderColor: COLORS.border,
          backgroundColor: COLORS.bg,
          padding: 1,
          paddingX: 2,
          width: "60%",
          maxWidth: 80,
          flexDirection: "column",
          gap: 1,
        },
        Text({
          content: " Issue creation from Kanban is disabled",
          fg: COLORS.accent,
          attributes: 1,
        }),
        Text({ content: "\u2500".repeat(58), fg: COLORS.border }),
        Text({
          content: "Create issues from your agent workflow instead of this TUI.",
          fg: COLORS.text,
          wrapMode: "word",
        }),
        Text({ content: GUIDANCE_MESSAGE, fg: COLORS.cyan, wrapMode: "word" }),
        Text({
          content: "Then return to Kanban and press r to refresh.",
          fg: COLORS.textDim,
          wrapMode: "word",
        }),
        Text({ content: "\u2500".repeat(58), fg: COLORS.border }),
        Text({ content: " Esc/Enter close", fg: COLORS.textDim }),
      ),
    );

    this.renderer.root.add(overlay);
    this.overlayRoot = this.renderer.root.getRenderable("new-issue-dialog-overlay") ?? null;
    this.installKeyHandler();
  }

  /** Close the dialog and clean up. */
  close(): void {
    this.teardown(true);
  }

  get isVisible(): boolean {
    return this.overlayRoot !== null;
  }

  private teardown(notifyClose: boolean): void {
    const wasVisible = this.overlayRoot !== null;

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

  private installKeyHandler(): void {
    this.keyHandler = (key: KeyEvent) => {
      if (key.name === "escape" || key.name === "return" || key.name === "enter") {
        key.preventDefault();
        key.stopPropagation();
        this.close();
        return;
      }

      key.preventDefault();
      key.stopPropagation();
    };

    this.renderer.keyInput.on("keypress", this.keyHandler);
  }
}

// -- Standalone entry point --------------------------------------------------

/**
 * Show the guidance dialog standalone and block until it's closed.
 * Useful for testing:
 *   bun run src/tui/new-issue-dialog.ts
 */
export async function showNewIssueDialog(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: true,
  });

  const dialog = new NewIssueDialog(renderer);

  return new Promise<void>((resolve) => {
    dialog.onClose(() => {
      renderer.destroy();
      resolve();
    });
    dialog.show();
  });
}

// Run standalone if invoked directly
if (import.meta.main) {
  await showNewIssueDialog();
}
