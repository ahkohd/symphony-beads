// ---------------------------------------------------------------------------
// WORKFLOW.md file watcher — watches for changes and triggers config reload
//
// Uses fs.watch (Bun-compatible) for instant detection. Falls back to
// poll-based stat checking when fs.watch is unavailable or unreliable
// (e.g., NFS, some container runtimes).
//
// On invalid reload: keeps last known good config, logs the error.
// ---------------------------------------------------------------------------

import { type FSWatcher, watch } from "node:fs";
import { stat } from "node:fs/promises";
import { parseWorkflow, validateConfig } from "./config.ts";
import { log } from "./log.ts";
import type { Orchestrator } from "./orchestrator.ts";

const DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 5_000;

export class WorkflowWatcher {
  private path: string;
  private orchestrator: Orchestrator;
  private fsWatcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMtimeMs = 0;
  private stopped = false;

  constructor(path: string, orchestrator: Orchestrator) {
    this.path = path;
    this.orchestrator = orchestrator;
  }

  /** Start watching. Tries fs.watch first, falls back to polling. */
  async start(): Promise<void> {
    // Record initial mtime
    try {
      const s = await stat(this.path);
      this.lastMtimeMs = s.mtimeMs;
    } catch {
      // File may not exist yet; that's ok
    }

    try {
      this.fsWatcher = watch(this.path, { persistent: false }, (_event) => {
        this.scheduleReload();
      });

      this.fsWatcher.on("error", (err) => {
        log.warn("fs.watch error, falling back to polling", {
          error: String(err),
        });
        this.fsWatcher?.close();
        this.fsWatcher = null;
        this.startPolling();
      });

      log.info("watching workflow file for changes", {
        path: this.path,
        mode: "fs.watch",
      });
    } catch {
      log.info("fs.watch unavailable, using poll-based detection", {
        path: this.path,
      });
      this.startPolling();
    }
  }

  /** Stop watching. */
  stop(): void {
    this.stopped = true;
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // -- Poll-based fallback ---------------------------------------------------

  private startPolling(): void {
    if (this.stopped) return;

    this.pollTimer = setInterval(async () => {
      if (this.stopped) return;
      try {
        const s = await stat(this.path);
        if (s.mtimeMs !== this.lastMtimeMs) {
          this.lastMtimeMs = s.mtimeMs;
          this.scheduleReload();
        }
      } catch {
        // File temporarily unavailable — skip this poll cycle
      }
    }, POLL_INTERVAL_MS);

    log.info("watching workflow file for changes", {
      path: this.path,
      mode: "poll",
      interval_ms: POLL_INTERVAL_MS,
    });
  }

  // -- Debounced reload ------------------------------------------------------

  private scheduleReload(): void {
    if (this.stopped) return;

    // Debounce rapid successive writes (e.g., editor save + format)
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.doReload();
    }, DEBOUNCE_MS);
  }

  private async doReload(): Promise<void> {
    if (this.stopped) return;

    log.info("workflow file changed, reloading config");

    let content: string;
    try {
      const file = Bun.file(this.path);
      content = await file.text();
    } catch (err) {
      log.error("failed to read workflow file during reload", {
        path: this.path,
        error: String(err),
      });
      return; // Keep last known good config
    }

    let workflow;
    try {
      workflow = parseWorkflow(content);
    } catch (err) {
      log.error("failed to parse workflow file during reload", {
        path: this.path,
        error: String(err),
      });
      return; // Keep last known good config
    }

    const errors = validateConfig(workflow.config);
    if (errors.length > 0) {
      log.error("reloaded workflow config is invalid, keeping previous config", {
        errors,
      });
      return; // Keep last known good config
    }

    // Update mtime to avoid double-triggering in poll mode
    try {
      const s = await stat(this.path);
      this.lastMtimeMs = s.mtimeMs;
    } catch {
      // Non-critical
    }

    // Apply the new config
    this.orchestrator.reload(workflow.config, workflow.prompt_template);

    log.info("workflow config reloaded successfully", {
      poll_ms: workflow.config.polling.interval_ms,
      max_concurrent: workflow.config.agent.max_concurrent,
      runner: workflow.config.runner.command,
    });
  }
}
