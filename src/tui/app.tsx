// ---------------------------------------------------------------------------
// TUI Kanban Board — issue management view using OpenTUI React
//
// Five-column kanban layout (Open, In Progress, Review, Closed, Deferred).
// Arrow keys or vim keys (h/j/k/l) navigate cards, Enter for details,
// mouse click selects columns/cards, / searches/filter cards,
// m/M moves status, b sends to backlog (deferred),
// B promotes from backlog to open, s sorts current column,
// n opens issue-creation guidance, d closes/deletes.
//
// ---------------------------------------------------------------------------

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { exec } from "../exec.ts";
import { IssueDetailOverlay } from "./issue-detail-overlay.ts";
import { NewIssueDialog } from "./new-issue-dialog.ts";

// -- Types -------------------------------------------------------------------

interface Issue {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  issue_type: string;
  owner: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
}

/** Position of the selected card: column index + card index within column. */
interface CursorPos {
  col: number;
  row: number;
}

// -- Constants ---------------------------------------------------------------

const COLUMNS = [
  { key: "open", label: "Open", color: "#9ece6a" },
  { key: "in_progress", label: "In Progress", color: "#7dcfff" },
  { key: "review", label: "Review", color: "#e0af68" },
  { key: "closed", label: "Closed", color: "#565f89" },
  { key: "deferred", label: "Deferred", color: "#bb9af7" },
] as const;

const STATUS_ORDER: string[] = COLUMNS.map((c) => c.key);

const COLORS = {
  bg: "#1a1b26",
  surface: "#24283b",
  border: "#414868",
  borderHighlight: "#7aa2f7",
  text: "#c0caf5",
  textDim: "#565f89",
  accent: "#7aa2f7",
  green: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
  headerBg: "#1f2335",
} as const;

const PRIORITY_BADGE: Record<number, { label: string; color: string }> = {
  0: { label: "P0", color: COLORS.red },
  1: { label: "P1", color: COLORS.yellow },
  2: { label: "P2", color: COLORS.accent },
  3: { label: "P3", color: COLORS.textDim },
  4: { label: "P4", color: COLORS.textDim },
};

const POLL_INTERVAL_MS = 5000;

// -- Data fetching -----------------------------------------------------------

async function fetchAllIssues(): Promise<Issue[]> {
  try {
    const result = await exec(["bd", "list", "--all", "--json"], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    if (result.code !== 0 || !result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((raw: Record<string, unknown>) => ({
      id: (raw.id as string) ?? "",
      title: (raw.title as string) ?? "(untitled)",
      status: (raw.status as string) ?? "open",
      priority: typeof raw.priority === "number" ? raw.priority : null,
      issue_type: (raw.issue_type as string) ?? "task",
      owner: (raw.owner as string) ?? null,
      created_at: typeof raw.created_at === "string" ? raw.created_at : null,
      updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
      closed_at: typeof raw.closed_at === "string" ? raw.closed_at : null,
    }));
  } catch {
    return [];
  }
}

async function moveIssueStatus(issueId: string, newStatus: string): Promise<boolean> {
  try {
    const result = await exec(["bd", "update", issueId, "--status", newStatus], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

async function closeIssue(issueId: string): Promise<boolean> {
  try {
    const result = await exec(["bd", "close", issueId, "--reason", "Closed from TUI"], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

// -- Helpers -----------------------------------------------------------------

type ColumnSortMode = "default" | "priority";

type ScrollBoxRenderableAPI = {
  scrollBy?: (
    delta: number | { x: number; y: number },
    unit?: "absolute" | "viewport" | "content" | "step",
  ) => void;
  scrollTo?: (position: number | { x: number; y: number }) => void;
  scrollChildIntoView?: (childId: string) => void;
  viewport?: {
    height: number;
  };
};

function makeColumnScrollboxId(columnKey: string): string {
  return `kanban-col-scroll-${columnKey}`;
}

function makeIssueCardId(issueId: string): string {
  const safeId = issueId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `kanban-card-${safeId}`;
}

function truncStr(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function parseIssueTs(value: string | null): number {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function getRecencyTs(issue: Issue): number {
  return parseIssueTs(issue.closed_at ?? issue.updated_at ?? issue.created_at);
}

function compareClosedNewestFirst(a: Issue, b: Issue): number {
  const diff = getRecencyTs(b) - getRecencyTs(a);
  if (diff !== 0) return diff;
  return b.id.localeCompare(a.id);
}

function compareByPriority(a: Issue, b: Issue): number {
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;

  const recencyDiff = getRecencyTs(b) - getRecencyTs(a);
  if (recencyDiff !== 0) return recencyDiff;

  return a.id.localeCompare(b.id);
}

function filterIssues(issues: Issue[], query: string): Issue[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return issues;

  return issues.filter((issue) => {
    const haystack = [issue.id, issue.title, issue.status, issue.issue_type, issue.owner ?? ""]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalized);
  });
}

function bucketIssues(
  issues: Issue[],
  sortModes: Readonly<Record<string, ColumnSortMode>>,
): Map<string, Issue[]> {
  const buckets = new Map<string, Issue[]>();
  for (const col of COLUMNS) {
    buckets.set(col.key, []);
  }

  for (const issue of issues) {
    const key = STATUS_ORDER.includes(issue.status) ? issue.status : "open";
    buckets.get(key)!.push(issue);
  }

  for (const col of COLUMNS) {
    const items = buckets.get(col.key);
    if (!items || items.length <= 1) continue;

    const mode = sortModes[col.key] ?? "default";
    if (mode === "priority") {
      items.sort(compareByPriority);
      continue;
    }

    if (col.key === "closed") {
      items.sort(compareClosedNewestFirst);
    }
  }

  return buckets;
}

function clampCursor(cursor: CursorPos, buckets: Map<string, Issue[]>): CursorPos {
  const col = Math.max(0, Math.min(cursor.col, COLUMNS.length - 1));
  const colKey = COLUMNS[col]!.key;
  const items = buckets.get(colKey) ?? [];
  const row = items.length > 0 ? Math.max(0, Math.min(cursor.row, items.length - 1)) : 0;
  return { col, row };
}

// -- Components --------------------------------------------------------------

function Header({ issueCount, status }: { issueCount: number; status: string }) {
  const statsStr = "";

  return (
    <box
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
        backgroundColor: COLORS.headerBg,
      }}
    >
      <text>
        <strong fg={COLORS.accent}>Symphony</strong>
        <span fg={COLORS.textDim}> Kanban</span>
        <span fg={COLORS.textDim}> — {issueCount} issues</span>
        <span fg={COLORS.textDim}>{statsStr}</span>
      </text>
      <text>{status ? <span fg={COLORS.yellow}> {status}</span> : null}</text>
    </box>
  );
}

function _fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function PriorityBadge({ priority }: { priority: number | null }) {
  if (priority === null) return <span fg={COLORS.textDim}>--</span>;
  const badge = PRIORITY_BADGE[priority] ?? {
    label: `P${priority}`,
    color: COLORS.textDim,
  };
  return <span fg={badge.color}>{badge.label}</span>;
}

function IssueCard({
  issue,
  isSelected,
  onSelect,
  cardId,
}: {
  issue: Issue;
  isSelected: boolean;
  onSelect: () => void;
  cardId: string;
}) {
  const borderColor = isSelected ? COLORS.borderHighlight : COLORS.border;
  const bgColor = isSelected ? COLORS.surface : COLORS.bg;
  const assignee = issue.owner ? truncStr(issue.owner.replace(/^agent@/, "@"), 16) : "";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI box supports mouse handlers.
    <box
      id={cardId}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect();
      }}
      style={{
        flexDirection: "column",
        borderStyle: "rounded",
        border: true,
        borderColor,
        backgroundColor: bgColor,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <box
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          height: 1,
        }}
      >
        <text>
          <span fg={COLORS.cyan}>{issue.id}</span>
        </text>
        <text>
          <PriorityBadge priority={issue.priority} />
        </text>
      </box>
      <text fg={COLORS.text}>{issue.title}</text>

      {assignee ? <text fg={COLORS.textDim}>{assignee}</text> : <text fg={COLORS.textDim}>—</text>}
    </box>
  );
}

function KanbanColumn({
  label,
  color,
  issues,
  selectedRow,
  isActiveColumn,
  columnKey,
  onSelectColumn,
  onSelectCard,
}: {
  label: string;
  color: string;
  issues: Issue[];
  selectedRow: number;
  isActiveColumn: boolean;
  columnKey: string;
  onSelectColumn: () => void;
  onSelectCard: (row: number) => void;
}) {
  const headerBorderColor = isActiveColumn ? color : COLORS.border;
  const scrollboxId = makeColumnScrollboxId(columnKey);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI box supports mouse handlers.
    <box
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        onSelectColumn();
      }}
      style={{
        flexDirection: "column",
        flexGrow: 1,
        flexBasis: 0,
        borderStyle: "single",
        border: true,
        borderColor: headerBorderColor,
        backgroundColor: COLORS.bg,
      }}
    >
      {/* Column header */}
      <box
        style={{
          height: 1,
          paddingLeft: 1,
          backgroundColor: isActiveColumn ? COLORS.surface : COLORS.bg,
        }}
      >
        <text>
          <span fg={color}>
            <strong>{label}</strong>
          </span>
          <span fg={COLORS.textDim}> ({issues.length})</span>
        </text>
      </box>

      {/* Cards */}
      <scrollbox
        id={scrollboxId}
        style={{
          rootOptions: { flexGrow: 1, backgroundColor: COLORS.bg },
          contentOptions: {
            flexDirection: "column",
            gap: 0,
            backgroundColor: COLORS.bg,
          },
        }}
      >
        {issues.length === 0 ? (
          <box style={{ paddingLeft: 1, height: 1 }}>
            <text fg={COLORS.textDim}>empty</text>
          </box>
        ) : (
          issues.map((issue, idx) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              isSelected={isActiveColumn && idx === selectedRow}
              onSelect={() => onSelectCard(idx)}
              cardId={makeIssueCardId(issue.id)}
            />
          ))
        )}
      </scrollbox>
    </box>
  );
}

function Footer() {
  return (
    <box
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
        backgroundColor: COLORS.headerBg,
      }}
    >
      <text>
        <span fg={COLORS.textDim}>←→ / h l</span>
        <span fg={COLORS.text}> col </span>
        <span fg={COLORS.textDim}>↑↓ / j k</span>
        <span fg={COLORS.text}> card </span>
        <span fg={COLORS.textDim}>g / G</span>
        <span fg={COLORS.text}> jump </span>
        <span fg={COLORS.textDim}>Ctrl-u/d</span>
        <span fg={COLORS.text}> half page </span>
        <span fg={COLORS.textDim}>click</span>
        <span fg={COLORS.text}> select </span>
        <span fg={COLORS.textDim}>Enter</span>
        <span fg={COLORS.text}> detail </span>
        <span fg={COLORS.textDim}>m/M</span>
        <span fg={COLORS.text}> move </span>
        <span fg={COLORS.textDim}>b/B</span>
        <span fg={COLORS.text}> defer/promote </span>
        <span fg={COLORS.textDim}>/</span>
        <span fg={COLORS.text}> search </span>
        <span fg={COLORS.textDim}>n</span>
        <span fg={COLORS.text}> create via agent </span>
        <span fg={COLORS.textDim}>s</span>
        <span fg={COLORS.text}> sort col </span>
        <span fg={COLORS.textDim}>d</span>
        <span fg={COLORS.text}> close </span>
        <span fg={COLORS.textDim}>r</span>
        <span fg={COLORS.text}> refresh </span>
        <span fg={COLORS.textDim}>q</span>
        <span fg={COLORS.text}> quit</span>
      </text>
    </box>
  );
}

// -- Main App ----------------------------------------------------------------

function KanbanApp({ renderer }: { renderer: Awaited<ReturnType<typeof createCliRenderer>> }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [cursor, setCursor] = useState<CursorPos>({ col: 0, row: 0 });
  const [statusMsg, setStatusMsg] = useState("loading…");
  const [columnSortModes, setColumnSortModes] = useState<Record<string, ColumnSortMode>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const overlayRef = useRef(false);

  const filteredIssues = filterIssues(issues, searchQuery);
  const buckets = bucketIssues(filteredIssues, columnSortModes);

  // -- Data refresh ----------------------------------------------------------

  const refresh = useCallback(async () => {
    const allIssues = await fetchAllIssues();
    setIssues(allIssues);
    setStatusMsg("");
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Clamp cursor when issues change
  useEffect(() => {
    setCursor((prev) => clampCursor(prev, buckets));
  }, [buckets]);

  // Keep selected card in view when navigating with keyboard/mouse.
  useEffect(() => {
    const col = COLUMNS[cursor.col];
    if (!col) return;

    const items = buckets.get(col.key) ?? [];
    const selectedIssue = items[cursor.row];
    if (!selectedIssue) return;

    const scrollbox = renderer.root.getRenderable(makeColumnScrollboxId(col.key));
    if (!scrollbox) return;

    const maybeScrollbox = scrollbox as unknown as {
      scrollChildIntoView?: (childId: string) => void;
    };
    maybeScrollbox.scrollChildIntoView?.(makeIssueCardId(selectedIssue.id));
  }, [buckets, cursor, renderer]);

  // -- Helpers ---------------------------------------------------------------

  const getSelectedIssue = useCallback((): Issue | null => {
    const colKey = COLUMNS[cursor.col]?.key;
    if (!colKey) return null;
    const items = buckets.get(colKey) ?? [];
    return items[cursor.row] ?? null;
  }, [cursor, buckets]);

  const handleSelectColumn = useCallback(
    (colIdx: number) => {
      setCursor((prev) => {
        const colKey = COLUMNS[colIdx]?.key;
        if (!colKey) return prev;
        const items = buckets.get(colKey) ?? [];
        const row = items.length > 0 ? Math.min(prev.row, items.length - 1) : 0;
        return { col: colIdx, row };
      });
    },
    [buckets],
  );

  const handleSelectCard = useCallback(
    (colIdx: number, rowIdx: number) => {
      setCursor((prev) => {
        const colKey = COLUMNS[colIdx]?.key;
        if (!colKey) return prev;
        const items = buckets.get(colKey) ?? [];
        const row = items.length > 0 ? Math.max(0, Math.min(rowIdx, items.length - 1)) : 0;
        return { col: colIdx, row };
      });
    },
    [buckets],
  );

  // -- Actions ---------------------------------------------------------------

  const handleMoveForward = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    const currentIdx = STATUS_ORDER.indexOf(issue.status);
    if (currentIdx < 0 || currentIdx >= STATUS_ORDER.length - 1) {
      setStatusMsg("already at last status");
      return;
    }
    const nextStatus = STATUS_ORDER[currentIdx + 1]!;
    setStatusMsg(`moving ${issue.id} → ${nextStatus}…`);
    const ok = await moveIssueStatus(issue.id, nextStatus);
    if (ok) {
      setStatusMsg(`moved ${issue.id} → ${nextStatus}`);
      await refresh();
    } else {
      setStatusMsg(`failed to move ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handleMoveBackward = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    const currentIdx = STATUS_ORDER.indexOf(issue.status);
    if (currentIdx <= 0) {
      setStatusMsg("already at first status");
      return;
    }
    const prevStatus = STATUS_ORDER[currentIdx - 1]!;
    setStatusMsg(`moving ${issue.id} → ${prevStatus}…`);
    const ok = await moveIssueStatus(issue.id, prevStatus);
    if (ok) {
      setStatusMsg(`moved ${issue.id} → ${prevStatus}`);
      await refresh();
    } else {
      setStatusMsg(`failed to move ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handleClose = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    setStatusMsg(`closing ${issue.id}…`);
    const ok = await closeIssue(issue.id);
    if (ok) {
      setStatusMsg(`closed ${issue.id}`);
      await refresh();
    } else {
      setStatusMsg(`failed to close ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handleSendToBacklog = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    if (issue.status === "deferred") {
      setStatusMsg(`${issue.id} is already deferred`);
      return;
    }
    setStatusMsg(`deferring ${issue.id}…`);
    const ok = await moveIssueStatus(issue.id, "deferred");
    if (ok) {
      setStatusMsg(`deferred ${issue.id}`);
      await refresh();
    } else {
      setStatusMsg(`failed to defer ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handlePromoteFromBacklog = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    if (issue.status !== "deferred") {
      setStatusMsg(`${issue.id} is not deferred`);
      return;
    }
    setStatusMsg(`promoting ${issue.id} → open…`);
    const ok = await moveIssueStatus(issue.id, "open");
    if (ok) {
      setStatusMsg(`promoted ${issue.id} → open`);
      await refresh();
    } else {
      setStatusMsg(`failed to promote ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handleShowDetail = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    overlayRef.current = true;
    const overlay = new IssueDetailOverlay(renderer);
    overlay.onClose(() => {
      overlayRef.current = false;
    });
    await overlay.show(issue.id);
  }, [getSelectedIssue, renderer]);

  const handleShowCreateGuidance = useCallback(() => {
    overlayRef.current = true;
    const dialog = new NewIssueDialog(renderer);
    dialog.onClose(() => {
      overlayRef.current = false;
    });
    dialog.show();
  }, [renderer]);

  const getActiveColumnScrollbox = useCallback((): ScrollBoxRenderableAPI | null => {
    const col = COLUMNS[cursor.col];
    if (!col) return null;
    return (
      (renderer.root.getRenderable(makeColumnScrollboxId(col.key)) as
        | ScrollBoxRenderableAPI
        | null
        | undefined) ?? null
    );
  }, [cursor.col, renderer]);

  const moveActiveColumnRows = useCallback(
    (rowDelta: number): void => {
      setCursor((prev) => {
        const colKey = COLUMNS[prev.col]?.key;
        if (!colKey) return prev;

        const items = buckets.get(colKey) ?? [];
        if (items.length === 0) {
          return { ...prev, row: 0 };
        }

        const scrollbox = getActiveColumnScrollbox();
        const viewportHeight = scrollbox?.viewport?.height ?? items.length;
        const halfPage = Math.max(1, Math.floor(viewportHeight / 2));
        const nextRow = Math.max(0, Math.min(prev.row + rowDelta * halfPage, items.length - 1));

        return { ...prev, row: nextRow };
      });
    },
    [buckets, getActiveColumnScrollbox],
  );

  const moveActiveColumnToRow = useCallback(
    (row: number): void => {
      setCursor((prev) => {
        const colKey = COLUMNS[prev.col]?.key;
        if (!colKey) return prev;

        const items = buckets.get(colKey) ?? [];
        if (items.length === 0) {
          return { ...prev, row: 0 };
        }

        const clamped = Math.max(0, Math.min(row, items.length - 1));
        return { ...prev, row: clamped };
      });
    },
    [buckets],
  );

  // -- Keyboard --------------------------------------------------------------

  useKeyboard((key) => {
    // Don't handle keys when an overlay is active
    if (overlayRef.current) return;

    if (searchMode) {
      switch (key.name) {
        case "escape":
        case "return":
        case "enter":
          setSearchMode(false);
          break;

        case "backspace":
          setSearchQuery((prev) => prev.slice(0, -1));
          break;

        default: {
          if (key.ctrl || key.meta || key.option) break;
          if (key.sequence.length === 1) {
            setSearchQuery((prev) => `${prev}${key.sequence}`);
          }
          break;
        }
      }
      return;
    }

    switch (key.name) {
      case "q":
        renderer.destroy();
        process.exit(0);
        break;

      case "r":
        setStatusMsg("refreshing…");
        refresh();
        break;

      case "/":
        setSearchMode(true);
        setSearchQuery("");
        setStatusMsg("");
        break;

      case "escape":
        if (searchQuery.trim()) {
          setSearchQuery("");
          setStatusMsg("search cleared");
        }
        break;

      case "s": {
        const col = COLUMNS[cursor.col];
        if (!col) break;

        const currentMode = columnSortModes[col.key] ?? "default";
        const nextMode: ColumnSortMode = currentMode === "default" ? "priority" : "default";

        setColumnSortModes((prev) => ({ ...prev, [col.key]: nextMode }));

        if (nextMode === "priority") {
          setStatusMsg(`${col.label} sorted by priority (P0→P4)`);
        } else if (col.key === "closed") {
          setStatusMsg("Closed sorted by newest → oldest");
        } else {
          setStatusMsg(`${col.label} using default order`);
        }
        break;
      }

      case "left":
      case "h":
        setCursor((prev) => {
          const newCol = Math.max(0, prev.col - 1);
          const colKey = COLUMNS[newCol]!.key;
          const items = buckets.get(colKey) ?? [];
          const row = items.length > 0 ? Math.min(prev.row, items.length - 1) : 0;
          return { col: newCol, row };
        });
        break;

      case "right":
      case "l":
        setCursor((prev) => {
          const newCol = Math.min(COLUMNS.length - 1, prev.col + 1);
          const colKey = COLUMNS[newCol]!.key;
          const items = buckets.get(colKey) ?? [];
          const row = items.length > 0 ? Math.min(prev.row, items.length - 1) : 0;
          return { col: newCol, row };
        });
        break;

      case "up":
      case "k":
        setCursor((prev) => ({
          ...prev,
          row: Math.max(0, prev.row - 1),
        }));
        break;

      case "down":
      case "j":
        setCursor((prev) => {
          const colKey = COLUMNS[prev.col]!.key;
          const items = buckets.get(colKey) ?? [];
          return {
            ...prev,
            row: Math.min(items.length - 1, prev.row + 1),
          };
        });
        break;

      case "g":
        if (key.shift) {
          moveActiveColumnToRow(Number.POSITIVE_INFINITY);
        } else {
          moveActiveColumnToRow(0);
        }
        break;

      case "u":
        if (key.ctrl) {
          moveActiveColumnRows(-1);
        }
        break;

      case "d":
        if (key.ctrl) {
          moveActiveColumnRows(1);
        } else {
          handleClose();
        }
        break;

      case "return":
      case "enter":
        handleShowDetail();
        break;

      case "m":
        if (key.shift) {
          handleMoveBackward();
        } else {
          handleMoveForward();
        }
        break;

      case "M":
        handleMoveBackward();
        break;

      case "b":
        if (key.shift) {
          handlePromoteFromBacklog();
        } else {
          handleSendToBacklog();
        }
        break;

      case "B":
        handlePromoteFromBacklog();
        break;

      case "n":
        handleShowCreateGuidance();
        break;
    }
  });

  const headerStatus = searchMode
    ? `search: ${searchQuery}`
    : statusMsg ||
      (searchQuery.trim()
        ? `filter: ${searchQuery} (${filteredIssues.length}/${issues.length})`
        : "");

  // -- Render ----------------------------------------------------------------

  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        backgroundColor: COLORS.bg,
      }}
    >
      <Header issueCount={filteredIssues.length} status={headerStatus} />

      {/* Kanban columns */}
      <box
        style={{
          flexDirection: "row",
          flexGrow: 1,
          gap: 0,
        }}
      >
        {COLUMNS.map((col, colIdx) => {
          const items = buckets.get(col.key) ?? [];
          return (
            <KanbanColumn
              key={col.key}
              label={col.label}
              color={col.color}
              issues={items}
              selectedRow={cursor.row}
              isActiveColumn={cursor.col === colIdx}
              columnKey={col.key}
              onSelectColumn={() => handleSelectColumn(colIdx)}
              onSelectCard={(row) => handleSelectCard(colIdx, row)}
            />
          );
        })}
      </box>

      <Footer />
    </box>
  );
}

// -- Entry point -------------------------------------------------------------

export async function launchKanban(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
  });

  const cleanup = () => {
    renderer.destroy();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  createRoot(renderer).render(<KanbanApp renderer={renderer} />);
}
