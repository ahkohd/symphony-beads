// ---------------------------------------------------------------------------
// TUI Kanban Board — issue management view
//
// Four-column board (Open | In Progress | Review | Closed) using OpenTUI
// flexbox layout. Cards are navigable with arrow keys, with actions for
// moving issues between columns, creating new issues, and viewing details.
// ---------------------------------------------------------------------------

import {
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  InputRenderable,
  StyledText,
  bold,
  dim,
  red,
  green,
  yellow,
  cyan,
  white,
  bgBlue,
  bgMagenta,
  bgRed,
  bgYellow,
  bgGreen,
  brightWhite,
  fg,
  type TextChunk,
} from "@opentui/core";
import type { CliRenderer, KeyEvent } from "@opentui/core";

import {
  type BeadIssue,
  type BeadIssueDetail,
  type BeadComment,
  type KanbanStatus,
  KANBAN_STATUSES,
  STATUS_LABELS,
  fetchAllIssues,
  fetchIssueDetail,
  fetchComments,
  groupByStatus,
  moveIssue,
  closeIssue,
  createIssue,
  nextStatus,
  prevStatus,
} from "./data.ts";

// -- Priority badges ---------------------------------------------------------

type ChunkFn = (s: string) => TextChunk;

const PRIORITY_BADGE: Record<number, ChunkFn> = {
  0: (s) => bgRed(brightWhite(` ${s} `)),
  1: (s) => bgMagenta(brightWhite(` ${s} `)),
  2: (s) => bgYellow(brightWhite(` ${s} `)),
  3: (s) => bgBlue(brightWhite(` ${s} `)),
  4: (s) => bgGreen(brightWhite(` ${s} `)),
};

function priorityBadge(p: number | null): TextChunk {
  const level = p ?? 2;
  const fn = PRIORITY_BADGE[level] ?? PRIORITY_BADGE[2]!;
  return fn(`P${level}`);
}

const STATUS_COLORS: Record<KanbanStatus, string> = {
  open: "#5599ff",
  in_progress: "#44cc44",
  review: "#ddaa22",
  closed: "#888888",
};

// -- Kanban Board ------------------------------------------------------------

export class KanbanBoard {
  private renderer: CliRenderer;
  private root: BoxRenderable;

  // Layout containers
  private headerText!: TextRenderable;
  private columnsRow!: BoxRenderable;
  private columns: Map<KanbanStatus, BoxRenderable> = new Map();
  private columnHeaders: Map<KanbanStatus, TextRenderable> = new Map();
  private columnScrollBoxes: Map<KanbanStatus, ScrollBoxRenderable> = new Map();
  private statusText!: TextRenderable;

  // Detail overlay
  private detailOverlay!: BoxRenderable;
  private detailScrollBox!: ScrollBoxRenderable;
  private detailTitle!: TextRenderable;
  private detailBody!: TextRenderable;
  private showingDetail = false;

  // New issue dialog
  private newIssueOverlay!: BoxRenderable;
  private newIssueTitleInput!: InputRenderable;
  private newIssueStatusText!: TextRenderable;
  private showingNewIssue = false;

  // Data
  private grouped: Record<KanbanStatus, BeadIssue[]> = {
    open: [],
    in_progress: [],
    review: [],
    closed: [],
  };

  // Navigation state
  private selectedCol: number = 0;
  private selectedRow: number = 0;
  private cardRenderables: Map<string, BoxRenderable> = new Map();

  // Polling
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs = 5000;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
    this.root = new BoxRenderable(renderer, {
      id: "kanban-root",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      backgroundColor: "#1a1a2e",
    });

    this.buildLayout();
    this.setupKeyBindings();
  }

  /** Attach to renderer root and start data polling */
  async start(): Promise<void> {
    this.renderer.root.add(this.root);
    await this.refresh();
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, this.pollIntervalMs);
  }

  /** Remove from renderer and stop polling */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    try {
      this.renderer.root.remove(this.root.id);
    } catch {
      // already removed
    }
  }

  // -- Layout ----------------------------------------------------------------

  private buildLayout(): void {
    const r = this.renderer;

    // Header
    const headerBar = new BoxRenderable(r, {
      id: "kanban-header",
      width: "100%",
      height: 1,
      flexShrink: 0,
      flexDirection: "row",
      backgroundColor: "#16213e",
    });
    this.headerText = new TextRenderable(r, {
      id: "kanban-header-text",
      width: "100%",
      height: 1,
      content: new StyledText([bold(cyan(" ♦ Symphony Kanban Board"))]),
      truncate: true,
    });
    headerBar.add(this.headerText);
    this.root.add(headerBar);

    // Columns row
    this.columnsRow = new BoxRenderable(r, {
      id: "kanban-columns",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
    });

    for (const status of KANBAN_STATUSES) {
      const col = this.buildColumn(status);
      this.columnsRow.add(col);
    }
    this.root.add(this.columnsRow);

    // Status bar
    const statusBar = new BoxRenderable(r, {
      id: "kanban-status",
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: "#16213e",
    });
    this.statusText = new TextRenderable(r, {
      id: "kanban-status-text",
      width: "100%",
      height: 1,
      content: "",
      truncate: true,
    });
    statusBar.add(this.statusText);
    this.root.add(statusBar);

    // Footer
    const footerBar = new BoxRenderable(r, {
      id: "kanban-footer",
      width: "100%",
      height: 1,
      flexShrink: 0,
      backgroundColor: "#0f3460",
    });
    const footerText = new TextRenderable(r, {
      id: "kanban-footer-text",
      width: "100%",
      height: 1,
      content: new StyledText([
        dim(" ←↑↓→"),
        white(" navigate  "),
        dim("Enter"),
        white(" detail  "),
        dim("m/M"),
        white(" move  "),
        dim("n"),
        white(" new  "),
        dim("d"),
        white(" close  "),
        dim("r"),
        white(" refresh  "),
        dim("q"),
        white(" quit"),
      ]),
      truncate: true,
    });
    footerBar.add(footerText);
    this.root.add(footerBar);

    // Detail overlay (hidden)
    this.buildDetailOverlay();

    // New issue dialog (hidden)
    this.buildNewIssueDialog();
  }

  private buildColumn(status: KanbanStatus): BoxRenderable {
    const r = this.renderer;
    const color = STATUS_COLORS[status];

    const col = new BoxRenderable(r, {
      id: `kanban-col-${status}`,
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: "column",
      border: true,
      borderStyle: "single",
      borderColor: "#333355",
      backgroundColor: "#1a1a2e",
      overflow: "hidden",
    });

    const header = new TextRenderable(r, {
      id: `kanban-col-header-${status}`,
      width: "100%",
      height: 1,
      content: new StyledText([bold(fg(color)(` ${STATUS_LABELS[status]}`)), dim(" (0)")]),
      truncate: true,
    });

    const scrollBox = new ScrollBoxRenderable(r, {
      id: `kanban-col-scroll-${status}`,
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
      stickyScroll: false,
      contentOptions: {
        flexDirection: "column",
        width: "100%",
      },
    });

    col.add(header);
    col.add(scrollBox);

    this.columns.set(status, col);
    this.columnHeaders.set(status, header);
    this.columnScrollBoxes.set(status, scrollBox);

    return col;
  }

  private buildDetailOverlay(): void {
    const r = this.renderer;

    this.detailOverlay = new BoxRenderable(r, {
      id: "kanban-detail-overlay",
      position: "absolute",
      top: 2,
      left: "10%",
      width: "80%",
      height: "80%",
      border: true,
      borderStyle: "double",
      borderColor: "#5599ff",
      backgroundColor: "#16213e",
      flexDirection: "column",
      visible: false,
      zIndex: 100,
      padding: 1,
    });

    this.detailTitle = new TextRenderable(r, {
      id: "kanban-detail-title",
      width: "100%",
      height: 2,
      content: "",
      truncate: true,
    });

    this.detailScrollBox = new ScrollBoxRenderable(r, {
      id: "kanban-detail-scroll",
      width: "100%",
      flexGrow: 1,
      scrollY: true,
      scrollX: false,
      contentOptions: {
        flexDirection: "column",
        width: "100%",
      },
    });

    this.detailBody = new TextRenderable(r, {
      id: "kanban-detail-body",
      width: "100%",
      content: "",
      wrapMode: "word",
    });

    this.detailScrollBox.add(this.detailBody);

    const closeHint = new TextRenderable(r, {
      id: "kanban-detail-hint",
      width: "100%",
      height: 1,
      content: new StyledText([dim(" Press Esc to close")]),
      truncate: true,
    });

    this.detailOverlay.add(this.detailTitle);
    this.detailOverlay.add(this.detailScrollBox);
    this.detailOverlay.add(closeHint);

    this.root.add(this.detailOverlay);
  }

  private buildNewIssueDialog(): void {
    const r = this.renderer;

    this.newIssueOverlay = new BoxRenderable(r, {
      id: "kanban-new-overlay",
      position: "absolute",
      top: "30%",
      left: "20%",
      width: "60%",
      height: 7,
      border: true,
      borderStyle: "double",
      borderColor: "#44cc44",
      backgroundColor: "#16213e",
      flexDirection: "column",
      visible: false,
      zIndex: 100,
      padding: 1,
    });

    const titleLabel = new TextRenderable(r, {
      id: "kanban-new-label",
      width: "100%",
      height: 1,
      content: new StyledText([bold(green(" New Issue"))]),
      truncate: true,
    });

    const inputLabel = new TextRenderable(r, {
      id: "kanban-new-input-label",
      width: "100%",
      height: 1,
      content: new StyledText([dim(" Title: ")]),
      truncate: true,
    });

    this.newIssueTitleInput = new InputRenderable(r, {
      id: "kanban-new-input",
      width: "100%",
      placeholder: "Enter issue title...",
      backgroundColor: "#2a2a4e",
    });

    this.newIssueStatusText = new TextRenderable(r, {
      id: "kanban-new-status",
      width: "100%",
      height: 1,
      content: new StyledText([dim(" Enter to create • Esc to cancel")]),
      truncate: true,
    });

    this.newIssueOverlay.add(titleLabel);
    this.newIssueOverlay.add(inputLabel);
    this.newIssueOverlay.add(this.newIssueTitleInput);
    this.newIssueOverlay.add(this.newIssueStatusText);

    this.root.add(this.newIssueOverlay);
  }

  // -- Key bindings ----------------------------------------------------------

  private setupKeyBindings(): void {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.defaultPrevented) return;

      // New issue dialog captures all keys when visible
      if (this.showingNewIssue) {
        this.handleNewIssueKey(key);
        return;
      }

      // Detail overlay captures Esc and scroll keys
      if (this.showingDetail) {
        this.handleDetailKey(key);
        return;
      }

      switch (key.name) {
        case "q":
          if (!key.ctrl && !key.meta) {
            this.stop();
            this.renderer.destroy();
          }
          break;
        case "r":
          if (!key.ctrl && !key.meta) {
            this.setStatus("Refreshing...");
            void this.refresh();
          }
          break;
        case "left":
          this.moveSelection(-1, 0);
          break;
        case "right":
          this.moveSelection(1, 0);
          break;
        case "up":
          this.moveSelection(0, -1);
          break;
        case "down":
          this.moveSelection(0, 1);
          break;
        case "return":
          void this.showDetail();
          break;
        case "m":
          if (key.shift) {
            void this.moveIssuePrev();
          } else {
            void this.moveIssueNext();
          }
          break;
        case "n":
          if (!key.ctrl && !key.meta) {
            this.openNewIssueDialog();
          }
          break;
        case "d":
          if (!key.ctrl && !key.meta) {
            void this.closeSelectedIssue();
          }
          break;
        case "tab":
          if (key.shift) {
            this.moveSelection(-1, 0);
          } else {
            this.moveSelection(1, 0);
          }
          break;
      }
    });
  }

  // -- Navigation ------------------------------------------------------------

  private moveSelection(dx: number, dy: number): void {
    const newCol = Math.max(0, Math.min(KANBAN_STATUSES.length - 1, this.selectedCol + dx));
    const colStatus = KANBAN_STATUSES[newCol]!;
    const colIssues = this.grouped[colStatus];
    const maxRow = Math.max(0, colIssues.length - 1);

    let newRow: number;
    if (dx !== 0) {
      // When switching columns, clamp row to new column height
      newRow = Math.min(this.selectedRow, maxRow);
    } else {
      newRow = Math.max(0, Math.min(maxRow, this.selectedRow + dy));
    }

    this.selectedCol = newCol;
    this.selectedRow = newRow;
    this.updateCardHighlights();
    this.scrollSelectedIntoView();
  }

  private getSelectedIssue(): BeadIssue | null {
    const status = KANBAN_STATUSES[this.selectedCol];
    if (!status) return null;
    const colIssues = this.grouped[status];
    return colIssues[this.selectedRow] ?? null;
  }

  // -- Actions ---------------------------------------------------------------

  private async moveIssueNext(): Promise<void> {
    const issue = this.getSelectedIssue();
    if (!issue) return;

    const next = nextStatus(issue.status);
    if (!next) {
      this.setStatus("Cannot move forward — already at end");
      return;
    }

    this.setStatus(`Moving ${issue.id} → ${STATUS_LABELS[next]}...`);
    const ok = await moveIssue(issue.id, next);
    if (ok) {
      this.setStatus(`Moved ${issue.id} → ${STATUS_LABELS[next]}`);
      await this.refresh();
    } else {
      this.setStatus(`Failed to move ${issue.id}`);
    }
  }

  private async moveIssuePrev(): Promise<void> {
    const issue = this.getSelectedIssue();
    if (!issue) return;

    const prev = prevStatus(issue.status);
    if (!prev) {
      this.setStatus("Cannot move backward — already at start");
      return;
    }

    this.setStatus(`Moving ${issue.id} → ${STATUS_LABELS[prev]}...`);
    const ok = await moveIssue(issue.id, prev);
    if (ok) {
      this.setStatus(`Moved ${issue.id} → ${STATUS_LABELS[prev]}`);
      await this.refresh();
    } else {
      this.setStatus(`Failed to move ${issue.id}`);
    }
  }

  private async closeSelectedIssue(): Promise<void> {
    const issue = this.getSelectedIssue();
    if (!issue) return;

    if (issue.status === "closed") {
      this.setStatus(`${issue.id} is already closed`);
      return;
    }

    this.setStatus(`Closing ${issue.id}...`);
    const ok = await closeIssue(issue.id);
    if (ok) {
      this.setStatus(`Closed ${issue.id}`);
      await this.refresh();
    } else {
      this.setStatus(`Failed to close ${issue.id}`);
    }
  }

  private async showDetail(): Promise<void> {
    const issue = this.getSelectedIssue();
    if (!issue) return;

    this.setStatus(`Loading details for ${issue.id}...`);

    const [detail, comments] = await Promise.all([
      fetchIssueDetail(issue.id),
      fetchComments(issue.id),
    ]);

    if (!detail) {
      this.setStatus(`Failed to load details for ${issue.id}`);
      return;
    }

    this.renderDetailPanel(detail, comments);
    this.detailOverlay.visible = true;
    this.showingDetail = true;
    this.setStatus("");
    this.renderer.requestRender();
  }

  private renderDetailPanel(detail: BeadIssueDetail, comments: BeadComment[]): void {
    const statusColor = STATUS_COLORS[detail.status as KanbanStatus] ?? "#888888";
    this.detailTitle.content = new StyledText([
      bold(cyan(` ${detail.id}`)),
      white("  "),
      priorityBadge(detail.priority),
      white(`  ${detail.title}`),
      white("\n"),
      fg(statusColor)(` Status: ${detail.status}`),
      dim(`  Type: ${detail.issue_type}`),
      detail.owner ? dim(`  Owner: ${detail.owner}`) : dim(""),
    ]);

    const parts: TextChunk[] = [];

    if (detail.description) {
      parts.push(bold(white("\n Description\n")));
      parts.push(dim(` ${detail.description.replace(/\n/g, "\n ")}\n`));
    }

    if (detail.dependencies && detail.dependencies.length > 0) {
      parts.push(bold(white("\n Dependencies\n")));
      for (const dep of detail.dependencies) {
        parts.push(dim(` • ${dep.id} [${dep.status}] ${dep.title}\n`));
      }
    }

    if (detail.dependents && detail.dependents.length > 0) {
      parts.push(bold(white("\n Dependents\n")));
      for (const dep of detail.dependents) {
        parts.push(dim(` • ${dep.id} [${dep.status}] ${dep.title}\n`));
      }
    }

    if (comments.length > 0) {
      parts.push(bold(white("\n Comments\n")));
      for (const c of comments) {
        parts.push(cyan(` ${c.author}`));
        parts.push(dim(` ${c.created_at}\n`));
        parts.push(white(` ${c.body}\n\n`));
      }
    }

    if (parts.length === 0) {
      parts.push(dim("\n No additional details."));
    }

    this.detailBody.content = new StyledText(parts);
  }

  private handleDetailKey(key: KeyEvent): void {
    if (key.name === "escape" || key.name === "q") {
      this.detailOverlay.visible = false;
      this.showingDetail = false;
      this.renderer.requestRender();
    } else if (key.name === "up") {
      this.detailScrollBox.scrollBy(-1);
    } else if (key.name === "down") {
      this.detailScrollBox.scrollBy(1);
    }
  }

  // -- New issue dialog ------------------------------------------------------

  private openNewIssueDialog(): void {
    this.showingNewIssue = true;
    this.newIssueOverlay.visible = true;
    this.newIssueTitleInput.value = "";
    this.newIssueTitleInput.focus();
    this.renderer.requestRender();
  }

  private handleNewIssueKey(key: KeyEvent): void {
    if (key.name === "escape") {
      this.closeNewIssueDialog();
      return;
    }
    if (key.name === "return") {
      key.preventDefault();
      void this.submitNewIssue();
      return;
    }
    this.newIssueTitleInput.handleKeyPress(key);
  }

  private closeNewIssueDialog(): void {
    this.showingNewIssue = false;
    this.newIssueOverlay.visible = false;
    this.newIssueTitleInput.blur();
    this.renderer.requestRender();
  }

  private async submitNewIssue(): Promise<void> {
    const title = this.newIssueTitleInput.value.trim();
    if (!title) {
      this.newIssueStatusText.content = new StyledText([red(" Title cannot be empty")]);
      this.renderer.requestRender();
      return;
    }

    this.newIssueStatusText.content = new StyledText([yellow(" Creating issue...")]);
    this.renderer.requestRender();

    const id = await createIssue(title);
    this.closeNewIssueDialog();

    if (id) {
      this.setStatus(`Created issue ${id}: ${title}`);
      await this.refresh();
    } else {
      this.setStatus("Failed to create issue");
    }
  }

  // -- Data refresh ----------------------------------------------------------

  async refresh(): Promise<void> {
    try {
      const issues = await fetchAllIssues();
      this.grouped = groupByStatus(issues);
      this.renderCards();
      this.updateColumnHeaders();
      this.updateCardHighlights();
      this.renderer.requestRender();
    } catch (err) {
      this.setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -- Card rendering --------------------------------------------------------

  private renderCards(): void {
    const r = this.renderer;

    // Clear all cards from scrollboxes
    for (const status of KANBAN_STATUSES) {
      const scrollBox = this.columnScrollBoxes.get(status);
      if (!scrollBox) continue;
      for (const child of scrollBox.getChildren()) {
        scrollBox.remove(child.id);
        child.destroyRecursively();
      }
    }
    this.cardRenderables.clear();

    for (const status of KANBAN_STATUSES) {
      const scrollBox = this.columnScrollBoxes.get(status);
      if (!scrollBox) continue;
      const issues = this.grouped[status];

      for (const issue of issues) {
        const card = this.buildCard(issue);
        scrollBox.add(card);
        this.cardRenderables.set(issue.id, card);
      }

      if (issues.length === 0) {
        const empty = new TextRenderable(r, {
          id: `kanban-empty-${status}`,
          width: "100%",
          height: 1,
          content: new StyledText([dim("  (no issues)")]),
          truncate: true,
        });
        scrollBox.add(empty);
      }
    }
  }

  private buildCard(issue: BeadIssue): BoxRenderable {
    const r = this.renderer;

    const card = new BoxRenderable(r, {
      id: `kanban-card-${issue.id}`,
      width: "100%",
      height: 3,
      flexShrink: 0,
      border: true,
      borderStyle: "single",
      borderColor: "#333355",
      backgroundColor: "#22224a",
      flexDirection: "column",
      overflow: "hidden",
    });

    // Line 1: ID + priority badge
    const line1 = new TextRenderable(r, {
      id: `kanban-card-l1-${issue.id}`,
      width: "100%",
      height: 1,
      content: new StyledText([cyan(` ${issue.id} `), priorityBadge(issue.priority)]),
      truncate: true,
    });

    // Line 2: Title (truncated)
    const maxLen = 40;
    const titleText =
      issue.title.length > maxLen ? issue.title.slice(0, maxLen - 3) + "..." : issue.title;
    const line2 = new TextRenderable(r, {
      id: `kanban-card-l2-${issue.id}`,
      width: "100%",
      height: 1,
      content: new StyledText([white(` ${titleText}`)]),
      truncate: true,
    });

    card.add(line1);
    card.add(line2);

    // Line 3: Assignee
    if (issue.owner) {
      const ownerShort =
        issue.owner.length > 20 ? issue.owner.slice(0, 17) + "..." : issue.owner;
      const line3 = new TextRenderable(r, {
        id: `kanban-card-l3-${issue.id}`,
        width: "100%",
        height: 1,
        content: new StyledText([dim(` ◎ ${ownerShort}`)]),
        truncate: true,
      });
      card.add(line3);
    }

    return card;
  }

  private updateColumnHeaders(): void {
    for (const status of KANBAN_STATUSES) {
      const count = this.grouped[status].length;
      const color = STATUS_COLORS[status];
      const header = this.columnHeaders.get(status);
      if (header) {
        header.content = new StyledText([
          bold(fg(color)(` ${STATUS_LABELS[status]}`)),
          dim(` (${count})`),
        ]);
      }
    }
  }

  private updateCardHighlights(): void {
    for (let colIdx = 0; colIdx < KANBAN_STATUSES.length; colIdx++) {
      const status = KANBAN_STATUSES[colIdx]!;
      const issues = this.grouped[status];
      const isSelectedCol = colIdx === this.selectedCol;

      // Highlight active column border
      const col = this.columns.get(status);
      if (col) {
        col.borderColor = isSelectedCol ? STATUS_COLORS[status] : "#333355";
      }

      for (let i = 0; i < issues.length; i++) {
        const issue = issues[i]!;
        const card = this.cardRenderables.get(issue.id);
        if (!card) continue;

        const isSelected = isSelectedCol && i === this.selectedRow;
        if (isSelected) {
          card.backgroundColor = "#3a3a7e";
          card.borderColor = "#8888ff";
        } else {
          card.backgroundColor = "#22224a";
          card.borderColor = "#333355";
        }
      }
    }
    this.renderer.requestRender();
  }

  private scrollSelectedIntoView(): void {
    const status = KANBAN_STATUSES[this.selectedCol];
    if (!status) return;
    const scrollBox = this.columnScrollBoxes.get(status);
    const issue = this.getSelectedIssue();
    if (!scrollBox || !issue) return;

    const card = this.cardRenderables.get(issue.id);
    if (card) {
      scrollBox.scrollChildIntoView(card.id);
    }
  }

  // -- Status bar ------------------------------------------------------------

  private setStatus(msg: string): void {
    this.statusText.content = msg ? new StyledText([dim(` ${msg}`)]) : "";
    this.renderer.requestRender();
  }
}
