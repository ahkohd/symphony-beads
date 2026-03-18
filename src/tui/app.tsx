// ---------------------------------------------------------------------------
// TUI Dashboard — live agent status view
//
// Layout (flexbox column):
//   - Header: 'Symphony' + running/retrying/completed counts
//   - Running section: Box per agent with issue ID, title, elapsed, last event
//   - Retry section: issues waiting to retry with countdown
//   - Review section: issues in review status
//   - Event log: ScrollBox with recent orchestrator events (newest first)
//   - Footer: keybindings help
//
// Data source: OrchestratorClient (polls /api/v1/state or falls back to bd)
// Auto-refresh: every 2 seconds
// ---------------------------------------------------------------------------

import {
  createCliRenderer,
  Box,
  Text,
  ScrollBox,
  type CliRenderer,
  type KeyEvent,
  type Renderable,
} from "@opentui/core";

import {
  OrchestratorClient,
  type DashboardState,
  type LiveDashboardState,
  type StaticDashboardState,
  type StaticIssue,
} from "./live-client.ts";

import type { OrchestratorSnapshot } from "../orchestrator.ts";

// -- Colors ------------------------------------------------------------------

const C = {
  bg: "#1a1b26",
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
  gray: "#565f89",
  blue: "#7aa2f7",
} as const;

// -- VNode child type --------------------------------------------------------
type VChild = ReturnType<typeof Box> | ReturnType<typeof Text> | null;

// -- Event log ---------------------------------------------------------------

interface EventLogEntry {
  timestamp: string;
  message: string;
  color: string;
}

// -- Dashboard ---------------------------------------------------------------

/**
 * Launch the interactive TUI dashboard.
 * Blocks until the user presses 'q' or Ctrl+C.
 */
export async function launchTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
    useMouse: false,
  });

  const dashboard = new Dashboard(renderer);
  await dashboard.start();

  return new Promise<void>((resolve) => {
    dashboard.onExit(() => {
      resolve();
    });
  });
}

class Dashboard {
  private renderer: CliRenderer;
  private client: OrchestratorClient;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private keyHandler: ((key: KeyEvent) => void) | null = null;
  private onExitCallback: (() => void) | null = null;
  private lastState: DashboardState | null = null;
  private eventLog: EventLogEntry[] = [];
  private isLive = false;
  private destroyed = false;

  constructor(renderer: CliRenderer) {
    this.renderer = renderer;
    this.client = new OrchestratorClient(process.cwd());
  }

  onExit(callback: () => void): void {
    this.onExitCallback = callback;
  }

  async start(): Promise<void> {
    this.installKeyHandler();
    await this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 2000);
  }

  private async refresh(): Promise<void> {
    if (this.destroyed) return;

    try {
      const state = await this.client.fetchDashboard();
      this.isLive = state.source === "live";

      // Diff events for the log
      if (state.source === "live") {
        this.diffEvents(state);
      }

      this.lastState = state;
      this.render();
    } catch {
      // On error, keep the last state and show an error indicator
      this.render();
    }
  }

  private diffEvents(newState: LiveDashboardState): void {
    const snap = newState.snapshot;
    const now = new Date().toLocaleTimeString();

    if (!this.lastState || this.lastState.source !== "live") {
      this.addEvent(now, "Connected to orchestrator", C.green);
      return;
    }

    const oldSnap = (this.lastState as LiveDashboardState).snapshot;

    // Check for newly running agents
    for (const r of snap.running) {
      const wasRunning = oldSnap.running.find(
        (o) => o.issue_id === r.issue_id,
      );
      if (!wasRunning) {
        this.addEvent(
          now,
          `▶ Started: ${r.issue_identifier} — ${truncate(r.title, 50)}`,
          C.green,
        );
      }
    }

    // Check for agents that stopped running
    for (const o of oldSnap.running) {
      const stillRunning = snap.running.find(
        (r) => r.issue_id === o.issue_id,
      );
      if (!stillRunning) {
        const inRetry = snap.retrying.find(
          (r) => r.issue_id === o.issue_id,
        );
        if (inRetry) {
          this.addEvent(
            now,
            `⟳ Retrying: ${o.issue_identifier} — ${inRetry.error ?? "continuation"}`,
            C.yellow,
          );
        } else {
          this.addEvent(
            now,
            `✓ Completed: ${o.issue_identifier}`,
            C.gray,
          );
        }
      }
    }

    // Check for new retries
    for (const r of snap.retrying) {
      const wasRetrying = oldSnap.retrying.find(
        (o) => o.issue_id === r.issue_id,
      );
      if (!wasRetrying) {
        const wasRunning = oldSnap.running.find(
          (o) => o.issue_id === r.issue_id,
        );
        if (!wasRunning) {
          this.addEvent(
            now,
            `⟳ Scheduled retry: ${r.identifier} (attempt ${r.attempt})`,
            C.yellow,
          );
        }
      }
    }
  }

  private addEvent(timestamp: string, message: string, color: string): void {
    this.eventLog.unshift({ timestamp, message, color });
    // Keep only the last 50 events
    if (this.eventLog.length > 50) {
      this.eventLog.length = 50;
    }
  }

  private render(): void {
    // Clear existing children from root
    const existingDashboard = this.renderer.root.getRenderable("dashboard-root");
    if (existingDashboard) {
      this.renderer.root.remove("dashboard-root");
    }

    const state = this.lastState;
    const children: VChild[] = [];

    // -- Header --
    children.push(this.buildHeader(state));

    // -- Separator --
    children.push(
      Text({ content: "─".repeat(80), fg: C.border }),
    );

    if (state?.source === "live") {
      const snap = state.snapshot;

      // -- Running section --
      children.push(this.buildRunningSection(snap));

      // -- Retry section --
      if (snap.retrying.length > 0) {
        children.push(this.buildRetrySection(snap));
      }
    } else if (state?.source === "static") {
      // -- Static: show issues by status --
      const reviewIssues = state.issues.filter(
        (i) => i.status === "review",
      );
      const activeIssues = state.issues.filter(
        (i) => i.status === "open" || i.status === "in_progress" || i.status === "todo",
      );
      const completedIssues = state.issues.filter(
        (i) => i.status === "done" || i.status === "closed",
      );

      if (activeIssues.length > 0) {
        children.push(this.buildStaticSection("Active Issues", activeIssues, C.green));
      }
      if (reviewIssues.length > 0) {
        children.push(this.buildStaticSection("In Review", reviewIssues, C.blue));
      }
      if (completedIssues.length > 0) {
        children.push(this.buildStaticSection("Completed", completedIssues, C.gray));
      }

      if (state.issues.length === 0) {
        children.push(
          Box(
            { flexDirection: "column", paddingLeft: 1, paddingY: 1 },
            Text({ content: "No issues found.", fg: C.textDim }),
          ),
        );
      }
    } else {
      // No data yet
      children.push(
        Box(
          { flexDirection: "column", paddingLeft: 1, paddingY: 1 },
          Text({ content: "Loading...", fg: C.textDim }),
        ),
      );
    }

    // -- Review section (live mode) --
    if (state?.source === "live") {
      // We can detect review from running entries whose state is "review"
      const reviewEntries = state.snapshot.running.filter(
        (r) => r.state === "review",
      );
      if (reviewEntries.length > 0) {
        children.push(this.buildReviewSection(reviewEntries));
      }
    }

    // -- Event Log section --
    children.push(this.buildEventLog());

    // -- Footer --
    children.push(this.buildFooter());

    // Filter out nulls
    const validChildren = children.filter(
      (c): c is NonNullable<VChild> => c != null,
    );

    const dashboard = Box(
      {
        id: "dashboard-root",
        width: "100%",
        height: "100%",
        backgroundColor: C.bg,
        flexDirection: "column",
      },
      ...validChildren,
    );

    this.renderer.root.add(dashboard);
  }

  // -- Section builders ------------------------------------------------------

  private buildHeader(state: DashboardState | null): VChild {
    let counts = { running: 0, retrying: 0, completed: 0 };
    if (state?.source === "live") {
      counts = {
        running: state.snapshot.counts.running,
        retrying: state.snapshot.counts.retrying,
        completed: state.snapshot.counts.completed,
      };
    } else if (state?.source === "static") {
      counts = {
        running: state.issues.filter((i) => i.status === "in_progress").length,
        retrying: 0,
        completed: state.issues.filter(
          (i) => i.status === "done" || i.status === "closed",
        ).length,
      };
    }

    const sourceIndicator = this.isLive
      ? "● LIVE"
      : "○ STATIC";
    const sourceColor = this.isLive ? C.green : C.yellow;

    return Box(
      {
        flexDirection: "row",
        paddingX: 1,
        paddingY: 1,
        gap: 2,
      },
      Text({ content: "♦ Symphony", fg: C.accent, attributes: 1 }),
      Text({ content: sourceIndicator, fg: sourceColor }),
      Text({
        content: `Running: ${counts.running}`,
        fg: C.green,
      }),
      Text({
        content: `Retrying: ${counts.retrying}`,
        fg: C.yellow,
      }),
      Text({
        content: `Completed: ${counts.completed}`,
        fg: C.gray,
      }),
    );
  }

  private buildRunningSection(snap: OrchestratorSnapshot): VChild {
    const sectionChildren: VChild[] = [
      Text({
        content: " ▸ Running Agents",
        fg: C.green,
        attributes: 1,
      }),
    ];

    if (snap.running.length === 0) {
      sectionChildren.push(
        Box(
          { paddingLeft: 3 },
          Text({ content: "No agents running", fg: C.textDim }),
        ),
      );
    } else {
      for (const agent of snap.running) {
        sectionChildren.push(this.buildAgentBox(agent));
      }
    }

    return Box(
      {
        flexDirection: "column",
        gap: 0,
        paddingY: 0,
      },
      ...sectionChildren.filter((c): c is NonNullable<VChild> => c != null),
    );
  }

  private buildAgentBox(
    agent: OrchestratorSnapshot["running"][number],
  ): VChild {
    const elapsed = formatDuration(agent.elapsed_ms);
    const tokens = `${fmtNum(agent.tokens.input)}↑ ${fmtNum(agent.tokens.output)}↓`;
    const lastEvent = agent.last_event ?? "—";
    const message = truncate(agent.last_message, 60);

    return Box(
      {
        flexDirection: "column",
        borderStyle: "rounded",
        border: true,
        borderColor: C.green,
        backgroundColor: C.surface,
        paddingX: 1,
        paddingY: 0,
        marginLeft: 2,
        marginRight: 2,
        marginTop: 0,
        marginBottom: 0,
      },
      // Row 1: ID, title, elapsed
      Box(
        { flexDirection: "row", gap: 2 },
        Text({ content: agent.issue_identifier, fg: C.accent, attributes: 1 }),
        Text({ content: truncate(agent.title, 40), fg: C.text, truncate: true }),
        Text({ content: elapsed, fg: C.cyan }),
        Text({ content: `#${agent.attempt}`, fg: C.textDim }),
      ),
      // Row 2: last event, message, tokens
      Box(
        { flexDirection: "row", gap: 2 },
        Text({ content: `Event: ${lastEvent}`, fg: C.yellow }),
        Text({ content: message, fg: C.textDim, truncate: true }),
        Text({ content: tokens, fg: C.textDim }),
      ),
    );
  }

  private buildRetrySection(snap: OrchestratorSnapshot): VChild {
    const sectionChildren: VChild[] = [
      Text({
        content: " ⟳ Retrying",
        fg: C.yellow,
        attributes: 1,
      }),
    ];

    const now = Date.now();

    for (const retry of snap.retrying) {
      const dueAt = new Date(retry.due_at).getTime();
      const remainingMs = Math.max(0, dueAt - now);
      const countdown = formatDuration(remainingMs);
      const errorMsg = retry.error
        ? truncate(retry.error, 50)
        : "continuation";

      sectionChildren.push(
        Box(
          {
            flexDirection: "row",
            gap: 2,
            paddingLeft: 3,
          },
          Text({ content: "⏳", fg: C.yellow }),
          Text({ content: retry.identifier, fg: C.accent }),
          Text({ content: `in ${countdown}`, fg: C.yellow }),
          Text({ content: `attempt ${retry.attempt}`, fg: C.textDim }),
          Text({ content: errorMsg, fg: C.textDim, truncate: true }),
        ),
      );
    }

    return Box(
      {
        flexDirection: "column",
        gap: 0,
        paddingY: 0,
      },
      ...sectionChildren.filter((c): c is NonNullable<VChild> => c != null),
    );
  }

  private buildReviewSection(
    entries: OrchestratorSnapshot["running"],
  ): VChild {
    const sectionChildren: VChild[] = [
      Text({
        content: " ◉ In Review",
        fg: C.blue,
        attributes: 1,
      }),
    ];

    for (const entry of entries) {
      sectionChildren.push(
        Box(
          {
            flexDirection: "row",
            gap: 2,
            paddingLeft: 3,
          },
          Text({ content: "⦿", fg: C.blue }),
          Text({ content: entry.issue_identifier, fg: C.accent }),
          Text({
            content: truncate(entry.title, 50),
            fg: C.text,
            truncate: true,
          }),
          Text({
            content: "waiting on human",
            fg: C.textDim,
          }),
        ),
      );
    }

    return Box(
      {
        flexDirection: "column",
        gap: 0,
        paddingY: 0,
      },
      ...sectionChildren.filter((c): c is NonNullable<VChild> => c != null),
    );
  }

  private buildStaticSection(
    title: string,
    issues: StaticIssue[],
    color: string,
  ): VChild {
    const sectionChildren: VChild[] = [
      Text({
        content: ` ▸ ${title} (${issues.length})`,
        fg: color,
        attributes: 1,
      }),
    ];

    for (const issue of issues) {
      const priority =
        issue.priority !== null ? `P${issue.priority}` : "P—";

      sectionChildren.push(
        Box(
          {
            flexDirection: "row",
            gap: 2,
            paddingLeft: 3,
          },
          Text({ content: "●", fg: color }),
          Text({ content: issue.identifier || issue.id, fg: C.accent }),
          Text({ content: priority, fg: C.textDim }),
          Text({
            content: truncate(issue.title, 50),
            fg: C.text,
            truncate: true,
          }),
          Text({
            content: issue.status,
            fg: color,
          }),
        ),
      );
    }

    return Box(
      {
        flexDirection: "column",
        gap: 0,
        paddingY: 0,
      },
      ...sectionChildren.filter((c): c is NonNullable<VChild> => c != null),
    );
  }

  private buildEventLog(): VChild {
    const logChildren: VChild[] = [
      Text({
        content: " ▾ Event Log",
        fg: C.accent,
        attributes: 1,
      }),
    ];

    if (this.eventLog.length === 0) {
      logChildren.push(
        Box(
          { paddingLeft: 3 },
          Text({
            content: this.isLive
              ? "No events yet — watching for changes..."
              : "Connect to a running orchestrator to see events",
            fg: C.textDim,
          }),
        ),
      );
    } else {
      for (const entry of this.eventLog.slice(0, 15)) {
        logChildren.push(
          Box(
            {
              flexDirection: "row",
              gap: 1,
              paddingLeft: 3,
            },
            Text({ content: entry.timestamp, fg: C.textDim }),
            Text({ content: entry.message, fg: entry.color, truncate: true }),
          ),
        );
      }
    }

    return ScrollBox(
      {
        flexDirection: "column",
        flexGrow: 1,
        paddingY: 0,
        stickyStart: "top",
        contentOptions: {
          flexDirection: "column",
          gap: 0,
        },
      },
      ...logChildren.filter((c): c is NonNullable<VChild> => c != null),
    );
  }

  private buildFooter(): VChild {
    return Box(
      {
        flexDirection: "row",
        paddingX: 1,
        paddingY: 0,
        borderStyle: "single",
        border: ["top"] as any,
        borderColor: C.border,
        gap: 3,
      },
      Text({ content: "q Quit", fg: C.textDim }),
      Text({ content: "r Refresh", fg: C.textDim }),
      Text({ content: "R Force refresh (API)", fg: C.textDim }),
    );
  }

  // -- Key handling ----------------------------------------------------------

  private installKeyHandler(): void {
    this.keyHandler = (key: KeyEvent) => {
      // Quit
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        key.preventDefault();
        this.destroy();
        return;
      }

      // Manual refresh
      if (key.name === "r" && !key.shift) {
        key.preventDefault();
        this.refresh();
        return;
      }

      // Force refresh via API POST
      if (key.name === "r" && key.shift) {
        key.preventDefault();
        this.forceRefresh();
        return;
      }
    };
    this.renderer.keyInput.on("keypress", this.keyHandler);
  }

  private async forceRefresh(): Promise<void> {
    this.addEvent(
      new Date().toLocaleTimeString(),
      "⟳ Triggering forced refresh...",
      C.cyan,
    );

    const snap = await this.client.triggerRefresh();
    if (snap) {
      this.lastState = { source: "live", snapshot: snap };
      this.isLive = true;
      this.addEvent(
        new Date().toLocaleTimeString(),
        "✓ Forced refresh complete",
        C.green,
      );
    } else {
      this.addEvent(
        new Date().toLocaleTimeString(),
        "✗ Forced refresh failed — API unreachable",
        C.red,
      );
    }
    this.render();
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.keyHandler) {
      this.renderer.keyInput.off("keypress", this.keyHandler);
      this.keyHandler = null;
    }

    this.renderer.destroy();

    if (this.onExitCallback) {
      this.onExitCallback();
    }
  }
}

// -- Utility functions -------------------------------------------------------

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
