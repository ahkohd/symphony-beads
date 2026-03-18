// ---------------------------------------------------------------------------
// Orchestrator — poll / dispatch / reconcile / retry loop
// ---------------------------------------------------------------------------

import type {
  AgentEvent,
  AgentTotals,
  Issue,
  RetryEntry,
  RunningEntry,
  ServiceConfig,
  TokenCount,
} from "./types.ts";
import { BeadsTracker } from "./tracker.ts";
import { WorkspaceManager } from "./workspace.ts";
import { AgentRunner } from "./runner.ts";
import { log } from "./log.ts";

export class Orchestrator {
  private config: ServiceConfig;
  private promptTemplate: string;
  private tracker: BeadsTracker;
  private workspace: WorkspaceManager;
  private runner: AgentRunner;

  // State
  private running = new Map<string, RunningEntry>();
  private claimed = new Set<string>();
  private retries = new Map<string, RetryEntry>();
  private completed = new Set<string>();
  private alive = true;

  private totals: AgentTotals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    ended_seconds: 0,
  };

  constructor(
    config: ServiceConfig,
    promptTemplate: string,
    tracker: BeadsTracker,
    workspace: WorkspaceManager,
  ) {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.tracker = tracker;
    this.workspace = workspace;
    this.runner = new AgentRunner(config.runner);
  }

  // -- Public API ------------------------------------------------------------

  async start(): Promise<void> {
    log.info("service started", {
      poll_ms: this.config.polling.interval_ms,
      max_concurrent: this.config.agent.max_concurrent,
      runner: this.config.runner.command,
    });

    await this.cleanupTerminal();
    await this.tick();

    while (this.alive) {
      await sleep(this.config.polling.interval_ms);
      if (!this.alive) break;
      await this.tick();
    }
  }

  /**
   * Hot-reload config and prompt template. Called by the WorkflowWatcher when
   * WORKFLOW.md changes. Applies to future dispatch, retry scheduling,
   * reconciliation, hook execution, and agent launches. In-flight sessions
   * continue with their original config.
   */
  reload(config: ServiceConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.runner = new AgentRunner(config.runner);
    this.tracker = new BeadsTracker(config);
    this.workspace = new WorkspaceManager(config);
    log.info("orchestrator config hot-reloaded");
  }

  stop(): void {
    log.info("stopping service");
    this.alive = false;
    for (const id of this.running.keys()) {
      this.runner.kill(id);
    }
    for (const entry of this.retries.values()) {
      clearTimeout(entry.timer);
    }
  }

  /** Trigger an immediate poll+reconcile cycle (used by the HTTP API). */
  async triggerTick(): Promise<void> {
    log.info("manual tick triggered via API");
    await this.tick();
  }

  /** Snapshot of current state (for `status` subcommand and JSON API). */
  snapshot(): OrchestratorSnapshot {
    const now = Date.now();
    const runningArr = [...this.running.entries()].map(([id, e]) => ({
      issue_id: id,
      issue_identifier: e.issue.identifier,
      title: e.issue.title,
      state: e.issue.state,
      session_id: e.session_id,
      attempt: e.attempt,
      started_at: new Date(e.started_at).toISOString(),
      elapsed_ms: now - e.started_at,
      last_event: e.last_event,
      last_message: e.last_message,
      tokens: e.tokens,
    }));

    const retryArr = [...this.retries.values()].map((r) => ({
      issue_id: r.issue_id,
      identifier: r.identifier,
      attempt: r.attempt,
      due_at: new Date(r.due_at).toISOString(),
      error: r.error,
    }));

    let activeSeconds = 0;
    for (const e of this.running.values()) {
      activeSeconds += (now - e.started_at) / 1000;
    }

    return {
      generated_at: new Date().toISOString(),
      counts: {
        running: this.running.size,
        retrying: this.retries.size,
        completed: this.completed.size,
        claimed: this.claimed.size,
      },
      running: runningArr,
      retrying: retryArr,
      totals: {
        ...this.totals,
        seconds_running: this.totals.ended_seconds + activeSeconds,
      },
    };
  }

  // -- Tick ------------------------------------------------------------------

  private async tick(): Promise<void> {
    await this.reconcile();

    const errors = await this.validateConfig();
    if (errors.length > 0) {
      log.warn("dispatch config invalid, skipping tick", { errors });
      return;
    }

    const candidates = await this.tracker.fetchCandidates();
    const sorted = this.sortForDispatch(candidates);
    log.info("tick", { candidates: sorted.length, running: this.running.size });

    let dispatched = 0;
    for (const issue of sorted) {
      if (!this.slotsAvailable()) break;
      if (!this.eligible(issue)) continue;
      this.dispatch(issue, 0);
      dispatched++;
    }

    if (dispatched > 0) {
      log.info("dispatched", { count: dispatched });
    }
  }

  // -- Reconciliation --------------------------------------------------------

  private async reconcile(): Promise<void> {
    // Stall detection
    const now = Date.now();
    const stallMs = this.config.runner.stall_timeout_ms;
    if (stallMs > 0) {
      for (const [id, entry] of this.running) {
        const ref = entry.last_event_at ?? entry.started_at;
        if (now - ref > stallMs) {
          log.warn("stalled session", { issue_id: id, elapsed_ms: now - ref });
          this.runner.kill(id);
          this.removeRunning(id);
          this.scheduleRetry(id, entry.issue.identifier, entry.attempt + 1, "stalled");
        }
      }
    }

    // Tracker state refresh
    const ids = [...this.running.keys()];
    if (ids.length === 0) return;

    const refreshed = await this.tracker.fetchStatesById(ids);
    for (const issue of refreshed) {
      const entry = this.running.get(issue.id);
      if (!entry) continue;

      if (this.tracker.isTerminal(issue.state)) {
        log.info("issue reached terminal state", { issue_id: issue.id, state: issue.state });
        this.runner.kill(issue.id);
        this.removeRunning(issue.id);
        await this.workspace.remove(issue.identifier);
      } else if (!this.tracker.isActive(issue.state)) {
        log.info("issue no longer active", { issue_id: issue.id, state: issue.state });
        this.runner.kill(issue.id);
        this.removeRunning(issue.id);
      } else {
        entry.issue = issue; // refresh in-memory copy
      }
    }
  }

  // -- Dispatch --------------------------------------------------------------

  private eligible(issue: Issue): boolean {
    if (this.running.has(issue.id)) return false;
    if (this.claimed.has(issue.id)) return false;

    // Blocker check for open/todo issues
    const s = issue.state.toLowerCase();
    if ((s === "open" || s === "todo") && issue.blocked_by.length > 0) {
      const blocked = issue.blocked_by.some(
        (b) => b.state !== null && !this.tracker.isTerminal(b.state),
      );
      if (blocked) {
        log.debug("issue blocked", { issue_id: issue.id });
        return false;
      }
    }

    return true;
  }

  private dispatch(issue: Issue, attempt: number): void {
    log.info("dispatching", { issue_id: issue.id, title: issue.title, attempt });

    this.claimed.add(issue.id);
    const entry: RunningEntry = {
      issue,
      session_id: null,
      attempt,
      started_at: Date.now(),
      last_event: null,
      last_event_at: null,
      last_message: "",
      tokens: { input: 0, output: 0, total: 0 },
    };
    this.running.set(issue.id, entry);

    // Fire-and-forget — the runner resolves/rejects asynchronously
    this.runner
      .run(issue, attempt, this.promptTemplate, this.workspace, (ev) =>
        this.onEvent(issue.id, ev),
      )
      .then(() => this.onWorkerExit(issue.id, null))
      .catch((err) => this.onWorkerExit(issue.id, err));
  }

  // -- Events ----------------------------------------------------------------

  private onEvent(issueId: string, event: AgentEvent): void {
    const entry = this.running.get(issueId);
    if (!entry) return;
    entry.last_event = event.kind;
    entry.last_event_at = Date.now();

    switch (event.kind) {
      case "session_started":
        entry.session_id = event.session_id;
        break;
      case "turn_completed":
      case "turn_failed":
      case "turn_timeout":
      case "log":
        entry.last_message = event.message;
        break;
    }
  }

  private onWorkerExit(issueId: string, error: unknown): void {
    const entry = this.running.get(issueId);
    if (!entry) return;

    const elapsed = (Date.now() - entry.started_at) / 1000;
    this.totals.ended_seconds += elapsed;
    this.removeRunning(issueId);

    if (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn("agent failed", { issue_id: issueId, error: msg, elapsed_s: elapsed });
      this.scheduleRetry(issueId, entry.issue.identifier, entry.attempt + 1, msg);
    } else {
      log.info("agent completed", { issue_id: issueId, elapsed_s: elapsed });
      this.completed.add(issueId);
      // Schedule continuation check after 1s per spec
      this.scheduleRetry(issueId, entry.issue.identifier, 1, null);
    }
  }

  // -- Retry -----------------------------------------------------------------

  private scheduleRetry(
    issueId: string,
    identifier: string,
    attempt: number,
    error: string | null,
  ): void {
    // Cancel existing
    const existing = this.retries.get(issueId);
    if (existing) clearTimeout(existing.timer);

    const delay = error
      ? Math.min(10_000 * Math.pow(2, attempt - 1), this.config.agent.max_retry_backoff_ms)
      : 1_000; // continuation retry

    const dueAt = Date.now() + delay;
    log.debug("retry scheduled", { issue_id: issueId, attempt, delay_ms: delay, error });

    const timer = setTimeout(() => this.handleRetry(issueId), delay);
    this.retries.set(issueId, { issue_id: issueId, identifier, attempt, due_at: dueAt, timer, error });
  }

  private async handleRetry(issueId: string): Promise<void> {
    const entry = this.retries.get(issueId);
    if (!entry) return;
    this.retries.delete(issueId);

    const candidates = await this.tracker.fetchCandidates();
    const issue = candidates.find((c) => c.id === issueId);

    if (!issue) {
      log.debug("retry: issue gone, releasing claim", { issue_id: issueId });
      this.claimed.delete(issueId);
      return;
    }

    if (!this.eligible(issue)) {
      this.claimed.delete(issueId);
      return;
    }

    if (!this.slotsAvailable()) {
      this.scheduleRetry(issueId, entry.identifier, entry.attempt + 1, "no slots available");
      return;
    }

    this.dispatch(issue, entry.attempt);
  }

  // -- Helpers ---------------------------------------------------------------

  private removeRunning(issueId: string): void {
    this.running.delete(issueId);
    // Keep claimed — retry or continuation may re-dispatch
  }

  private slotsAvailable(): boolean {
    return this.running.size < this.config.agent.max_concurrent;
  }

  private sortForDispatch(issues: Issue[]): Issue[] {
    return [...issues].sort((a, b) => {
      const pa = a.priority ?? 99;
      const pb = b.priority ?? 99;
      if (pa !== pb) return pa - pb;
      if (a.created_at && b.created_at && a.created_at !== b.created_at) {
        return a.created_at < b.created_at ? -1 : 1;
      }
      return a.identifier.localeCompare(b.identifier);
    });
  }

  private async validateConfig(): Promise<string[]> {
    const { validateConfig } = await import("./config.ts");
    return validateConfig(this.config);
  }

  private async cleanupTerminal(): Promise<void> {
    const ids = await this.tracker.fetchTerminalIds();
    for (const id of ids) {
      await this.workspace.remove(id);
    }
    if (ids.length > 0) {
      log.info("cleaned terminal workspaces", { count: ids.length });
    }
  }
}

// -- Snapshot type for status/JSON output ------------------------------------

export interface OrchestratorSnapshot {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
    completed: number;
    claimed: number;
  };
  running: Array<{
    issue_id: string;
    issue_identifier: string;
    title: string;
    state: string;
    session_id: string | null;
    attempt: number;
    started_at: string;
    elapsed_ms: number;
    last_event: string | null;
    last_message: string;
    tokens: TokenCount;
  }>;
  retrying: Array<{
    issue_id: string;
    identifier: string;
    attempt: number;
    due_at: string;
    error: string | null;
  }>;
  totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}