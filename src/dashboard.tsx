// ---------------------------------------------------------------------------
// TUI Dashboard — live agent status view using OpenTUI
//
// Polls orchestrator state via HTTP API (GET /api/v1/state) every 2 seconds
// and renders a terminal dashboard with running/retrying/review/completed info.
//
// Usage: symphony dashboard --port <port> [--host <host>]
// ---------------------------------------------------------------------------

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useState, useEffect, useCallback } from "react";
import type { OrchestratorSnapshot } from "./orchestrator.ts";

// -- Types -------------------------------------------------------------------

interface DashboardProps {
  apiUrl: string;
  refreshMs?: number;
}

interface EventLogEntry {
  time: string;
  message: string;
}

interface ReviewItem {
  id: string;
  identifier: string;
  title: string;
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
};

// -- Helpers -----------------------------------------------------------------

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatCountdown(dueAt: string): string {
  const ms = new Date(dueAt).getTime() - Date.now();
  if (ms <= 0) return "now";
  return formatElapsed(ms);
}

function truncStr(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

// -- Data fetching -----------------------------------------------------------

async function fetchSnapshot(
  apiUrl: string,
): Promise<OrchestratorSnapshot | null> {
  try {
    const res = await fetch(`${apiUrl}/api/v1/state`);
    if (!res.ok) return null;
    return (await res.json()) as OrchestratorSnapshot;
  } catch {
    return null;
  }
}

async function fetchReviewIssues(): Promise<ReviewItem[]> {
  try {
    const proc = Bun.spawn(["bd", "list", "--json", "--status", "review"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    if (!text.trim()) return [];
    const parsed = JSON.parse(text);
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

// -- Components --------------------------------------------------------------

function Header({ snap }: { snap: OrchestratorSnapshot | null }) {
  const counts = snap?.counts ?? {
    running: 0,
    retrying: 0,
    completed: 0,
    claimed: 0,
  };

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
        <strong fg={COLORS.blue}>Symphony</strong>
        <span fg={COLORS.textDim}> Dashboard</span>
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

function RunningSection({ snap }: { snap: OrchestratorSnapshot | null }) {
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
      {running.map((r) => (
        <box key={r.issue_id} style={{ paddingLeft: 2, height: 1 }}>
          <text>
            <span fg={COLORS.green}>▶ </span>
            <span fg={COLORS.blue}>{pad(r.issue_identifier, 22)}</span>
            <span fg={COLORS.text}>
              {pad(truncStr(r.title, 30), 32)}
            </span>
            <span fg={COLORS.textDim}>
              {pad(formatElapsed(r.elapsed_ms), 10)}
            </span>
            <span fg={COLORS.yellow}>{r.last_event ?? "—"}</span>
          </text>
        </box>
      ))}
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
        rootOptions: { flexGrow: 1, backgroundColor: COLORS.bg },
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
        <box style={{ paddingLeft: 2 }}>
          <text fg={COLORS.textDim}>Waiting for events...</text>
        </box>
      ) : (
        events.map((ev, i) => (
          <box key={`${ev.time}-${i}`} style={{ paddingLeft: 2, height: 1 }}>
            <text>
              <span fg={COLORS.textDim}>{ev.time} </span>
              <span fg={COLORS.text}>{ev.message}</span>
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

// -- Main App ----------------------------------------------------------------

function App({ apiUrl, refreshMs = 2000 }: DashboardProps) {
  const [snap, setSnap] = useState<OrchestratorSnapshot | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [connError, setConnError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [snapshot, reviewItems] = await Promise.all([
      fetchSnapshot(apiUrl),
      fetchReviewIssues(),
    ]);

    if (snapshot) {
      setSnap(snapshot);
      setConnError(null);
      setReviews(reviewItems);

      // Build event log entries from current state
      const now = new Date();
      const timeStr = now.toLocaleTimeString("en-US", { hour12: false });
      const newEvents: EventLogEntry[] = [];

      for (const r of snapshot.running) {
        if (r.last_event) {
          newEvents.push({
            time: timeStr,
            message: `[${r.issue_identifier}] ${r.last_event}: ${truncStr(r.last_message, 60)}`,
          });
        }
      }

      for (const r of snapshot.retrying) {
        newEvents.push({
          time: timeStr,
          message: `[${r.identifier}] retry #${r.attempt}${r.error ? `: ${truncStr(r.error, 50)}` : ""}`,
        });
      }

      if (newEvents.length > 0) {
        setEvents((prev) => [...newEvents, ...prev].slice(0, 200));
      }
    } else {
      setConnError(`Cannot connect to ${apiUrl}`);
    }
  }, [apiUrl]);

  // Initial fetch + polling
  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, refreshMs);
    return () => clearInterval(interval);
  }, [refresh, refreshMs]);

  // Keyboard handling
  useKeyboard((key) => {
    if (key.name === "q" || key.name === "escape") {
      process.exit(0);
    }
    if (key.name === "r") {
      refresh();
    }
  });

  if (connError && !snap) {
    return (
      <box
        style={{
          flexDirection: "column",
          flexGrow: 1,
          backgroundColor: COLORS.bg,
        }}
      >
        <Header snap={null} />
        <box
          style={{
            flexGrow: 1,
            justifyContent: "center",
            alignItems: "center",
            flexDirection: "column",
          }}
        >
          <text fg={COLORS.red}>✗ {connError}</text>
          <text fg={COLORS.textDim}>
            Make sure symphony is running with --port flag
          </text>
        </box>
        <Footer />
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
      <Header snap={snap} />

      <SectionTitle
        title="Running"
        color={COLORS.green}
        count={snap?.running.length ?? 0}
      />
      <RunningSection snap={snap} />

      <SectionTitle
        title="Retrying"
        color={COLORS.yellow}
        count={snap?.retrying.length ?? 0}
      />
      <RetrySection snap={snap} />

      <SectionTitle
        title="Review"
        color={COLORS.blue}
        count={reviews.length}
      />
      <ReviewSection reviews={reviews} />

      <SectionTitle
        title="Event Log"
        color={COLORS.textDim}
        count={events.length}
      />
      <EventLog events={events} />

      <Footer />
    </box>
  );
}

// -- Entry point -------------------------------------------------------------

export async function startDashboard(opts: {
  port: number;
  host?: string;
  refreshMs?: number;
}): Promise<void> {
  const host = opts.host ?? "127.0.0.1";
  const apiUrl = `http://${host}:${opts.port}`;

  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  createRoot(renderer).render(
    <App apiUrl={apiUrl} refreshMs={opts.refreshMs ?? 2000} />,
  );
}
