// ---------------------------------------------------------------------------
// TUI Dashboard — live agent status view using OpenTUI React
//
// Polls orchestrator state via HTTP API (GET /api/v1/state) every 2 seconds
// and renders a terminal dashboard with running/retrying/review/completed info.
//
// Uses OrchestratorClient for auto-discovery of the API endpoint via
// .symphony.lock or WORKFLOW.md config. Falls back to `bd list --json`.
//
// Layout (flexbox column):
//   - Header: 'Symphony' + running/retrying/completed counts
//   - Running section: Box per agent with issue ID, title, elapsed, last event
//   - Retry section: issues waiting to retry with countdown
//   - Review section: issues in review status (waiting on human)
//   - Event log: ScrollBox with recent orchestrator events, newest first
//   - Footer: keybindings help
//
// Color coding: green=running, yellow=retrying, blue=review, gray=completed.
// ---------------------------------------------------------------------------

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useState, useEffect, useCallback, useRef } from "react";
import type { OrchestratorSnapshot } from "../orchestrator.ts";
import { OrchestratorClient } from "./live-client.ts";
import { exec } from "../exec.ts";

// -- Types -------------------------------------------------------------------

interface DashboardProps {
  client: OrchestratorClient;
  refreshMs?: number;
}

interface EventLogEntry {
  time: string;
  message: string;
  color: string;
}

interface ReviewItem {
  id: string;
  identifier: string;
  title: string;
}

interface StaticCounts {
  open: number;
  in_progress: number;
  review: number;
  closed: number;
}

// -- Color constants ---------------------------------------------------------

const COLORS = {
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  gray: "#8b949e",
  red: "#f85149",
  bg: "#0d1117",
  surface: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  textDim: "#8b949e",
  headerBg: "#1f2335",
  accent: "#7aa2f7",
} as const;

// -- Helpers -----------------------------------------------------------------

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatCountdown(dueAt: string): string {
  const ms = new Date(dueAt).getTime() - Date.now();
  if (ms <= 0) return "now";
  return formatElapsed(ms);
}

export function truncStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function timeStr(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

// -- Data fetching -----------------------------------------------------------

async function fetchReviewIssues(): Promise<ReviewItem[]> {
  try {
    const result = await exec(["bd", "list", "--json", "--status", "review"], {
      cwd: process.cwd(),
      timeout: 5000,
    });
    if (result.code !== 0 || !result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((issue: Record<string, unknown>) => ({
      id: String(issue["id"] ?? issue["identifier"] ?? ""),
      identifier: String(issue["identifier"] ?? issue["id"] ?? ""),
      title: String(issue["title"] ?? ""),
    }));
  } catch {
    return [];
  }
}

/** Fetch static issue counts from bd for static (no orchestrator) mode. */
async function fetchStaticCounts(): Promise<StaticCounts> {
  const empty: StaticCounts = { open: 0, in_progress: 0, review: 0, closed: 0 };
  try {
    const result = await exec(["bd", "list", "--all", "--json"], {
      cwd: process.cwd(),
      timeout: 5000,
    });
    if (result.code !== 0 || !result.stdout.trim()) return empty;
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return empty;
    const counts: StaticCounts = { ...empty };
    for (const issue of parsed) {
      const status = String(issue.status ?? "open");
      if (status === "open") counts.open++;
      else if (status === "in_progress") counts.in_progress++;
      else if (status === "review") counts.review++;
      else if (status === "closed") counts.closed++;
    }
    return counts;
  } catch {
    return empty;
  }
}

// -- Components --------------------------------------------------------------

function Header({
  snap,
  source,
}: {
  snap: OrchestratorSnapshot | null;
  source: "live" | "static" | "offline";
}) {
  const counts = snap?.counts ?? {
    running: 0,
    retrying: 0,
    completed: 0,
    claimed: 0,
  };

  const sourceLabel =
    source === "live" ? "● live" : source === "static" ? "○ static" : "✗ offline";
  const sourceColor =
    source === "live" ? COLORS.green : source === "static" ? COLORS.yellow : COLORS.red;

  const totalTokens = snap?.totals
    ? snap.totals.input_tokens + snap.totals.output_tokens
    : 0;

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
        <span fg={COLORS.textDim}> Dashboard </span>
        <span fg={sourceColor}>{sourceLabel}</span>
        {totalTokens > 0 ? (
          <span fg={COLORS.textDim}> · {formatTokens(totalTokens)} tok</span>
        ) : null}
      </text>
      <text>
        <span fg={COLORS.green}>● {counts.running} running</span>
        <span fg={COLORS.textDim}> │ </span>
        <span fg={COLORS.yellow}>◌ {counts.retrying} retrying</span>
        <span fg={COLORS.textDim}> │ </span>
        <span fg={COLORS.gray}>✓ {counts.completed} completed</span>
      </text>
    </box>
  );
}

function SectionTitle({
  title,
  color,
  count,
}: {
  title: string;
  color: string;
  count: number;
}) {
  return (
    <box style={{ paddingLeft: 1, height: 1 }}>
      <text>
        <span fg={color}>
          <strong>{title}</strong>
        </span>
        <span fg={COLORS.textDim}> ({count})</span>
      </text>
    </box>
  );
}

function RunningSection({
  snap,
  selectedId,
}: {
  snap: OrchestratorSnapshot | null;
  selectedId: string | null;
}) {
  const running = snap?.running ?? [];

  if (running.length === 0) {
    return (
      <box style={{ paddingLeft: 2, height: 1 }}>
        <text fg={COLORS.textDim}>No agents running</text>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column" }}>
      {running.map((r) => {
        const isSelected = selectedId === r.issue_id;
        return (
          <box
            key={r.issue_id}
            style={{
              flexDirection: "row",
              paddingLeft: 2,
              height: 2,
              borderStyle: "single",
              border: true,
              borderColor: isSelected ? COLORS.accent : COLORS.border,
              backgroundColor: isSelected ? COLORS.surface : COLORS.bg,
              marginLeft: 1,
              marginRight: 1,
            }}
          >
            <text>
              <span fg={isSelected ? COLORS.accent : COLORS.green}>
                {isSelected ? "▸ " : "▶ "}
              </span>
              <span fg={COLORS.blue}>{pad(r.issue_identifier, 22)}</span>
              <span fg={COLORS.text}>
                {pad(truncStr(r.title, 30), 32)}
              </span>
              <span fg={COLORS.textDim}>
                {pad(formatElapsed(r.elapsed_ms), 10)}
              </span>
              {r.tokens.total > 0 ? (
                <span fg={COLORS.accent}>{pad(formatTokens(r.tokens.input) + "/" + formatTokens(r.tokens.output), 14)}</span>
              ) : (
                <span fg={COLORS.textDim}>{pad("—", 14)}</span>
              )}
              <span fg={COLORS.yellow}>{r.last_event ?? "—"}</span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

function RetrySection({ snap }: { snap: OrchestratorSnapshot | null }) {
  const retrying = snap?.retrying ?? [];

  if (retrying.length === 0) {
    return (
      <box style={{ paddingLeft: 2, height: 1 }}>
        <text fg={COLORS.textDim}>No issues retrying</text>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column" }}>
      {retrying.map((r) => (
        <box key={r.issue_id} style={{ paddingLeft: 2, height: 1 }}>
          <text>
            <span fg={COLORS.yellow}>◌ </span>
            <span fg={COLORS.blue}>{pad(r.identifier, 22)}</span>
            <span fg={COLORS.textDim}>attempt {r.attempt}</span>
            <span fg={COLORS.textDim}> │ retry in </span>
            <span fg={COLORS.yellow}>{formatCountdown(r.due_at)}</span>
            {r.error ? (
              <span fg={COLORS.red}> │ {truncStr(r.error, 40)}</span>
            ) : null}
          </text>
        </box>
      ))}
    </box>
  );
}

function ReviewSection({ reviews }: { reviews: ReviewItem[] }) {
  if (reviews.length === 0) {
    return (
      <box style={{ paddingLeft: 2, height: 1 }}>
        <text fg={COLORS.textDim}>No issues in review</text>
      </box>
    );
  }

  return (
    <box style={{ flexDirection: "column" }}>
      {reviews.map((r) => (
        <box key={r.id} style={{ paddingLeft: 2, height: 1 }}>
          <text>
            <span fg={COLORS.blue}>◈ </span>
            <span fg={COLORS.blue}>{pad(r.identifier, 22)}</span>
            <span fg={COLORS.text}>{truncStr(r.title, 50)}</span>
          </text>
        </box>
      ))}
    </box>
  );
}

function EventLog({ events }: { events: EventLogEntry[] }) {
  return (
    <scrollbox
      style={{
        rootOptions: {
          flexGrow: 1,
          backgroundColor: COLORS.bg,
          borderStyle: "single" as const,
          border: true,
          borderColor: COLORS.border,
          marginLeft: 1,
          marginRight: 1,
        },
        wrapperOptions: { backgroundColor: COLORS.bg },
        viewportOptions: { backgroundColor: COLORS.bg },
        contentOptions: { backgroundColor: COLORS.bg },
        scrollbarOptions: {
          trackOptions: {
            foregroundColor: COLORS.border,
            backgroundColor: COLORS.bg,
          },
        },
      }}
      focused
    >
      {events.length === 0 ? (
        <box style={{ paddingLeft: 1 }}>
          <text fg={COLORS.textDim}>Waiting for events...</text>
        </box>
      ) : (
        events.map((ev, i) => (
          <box key={`${ev.time}-${i}`} style={{ paddingLeft: 1, height: 1 }}>
            <text>
              <span fg={COLORS.textDim}>{ev.time} </span>
              <span fg={ev.color}>{ev.message}</span>
            </text>
          </box>
        ))
      )}
    </scrollbox>
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
        <span fg={COLORS.textDim}>q</span>
        <span fg={COLORS.text}> quit </span>
        <span fg={COLORS.textDim}>r</span>
        <span fg={COLORS.text}> refresh </span>
        <span fg={COLORS.textDim}>↑↓</span>
        <span fg={COLORS.text}> scroll</span>
      </text>
      <text fg={COLORS.textDim}>auto-refresh 2s</text>
    </box>
  );
}

// -- Static mode summary (no orchestrator) -----------------------------------

function StaticSummary({
  reviews,
  counts,
  selectedId,
}: {
  reviews: ReviewItem[];
  counts: StaticCounts;
  selectedId: string | null;
}) {
  const total = counts.open + counts.in_progress + counts.review + counts.closed;
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ paddingLeft: 1, height: 2, flexDirection: "column" }}>
        <text fg={COLORS.yellow}>
          ◌ No live orchestrator — showing static issue data
        </text>
        <text fg={COLORS.textDim}>
          Start symphony with: symphony start --port 4500
        </text>
      </box>

      <SectionTitle title="Issue Summary" color={COLORS.accent} count={total} />
      <box style={{ paddingLeft: 2, height: 1 }}>
        <text>
          <span fg={COLORS.green}>● {counts.open} open</span>
          <span fg={COLORS.textDim}> │ </span>
          <span fg={COLORS.blue}>▶ {counts.in_progress} in progress</span>
          <span fg={COLORS.textDim}> │ </span>
          <span fg={COLORS.yellow}>◈ {counts.review} in review</span>
          <span fg={COLORS.textDim}> │ </span>
          <span fg={COLORS.gray}>✓ {counts.closed} closed</span>
        </text>
      </box>

      <SectionTitle title="Review" color={COLORS.blue} count={reviews.length} />
      <ReviewSection reviews={reviews} selectedId={selectedId} />
    </box>
  );
}

// -- Main App ----------------------------------------------------------------

/**
 * Build a flat list of selectable items from current dashboard state.
 * Order: running → retrying → review (matches visual layout).
 */
function buildSelectableItems(
  snap: OrchestratorSnapshot | null,
  reviews: ReviewItem[],
): SelectableItem[] {
  const items: SelectableItem[] = [];

  if (snap) {
    for (const r of snap.running) {
      items.push({ issueId: r.issue_id, section: "running" });
    }
    for (const r of snap.retrying) {
      items.push({ issueId: r.issue_id, section: "retrying" });
    }
  }

  for (const r of reviews) {
    items.push({ issueId: r.id, section: "review" });
  }

  return items;
}

function DashboardApp({ client, renderer, refreshMs = 2000 }: DashboardProps) {
  const [snap, setSnap] = useState<OrchestratorSnapshot | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [source, setSource] = useState<"live" | "static" | "offline">("offline");
  const [staticCounts, setStaticCounts] = useState<StaticCounts>({
    open: 0,
    in_progress: 0,
    review: 0,
    closed: 0,
  });

  // Selection cursor for navigating dashboard items
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [overlayActive, setOverlayActive] = useState(false);

  // Track which issue events we've already logged to avoid duplicates
  const seenEventsRef = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    const [dashState, reviewItems] = await Promise.all([
      client.fetchDashboard(),
      fetchReviewIssues(),
    ]);

    setReviews(reviewItems);

    if (dashState.source === "live") {
      const snapshot = dashState.snapshot;
      setSnap(snapshot);
      setSource("live");

      // Build event log entries from current state, dedup by issue+event
      const now = timeStr();
      const newEvents: EventLogEntry[] = [];
      const seen = seenEventsRef.current;

      for (const r of snapshot.running) {
        if (r.last_event) {
          const key = `${r.issue_identifier}:${r.last_event}:${r.last_message}`;
          if (!seen.has(r.issue_identifier) || seen.get(r.issue_identifier) !== key) {
            seen.set(r.issue_identifier, key);
            newEvents.push({
              time: now,
              message: `[${r.issue_identifier}] ${r.last_event}: ${truncStr(r.last_message, 60)}`,
              color: COLORS.green,
            });
          }
        }
      }

      for (const r of snapshot.retrying) {
        const key = `retry:${r.identifier}:${r.attempt}`;
        if (!seen.has(key)) {
          seen.set(key, key);
          newEvents.push({
            time: now,
            message: `[${r.identifier}] retry #${r.attempt}${r.error ? `: ${truncStr(r.error, 50)}` : ""}`,
            color: COLORS.yellow,
          });
        }
      }

      if (newEvents.length > 0) {
        setEvents((prev) => [...newEvents, ...prev].slice(0, 200));
      }
    } else {
      // Static fallback — no orchestrator running, show what we can from bd
      setSource("static");
      setSnap(null);
      const counts = await fetchStaticCounts();
      setStaticCounts(counts);
    }
  }, [client]);

  // Initial fetch + polling
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, refreshMs);
    return () => clearInterval(interval);
  }, [refresh, refreshMs]);

  // Build selectable items list
  const selectableItems = buildSelectableItems(snap, reviews);
  const hasItems = selectableItems.length > 0;

  // Clamp selection when items change
  useEffect(() => {
    setSelectedIndex((prev) =>
      selectableItems.length > 0
        ? Math.min(prev, selectableItems.length - 1)
        : 0,
    );
  }, [selectableItems.length]);

  // Get the currently selected item's issue ID (for highlighting)
  const selectedItem = hasItems ? selectableItems[selectedIndex] ?? null : null;
  const selectedIssueId = selectedItem?.issueId ?? null;

  // Show detail overlay for the selected item
  const handleShowDetail = useCallback(async () => {
    if (!selectedItem) return;
    setOverlayActive(true);
    const overlay = new IssueDetailOverlay(renderer);
    overlay.onClose(() => {
      setOverlayActive(false);
    });
    const apiBase = client.getApiBase() ?? undefined;
    await overlay.show(selectedItem.issueId, apiBase);
  }, [selectedItem, renderer, client]);

  // Keyboard handling
  useKeyboard((key) => {
    if (overlayActive) return;

    if (key.name === "q" || key.name === "escape") {
      process.exit(0);
    }
    if (key.name === "r") {
      // Manual refresh — also try to trigger orchestrator poll
      client.triggerRefresh().then(() => refresh());
    }
    if (key.name === "up" && hasItems) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    }
    if (key.name === "down" && hasItems) {
      setSelectedIndex((prev) =>
        Math.min(selectableItems.length - 1, prev + 1),
      );
    }
    if ((key.name === "return" || key.name === "enter") && hasItems) {
      handleShowDetail();
    }
  });

  // Static mode — no orchestrator running, show issue summary + reviews from bd
  if (source === "static" && !snap) {
    return (
      <box
        style={{
          flexDirection: "column",
          flexGrow: 1,
          backgroundColor: COLORS.bg,
        }}
      >
        <Header snap={null} source="static" />
        <StaticSummary reviews={reviews} selectedId={selectedIssueId} />
        <Footer hasItems={hasItems} />
      </box>
    );
  }

  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        backgroundColor: COLORS.bg,
      }}
    >
      <Header snap={snap} source={source} />

      <SectionTitle
        title="Running"
        color={COLORS.green}
        count={snap?.running.length ?? 0}
      />
      <RunningSection snap={snap} selectedId={selectedIssueId} />

      <SectionTitle
        title="Retrying"
        color={COLORS.yellow}
        count={snap?.retrying.length ?? 0}
      />
      <RetrySection snap={snap} selectedId={selectedIssueId} />

      <SectionTitle
        title="Review"
        color={COLORS.blue}
        count={reviews.length}
      />
      <ReviewSection reviews={reviews} selectedId={selectedIssueId} />

      <SectionTitle
        title="Event Log"
        color={COLORS.textDim}
        count={events.length}
      />
      <EventLog events={events} />

      <Footer hasItems={hasItems} />
    </box>
  );
}

// -- Entry point -------------------------------------------------------------

export async function launchDashboard(opts?: {
  projectDir?: string;
  refreshMs?: number;
}): Promise<void> {
  const client = new OrchestratorClient(opts?.projectDir ?? process.cwd());

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: true,
  });

  createRoot(renderer).render(
    <DashboardApp
      client={client}
      renderer={renderer}
      refreshMs={opts?.refreshMs ?? 2000}
    />,
  );
}
