// ---------------------------------------------------------------------------
// TUI Kanban Board — issue management view using OpenTUI React
//
// Five-column kanban layout (Open, In Progress, Review, Closed, Deferred).
// Arrow keys to navigate cards, Enter for details, m/M to move status,
// b to send to backlog (deferred), B to promote from backlog to open,
// n to create new issue, d to close/delete.
//
// Data: Tries live orchestrator API first (via OrchestratorClient), falls
// back to bd list --all --json if the orchestrator is not running.
// Live mode shows running/retrying status, token counts, and elapsed time.
// ---------------------------------------------------------------------------

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useState, useEffect, useCallback, useRef } from "react";
import { exec } from "../exec.ts";
import { IssueDetailOverlay } from "./issue-detail-overlay.ts";
import { NewIssueDialog } from "./new-issue-dialog.ts";
import { OrchestratorClient } from "./live-client.ts";
import type { OrchestratorSnapshot } from "../orchestrator.ts";

// -- Types -------------------------------------------------------------------

interface Issue {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  issue_type: string;
  owner: string | null;
  // Live orchestrator data (when connected)
  liveStatus?: "running" | "retrying" | null;
  elapsed_ms?: number;
  tokens?: { input: number; output: number; cache_read: number; cache_write: number; total: number; cost: number };
  attempt?: number;
  lastEvent?: string | null;
  retryDueAt?: string;
}

/** Connection mode — live orchestrator or static bd data. */
type DataSource = "live" | "static";

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
    }));
  } catch {
    return [];
  }
}

/**
 * Enrich issue list with live orchestrator data.
 * Marks issues as running/retrying and attaches token/elapsed info.
 */
function enrichWithLiveData(
  issues: Issue[],
  snapshot: OrchestratorSnapshot,
): Issue[] {
  // Build lookup maps from snapshot
  const runningMap = new Map<string, OrchestratorSnapshot["running"][number]>();
  for (const r of snapshot.running) {
    runningMap.set(r.issue_id, r);
    runningMap.set(r.issue_identifier, r);
  }

  const retryMap = new Map<string, OrchestratorSnapshot["retrying"][number]>();
  for (const r of snapshot.retrying) {
    retryMap.set(r.issue_id, r);
    retryMap.set(r.identifier, r);
  }

  return issues.map((issue) => {
    const running = runningMap.get(issue.id);
    if (running) {
      return {
        ...issue,
        liveStatus: "running" as const,
        elapsed_ms: running.elapsed_ms,
        tokens: running.tokens,
        attempt: running.attempt,
        lastEvent: running.last_event,
      };
    }

    const retrying = retryMap.get(issue.id);
    if (retrying) {
      return {
        ...issue,
        liveStatus: "retrying" as const,
        attempt: retrying.attempt,
        retryDueAt: retrying.due_at,
      };
    }

    return issue;
  });
}

async function moveIssueStatus(
  issueId: string,
  newStatus: string,
): Promise<boolean> {
  try {
    const result = await exec(
      ["bd", "update", issueId, "--status", newStatus],
      { cwd: process.cwd(), timeout: 10000 },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

async function closeIssue(issueId: string): Promise<boolean> {
  try {
    const result = await exec(
      ["bd", "close", issueId, "--reason", "Closed from TUI"],
      { cwd: process.cwd(), timeout: 10000 },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

// -- Helpers -----------------------------------------------------------------

function truncStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function bucketIssues(issues: Issue[]): Map<string, Issue[]> {
  const buckets = new Map<string, Issue[]>();
  for (const col of COLUMNS) {
    buckets.set(col.key, []);
  }
  for (const issue of issues) {
    const key = STATUS_ORDER.includes(issue.status) ? issue.status : "open";
    buckets.get(key)!.push(issue);
  }
  return buckets;
}

function clampCursor(
  cursor: CursorPos,
  buckets: Map<string, Issue[]>,
): CursorPos {
  const col = Math.max(0, Math.min(cursor.col, COLUMNS.length - 1));
  const colKey = COLUMNS[col]!.key;
  const items = buckets.get(colKey) ?? [];
  const row =
    items.length > 0
      ? Math.max(0, Math.min(cursor.row, items.length - 1))
      : 0;
  return { col, row };
}

// -- Components --------------------------------------------------------------

function Header({
  issueCount,
  status,
  dataSource,
  liveStats,
}: {
  issueCount: number;
  status: string;
  dataSource: DataSource;
  liveStats: { running: number; retrying: number; tokens: number } | null;
}) {
  const isLive = dataSource === "live";
  const connIndicator = isLive ? "● LIVE" : "○ STATIC";
  const connColor = isLive ? COLORS.green : COLORS.textDim;

  // Build live stats string
  let statsStr = "";
  if (liveStats) {
    const parts: string[] = [];
    if (liveStats.running > 0) parts.push(`${liveStats.running} running`);
    if (liveStats.retrying > 0) parts.push(`${liveStats.retrying} retrying`);
    if (liveStats.tokens > 0) parts.push(`${fmtTokens(liveStats.tokens)} tok`);
    if (parts.length > 0) statsStr = ` · ${parts.join(" · ")}`;
  }

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
      <text>
        <span fg={connColor}>{connIndicator}</span>
        {status ? <span fg={COLORS.yellow}>  {status}</span> : null}
      </text>
    </box>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function fmtElapsed(ms: number): string {
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

function LiveStatusBadge({ issue }: { issue: Issue }) {
  if (issue.liveStatus === "running") {
    const elapsed = issue.elapsed_ms ? fmtElapsed(issue.elapsed_ms) : "";
    const tok =
      issue.tokens && issue.tokens.total > 0
        ? ` ${fmtTokens(issue.tokens.total)}t`
        : "";
    return (
      <text>
        <span fg={COLORS.green}>▶ </span>
        <span fg={COLORS.textDim}>
          {elapsed}
          {tok}
        </span>
      </text>
    );
  }
  if (issue.liveStatus === "retrying") {
    const attemptStr = issue.attempt ? `#${issue.attempt}` : "";
    return (
      <text>
        <span fg={COLORS.yellow}>⟳ retry </span>
        <span fg={COLORS.textDim}>{attemptStr}</span>
      </text>
    );
  }
  return null;
}

function IssueCard({
  issue,
  isSelected,
  maxWidth,
}: {
  issue: Issue;
  isSelected: boolean;
  maxWidth: number;
}) {
  const hasLiveStatus = issue.liveStatus === "running" || issue.liveStatus === "retrying";
  const borderColor = isSelected
    ? COLORS.borderHighlight
    : hasLiveStatus
      ? issue.liveStatus === "running"
        ? COLORS.green
        : COLORS.yellow
      : COLORS.border;
  const bgColor = isSelected ? COLORS.surface : COLORS.bg;
  const titleMaxLen = Math.max(8, maxWidth - 6);
  const assignee = issue.owner
    ? truncStr(issue.owner.replace(/^agent@/, "@"), 16)
    : "";

  return (
    <box
      style={{
        flexDirection: "column",
        borderStyle: "rounded",
        border: true,
        borderColor,
        backgroundColor: bgColor,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
        height: hasLiveStatus ? 5 : 4,
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
      <text fg={COLORS.text}>{truncStr(issue.title, titleMaxLen)}</text>
      {hasLiveStatus ? (
        <LiveStatusBadge issue={issue} />
      ) : null}
      {assignee ? (
        <text fg={COLORS.textDim}>{assignee}</text>
      ) : (
        <text fg={COLORS.textDim}>—</text>
      )}
    </box>
  );
}

function KanbanColumn({
  label,
  color,
  issues,
  selectedRow,
  isActiveColumn,
}: {
  label: string;
  color: string;
  issues: Issue[];
  selectedRow: number;
  isActiveColumn: boolean;
}) {
  const headerBorderColor = isActiveColumn ? color : COLORS.border;

  return (
    <box
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
              maxWidth={30}
            />
          ))
        )}
      </scrollbox>
    </box>
  );
}

function Footer({ statusMsg, isLive }: { statusMsg: string; isLive: boolean }) {
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
        <span fg={COLORS.textDim}>←→</span>
        <span fg={COLORS.text}> col </span>
        <span fg={COLORS.textDim}>↑↓</span>
        <span fg={COLORS.text}> card </span>
        <span fg={COLORS.textDim}>Enter</span>
        <span fg={COLORS.text}> detail </span>
        <span fg={COLORS.textDim}>m/M</span>
        <span fg={COLORS.text}> move </span>
        <span fg={COLORS.textDim}>b/B</span>
        <span fg={COLORS.text}> defer/promote </span>
        <span fg={COLORS.textDim}>n</span>
        <span fg={COLORS.text}> new </span>
        <span fg={COLORS.textDim}>d</span>
        <span fg={COLORS.text}> close </span>
        <span fg={COLORS.textDim}>r</span>
        <span fg={COLORS.text}>{isLive ? " poll " : " refresh "}</span>
        <span fg={COLORS.textDim}>q</span>
        <span fg={COLORS.text}> quit</span>
      </text>
      {statusMsg ? <text fg={COLORS.yellow}>{statusMsg}</text> : null}
    </box>
  );
}

// -- Main App ----------------------------------------------------------------

function KanbanApp({
  renderer,
}: {
  renderer: Awaited<ReturnType<typeof createCliRenderer>>;
}) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [cursor, setCursor] = useState<CursorPos>({ col: 0, row: 0 });
  const [statusMsg, setStatusMsg] = useState("loading…");
  const [overlayActive, setOverlayActive] = useState(false);
  const overlayRef = useRef(false);
  const [dataSource, setDataSource] = useState<DataSource>("static");
  const [liveStats, setLiveStats] = useState<{
    running: number;
    retrying: number;
    tokens: number;
  } | null>(null);

  // Persistent client instance (survives re-renders)
  const clientRef = useRef<OrchestratorClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new OrchestratorClient();
  }
  const client = clientRef.current;

  const buckets = bucketIssues(issues);

  // -- Data refresh ----------------------------------------------------------

  const refresh = useCallback(async () => {
    // Always fetch the full issue list from bd (the kanban needs all issues)
    const allIssues = await fetchAllIssues();

    // Try to get live orchestrator data
    const snapshot = await client.fetchLiveState();

    if (snapshot) {
      // Enrich issues with live running/retrying status
      const enriched = enrichWithLiveData(allIssues, snapshot);
      setIssues(enriched);
      setDataSource("live");
      setLiveStats({
        running: snapshot.counts.running,
        retrying: snapshot.counts.retrying,
        tokens: snapshot.totals.total_tokens,
      });
    } else {
      setIssues(allIssues);
      setDataSource("static");
      setLiveStats(null);
    }

    setStatusMsg("");
  }, [client]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Clamp cursor when issues change
  useEffect(() => {
    setCursor((prev) => clampCursor(prev, buckets));
  }, [issues]);

  // -- Helpers ---------------------------------------------------------------

  const getSelectedIssue = useCallback((): Issue | null => {
    const colKey = COLUMNS[cursor.col]?.key;
    if (!colKey) return null;
    const items = buckets.get(colKey) ?? [];
    return items[cursor.row] ?? null;
  }, [cursor, buckets]);

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
    overlayRef.current = true; setOverlayActive(true);
    const overlay = new IssueDetailOverlay(renderer);
    overlay.onClose(() => {
      // Delay ref reset so the same Esc keypress doesn't also exit the app
      setTimeout(() => { overlayRef.current = false; setOverlayActive(false); }, 50);
    });
    // Pass the discovered API base so the overlay can fetch agent session data
    const apiBase = client.getApiBase() ?? undefined;
    await overlay.show(issue.id, apiBase);
  }, [getSelectedIssue, renderer, client]);

  const handleNewIssue = useCallback(() => {
    overlayRef.current = true; setOverlayActive(true);
    const dialog = new NewIssueDialog(renderer);
    dialog.onClose(() => {
      setTimeout(() => { overlayRef.current = false; setOverlayActive(false); }, 50);
    });
    dialog.onCreated(() => {
      refresh();
    });
    dialog.show();
  }, [renderer, refresh]);

  // -- Keyboard --------------------------------------------------------------

  useKeyboard((key) => {
    // Don't handle keys when an overlay is active
    if (overlayRef.current) return;

    switch (key.name) {
      case "q":
        renderer.destroy(); process.exit(0);
        break;

      case "r":
        setStatusMsg("refreshing…");
        // If live, trigger an immediate orchestrator poll cycle first
        if (dataSource === "live") {
          client.triggerRefresh().then(() => refresh());
        } else {
          refresh();
        }
        break;

      case "left":
        setCursor((prev) => {
          const newCol = Math.max(0, prev.col - 1);
          const colKey = COLUMNS[newCol]!.key;
          const items = buckets.get(colKey) ?? [];
          const row =
            items.length > 0
              ? Math.min(prev.row, items.length - 1)
              : 0;
          return { col: newCol, row };
        });
        break;

      case "right":
        setCursor((prev) => {
          const newCol = Math.min(COLUMNS.length - 1, prev.col + 1);
          const colKey = COLUMNS[newCol]!.key;
          const items = buckets.get(colKey) ?? [];
          const row =
            items.length > 0
              ? Math.min(prev.row, items.length - 1)
              : 0;
          return { col: newCol, row };
        });
        break;

      case "up":
        setCursor((prev) => ({
          ...prev,
          row: Math.max(0, prev.row - 1),
        }));
        break;

      case "down":
        setCursor((prev) => {
          const colKey = COLUMNS[prev.col]!.key;
          const items = buckets.get(colKey) ?? [];
          return {
            ...prev,
            row: Math.min(items.length - 1, prev.row + 1),
          };
        });
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
        handleNewIssue();
        break;

      case "d":
        handleClose();
        break;
    }
  });

  // -- Render ----------------------------------------------------------------

  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        backgroundColor: COLORS.bg,
      }}
    >
      <Header
        issueCount={issues.length}
        status={statusMsg}
        dataSource={dataSource}
        liveStats={liveStats}
      />

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
            />
          );
        })}
      </box>

      <Footer statusMsg={statusMsg} isLive={dataSource === "live"} />
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
