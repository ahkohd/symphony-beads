// ---------------------------------------------------------------------------
// New Issue Dialog — OpenTUI component
//
// Displays a modal dialog for creating a new issue with fields for:
//   - Title (Input, required)
//   - Description (Input, multiline-ish single line)
//   - Priority (Select: P0-P4)
//   - Type (Select: bug, feature, task, chore)
//
// Submit creates issue via: bd create <title> -p <priority> -t <type> --description <desc>
// Cancel with Esc. Focus management between fields with Tab.
//
// Usage:
//   const dialog = new NewIssueDialog(renderer);
//   dialog.onClose(() => { /* re-render parent */ });
//   dialog.onCreated((issueId) => { /* refresh board */ });
//   dialog.show();
// ---------------------------------------------------------------------------

import {
  createCliRenderer,
  Box,
  Text,
  Input,
  Select,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
  type SelectOption,
} from "@opentui/core";

import { exec } from "../exec.ts";

// -- Colors ------------------------------------------------------------------

const COLORS = {
  bg: "#1a1b26",
  bgOverlay: "#000000",
  surface: "#24283b",
  border: "#414868",
  borderFocused: "#7aa2f7",
  text: "#c0caf5",
  textDim: "#565f89",
  accent: "#7aa2f7",
  green: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
} as const;

// -- Field definitions -------------------------------------------------------

const PRIORITY_OPTIONS: SelectOption[] = [
  { name: "P0 Critical", description: "Security, data loss, broken builds", value: 0 },
  { name: "P1 High", description: "Major features, important bugs", value: 1 },
  { name: "P2 Medium", description: "Default priority", value: 2 },
  { name: "P3 Low", description: "Polish, optimization", value: 3 },
  { name: "P4 Backlog", description: "Future ideas", value: 4 },
];

const TYPE_OPTIONS: SelectOption[] = [
  { name: "bug", description: "Something broken", value: "bug" },
  { name: "feature", description: "New functionality", value: "feature" },
  { name: "task", description: "Work item (tests, docs, refactoring)", value: "task" },
  { name: "chore", description: "Maintenance (dependencies, tooling)", value: "chore" },
];

/** The four focusable fields in the dialog. */
type FieldName = "title" | "description" | "priority" | "type";
const FIELD_ORDER: FieldName[] = ["title", "description", "priority", "type"];

// -- Dialog ------------------------------------------------------------------

export class NewIssueDialog {
  private renderer: CliRenderer;
  private overlayRoot: Renderable | null = null;
  private keyHandler: ((key: KeyEvent) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;
  private onCreatedCallback: ((issueId: string) => void) | null = null;

  // Field state
  private focusedField: FieldName = "title";
  private titleValue = "";
  private descriptionValue = "";
  private priorityIndex = 2; // default P2
  private typeIndex = 2; // default "task"

  // Renderable references (for focus management)
  private titleInput: Renderable | null = null;
  private descriptionInput: Renderable | null = null;
  private prioritySelect: Renderable | null = null;
  private typeSelect: Renderable | null = null;

  // Status message for validation errors / creation feedback
  private statusMessage = "";
  private statusColor: string = COLORS.textDim;
  private isSubmitting = false;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
  }

  /** Register a callback for when the dialog is closed. */
  onClose(callback: () => void): void {
    this.onCloseCallback = callback;
  }

  /** Register a callback for when an issue is successfully created. */
  onCreated(callback: (issueId: string) => void): void {
    this.onCreatedCallback = callback;
  }

  /** Show the dialog. */
  show(): void {
    this.close();
    this.resetState();
    this.render();
  }

  /** Close the dialog and clean up. */
  close(): void {
    if (this.keyHandler) {
      this.renderer.keyInput.off("keypress", this.keyHandler);
      this.keyHandler = null;
    }
    if (this.overlayRoot) {
      this.renderer.root.remove(this.overlayRoot.id);
      this.overlayRoot = null;
    }
    this.titleInput = null;
    this.descriptionInput = null;
    this.prioritySelect = null;
    this.typeSelect = null;
    if (this.onCloseCallback) {
      this.onCloseCallback();
    }
  }

  get isVisible(): boolean {
    return this.overlayRoot !== null;
  }

  // -- State management ------------------------------------------------------

  private resetState(): void {
    this.focusedField = "title";
    this.titleValue = "";
    this.descriptionValue = "";
    this.priorityIndex = 2;
    this.typeIndex = 2;
    this.statusMessage = "";
    this.statusColor = COLORS.textDim;
    this.isSubmitting = false;
  }

  // -- Rendering -------------------------------------------------------------

  private render(): void {
    // Remove existing overlay if present
    if (this.overlayRoot) {
      this.renderer.root.remove(this.overlayRoot.id);
      this.overlayRoot = null;
    }

    const titleBorderColor =
      this.focusedField === "title" ? COLORS.borderFocused : COLORS.border;
    const descBorderColor =
      this.focusedField === "description" ? COLORS.borderFocused : COLORS.border;
    const priorityBorderColor =
      this.focusedField === "priority" ? COLORS.borderFocused : COLORS.border;
    const typeBorderColor =
      this.focusedField === "type" ? COLORS.borderFocused : COLORS.border;

    // Build the title input
    const titleInput = Input({
      id: "new-issue-title",
      value: this.titleValue,
      placeholder: "Issue title (required)",
      width: "100%",
      backgroundColor: COLORS.surface,
      textColor: COLORS.text,
      focusedBackgroundColor: COLORS.bg,
      focusedTextColor: COLORS.text,
      placeholderColor: COLORS.textDim,
    });

    // Build the description input
    const descInput = Input({
      id: "new-issue-description",
      value: this.descriptionValue,
      placeholder: "Description (optional)",
      width: "100%",
      backgroundColor: COLORS.surface,
      textColor: COLORS.text,
      focusedBackgroundColor: COLORS.bg,
      focusedTextColor: COLORS.text,
      placeholderColor: COLORS.textDim,
    });

    // Build the priority select
    const prioritySelect = Select({
      id: "new-issue-priority",
      options: PRIORITY_OPTIONS,
      selectedIndex: this.priorityIndex,
      height: 5,
      width: "100%",
      backgroundColor: COLORS.surface,
      textColor: COLORS.text,
      focusedBackgroundColor: COLORS.bg,
      focusedTextColor: COLORS.accent,
      selectedBackgroundColor: COLORS.accent,
      selectedTextColor: COLORS.bg,
      showDescription: true,
      wrapSelection: true,
    });

    // Build the type select
    const typeSelect = Select({
      id: "new-issue-type",
      options: TYPE_OPTIONS,
      selectedIndex: this.typeIndex,
      height: 4,
      width: "100%",
      backgroundColor: COLORS.surface,
      textColor: COLORS.text,
      focusedBackgroundColor: COLORS.bg,
      focusedTextColor: COLORS.accent,
      selectedBackgroundColor: COLORS.accent,
      selectedTextColor: COLORS.bg,
      showDescription: true,
      wrapSelection: true,
    });

    // Status line
    const statusLine = this.statusMessage
      ? Text({ content: this.statusMessage, fg: this.statusColor })
      : Text({ content: "" });

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
        // Header
        Text({
          content: " New Issue",
          fg: COLORS.accent,
          attributes: 1, // bold
        }),
        Text({ content: "\u2500".repeat(50), fg: COLORS.border }),

        // Title field
        Box(
          { flexDirection: "column", gap: 0 },
          Text({ content: " Title", fg: titleBorderColor, attributes: 1 }),
          Box(
            {
              borderStyle: "rounded",
              border: true,
              borderColor: titleBorderColor,
              backgroundColor: COLORS.surface,
              padding: 0,
              paddingX: 1,
              height: 3,
            },
            titleInput,
          ),
        ),

        // Description field
        Box(
          { flexDirection: "column", gap: 0 },
          Text({ content: " Description", fg: descBorderColor, attributes: 1 }),
          Box(
            {
              borderStyle: "rounded",
              border: true,
              borderColor: descBorderColor,
              backgroundColor: COLORS.surface,
              padding: 0,
              paddingX: 1,
              height: 3,
            },
            descInput,
          ),
        ),

        // Priority + Type side by side
        Box(
          { flexDirection: "row", gap: 2 },
          // Priority
          Box(
            { flexDirection: "column", gap: 0, flexGrow: 1 },
            Text({ content: " Priority", fg: priorityBorderColor, attributes: 1 }),
            Box(
              {
                borderStyle: "rounded",
                border: true,
                borderColor: priorityBorderColor,
                backgroundColor: COLORS.surface,
                padding: 0,
                paddingX: 1,
                height: 7,
              },
              prioritySelect,
            ),
          ),
          // Type
          Box(
            { flexDirection: "column", gap: 0, flexGrow: 1 },
            Text({ content: " Type", fg: typeBorderColor, attributes: 1 }),
            Box(
              {
                borderStyle: "rounded",
                border: true,
                borderColor: typeBorderColor,
                backgroundColor: COLORS.surface,
                padding: 0,
                paddingX: 1,
                height: 7,
              },
              typeSelect,
            ),
          ),
        ),

        // Status line
        statusLine,

        // Footer
        Text({ content: "\u2500".repeat(50), fg: COLORS.border }),
        Text({
          content: " Tab next field  Shift+Tab prev  Enter/Ctrl+S submit  Esc cancel",
          fg: COLORS.textDim,
        }),
      ),
    );

    this.renderer.root.add(overlay);
    this.overlayRoot =
      this.renderer.root.getRenderable("new-issue-dialog-overlay") ?? null;

    // Grab references to the input/select renderables
    this.titleInput = this.findRenderable("new-issue-title");
    this.descriptionInput = this.findRenderable("new-issue-description");
    this.prioritySelect = this.findRenderable("new-issue-priority");
    this.typeSelect = this.findRenderable("new-issue-type");

    // Set up event listeners for input changes
    this.setupInputListeners();

    // Focus the current field
    this.focusCurrentField();

    // Install key handler (only once)
    if (!this.keyHandler) {
      this.installKeyHandler();
    }
  }

  private findRenderable(id: string): Renderable | null {
    if (!this.overlayRoot) return null;
    // Walk the tree to find the renderable by id
    return this.deepFind(this.overlayRoot, id);
  }

  private deepFind(node: Renderable, id: string): Renderable | null {
    if (node.id === id) return node;
    // Check children
    const children = (node as any).children as Renderable[] | undefined;
    if (children && Array.isArray(children)) {
      for (const child of children) {
        const found = this.deepFind(child, id);
        if (found) return found;
      }
    }
    // Also try getRenderable
    const found = node.getRenderable?.(id) ?? null;
    if (found) return found;
    return null;
  }

  private setupInputListeners(): void {
    // Listen for input changes on the title field
    if (this.titleInput) {
      this.titleInput.on("input", () => {
        this.titleValue = (this.titleInput as any)?.value ?? "";
      });
      this.titleInput.on("change", () => {
        this.titleValue = (this.titleInput as any)?.value ?? "";
      });
    }
    // Listen for input changes on the description field
    if (this.descriptionInput) {
      this.descriptionInput.on("input", () => {
        this.descriptionValue = (this.descriptionInput as any)?.value ?? "";
      });
      this.descriptionInput.on("change", () => {
        this.descriptionValue = (this.descriptionInput as any)?.value ?? "";
      });
    }
    // Listen for selection changes on priority
    if (this.prioritySelect) {
      this.prioritySelect.on("selectionChanged", (index: number) => {
        this.priorityIndex = index;
      });
    }
    // Listen for selection changes on type
    if (this.typeSelect) {
      this.typeSelect.on("selectionChanged", (index: number) => {
        this.typeIndex = index;
      });
    }
  }

  private focusCurrentField(): void {
    const fieldMap: Record<FieldName, Renderable | null> = {
      title: this.titleInput,
      description: this.descriptionInput,
      priority: this.prioritySelect,
      type: this.typeSelect,
    };

    const target = fieldMap[this.focusedField];
    if (target) {
      this.renderer.focusRenderable(target);
    }
  }

  private nextField(): void {
    const idx = FIELD_ORDER.indexOf(this.focusedField);
    this.focusedField = FIELD_ORDER[(idx + 1) % FIELD_ORDER.length]!;
    // Capture current input values before re-render
    this.captureValues();
    this.render();
  }

  private prevField(): void {
    const idx = FIELD_ORDER.indexOf(this.focusedField);
    this.focusedField = FIELD_ORDER[(idx - 1 + FIELD_ORDER.length) % FIELD_ORDER.length]!;
    // Capture current input values before re-render
    this.captureValues();
    this.render();
  }

  private captureValues(): void {
    if (this.titleInput) {
      this.titleValue = (this.titleInput as any)?.value ?? this.titleValue;
    }
    if (this.descriptionInput) {
      this.descriptionValue = (this.descriptionInput as any)?.value ?? this.descriptionValue;
    }
    if (this.prioritySelect) {
      this.priorityIndex = (this.prioritySelect as any)?.getSelectedIndex?.() ?? this.priorityIndex;
    }
    if (this.typeSelect) {
      this.typeIndex = (this.typeSelect as any)?.getSelectedIndex?.() ?? this.typeIndex;
    }
  }

  // -- Submission ------------------------------------------------------------

  private async submit(): Promise<void> {
    if (this.isSubmitting) return;

    // Capture latest values
    this.captureValues();

    // Validate title
    const title = this.titleValue.trim();
    if (!title) {
      this.statusMessage = "✗ Title is required";
      this.statusColor = COLORS.red;
      this.focusedField = "title";
      this.render();
      return;
    }

    this.isSubmitting = true;
    this.statusMessage = "⟳ Creating issue...";
    this.statusColor = COLORS.yellow;
    this.render();

    const priority = PRIORITY_OPTIONS[this.priorityIndex]?.value ?? 2;
    const type = TYPE_OPTIONS[this.typeIndex]?.value ?? "task";
    const description = this.descriptionValue.trim();

    // Build bd create command
    const cmd = ["bd", "create", title, "-p", String(priority), "-t", String(type), "--json"];
    if (description) {
      cmd.push("--description", description);
    }

    try {
      const result = await exec(cmd, { cwd: process.cwd() });

      if (result.code !== 0) {
        this.isSubmitting = false;
        this.statusMessage = `✗ Failed: ${result.stderr.trim() || "unknown error"}`;
        this.statusColor = COLORS.red;
        this.render();
        return;
      }

      // Try to extract issue ID from JSON output
      let issueId = "unknown";
      try {
        const parsed = JSON.parse(result.stdout);
        issueId = parsed.id ?? parsed.identifier ?? "unknown";
      } catch {
        // Try to extract from plain text
        const match = result.stdout.match(/([a-z]+-[a-z0-9]+)/i);
        if (match) issueId = match[1]!;
      }

      this.isSubmitting = false;
      this.statusMessage = `✓ Created: ${issueId}`;
      this.statusColor = COLORS.green;
      this.render();

      // Notify callback and auto-close after brief delay
      if (this.onCreatedCallback) {
        this.onCreatedCallback(issueId);
      }

      setTimeout(() => {
        this.close();
      }, 800);
    } catch (err) {
      this.isSubmitting = false;
      this.statusMessage = `✗ Error: ${err instanceof Error ? err.message : String(err)}`;
      this.statusColor = COLORS.red;
      this.render();
    }
  }

  // -- Key handling ----------------------------------------------------------

  private installKeyHandler(): void {
    this.keyHandler = (key: KeyEvent) => {
      // Escape closes the dialog
      if (key.name === "escape") {
        key.preventDefault();
        key.stopPropagation();
        this.close();
        return;
      }

      // Ctrl+S submits the form from any field
      if (key.name === "s" && key.ctrl) {
        key.preventDefault();
        key.stopPropagation();
        this.submit();
        return;
      }

      // Tab cycles focus forward
      if (key.name === "tab" && !key.shift) {
        key.preventDefault();
        key.stopPropagation();
        this.nextField();
        return;
      }

      // Shift+Tab cycles focus backward
      if (key.name === "tab" && key.shift) {
        key.preventDefault();
        key.stopPropagation();
        this.prevField();
        return;
      }

      // Enter submits from text inputs; on selects, let the component handle it
      if (key.name === "return" || key.name === "enter") {
        if (this.focusedField === "title" || this.focusedField === "description") {
          key.preventDefault();
          key.stopPropagation();
          this.submit();
          return;
        }
        // On priority/type selects: don't intercept — let Select handle Enter
        // to confirm option selection. User can submit via Ctrl+S or Tab to
        // a text field and press Enter.
      }
    };
    this.renderer.keyInput.on("keypress", this.keyHandler);
  }
}

// -- Standalone entry point --------------------------------------------------

/**
 * Show the new issue dialog standalone and block until it's closed.
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
    dialog.onCreated((id) => {
      // eslint-disable-next-line no-console
      console.log(`Created issue: ${id}`);
    });
    dialog.show();
  });
}

// Run standalone if invoked directly
if (import.meta.main) {
  await showNewIssueDialog();
}
