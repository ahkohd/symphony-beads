// ---------------------------------------------------------------------------
// Agent runner — spawns pi sessions for each issue
// ---------------------------------------------------------------------------

import { join } from "path";
import type { AgentEvent, Issue, RunnerConfig } from "./types.ts";
import { WorkspaceManager } from "./workspace.ts";
import { renderPrompt } from "./template.ts";
import { log } from "./log.ts";

export type EventCallback = (event: AgentEvent) => void;

export class AgentRunner {
  private command: string[];
  private turnTimeout: number;
  private active: Map<string, Subprocess> = new Map();

  constructor(config: RunnerConfig) {
    const parts = config.command.split(/\s+/).filter(Boolean);
    if (config.model) {
      parts.push("--model", config.model);
    }
    this.command = parts;
    this.turnTimeout = config.turn_timeout_ms;
  }

  /**
   * Run one agent session: ensure workspace, render prompt, spawn pi,
   * wait for exit. Throws on failure.
   */
  async run(
    issue: Issue,
    attempt: number,
    promptTemplate: string,
    workspace: WorkspaceManager,
    onEvent: EventCallback,
  ): Promise<void> {
    const ws = await workspace.ensure(issue.identifier);
    const hookOk = await workspace.beforeRun(ws.path, issue.identifier);
    if (!hookOk) {
      throw new Error("before_run hook failed");
    }

    const prompt = renderPrompt(promptTemplate, issue, attempt);
    const taskFile = join(ws.path, "TASK.md");
    await Bun.write(taskFile, prompt);

    const sessionId = `pi-${issue.id}-${attempt}`;
    onEvent({ kind: "session_started", session_id: sessionId });

    try {
      const stdout = await this.spawn(ws.path, prompt, issue.id);
      // Write agent output to workspace for human review
      if (stdout.trim()) {
        const resultFile = join(ws.path, "RESULT.md");
        await Bun.write(resultFile, stdout);
      }
      onEvent({ kind: "turn_completed", message: "exit 0" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ kind: "turn_failed", message: msg });
      throw err;
    } finally {
      await workspace.afterRun(ws.path, issue.identifier);
    }
  }

  /** Kill a running agent for an issue. */
  kill(issueId: string): void {
    const sub = this.active.get(issueId);
    if (sub) {
      sub.proc.kill();
      if (sub.timer) clearTimeout(sub.timer);
      this.active.delete(issueId);
    }
  }

  /** Kill all running agents. */
  killAll(): void {
    for (const [id] of this.active) {
      this.kill(id);
    }
  }

  /** Number of currently active agent processes. */
  get size(): number {
    return this.active.size;
  }

  // -- Private ---------------------------------------------------------------

  private spawn(cwd: string, prompt: string, issueId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.command.length === 0) {
        return reject(new Error("runner command is empty"));
      }

      log.debug("spawning agent", { issueId, command: this.command.join(" "), cwd });

      const proc = Bun.spawn(this.command, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      let killed = false;

      const sub: Subprocess = { proc, timer: undefined };
      this.active.set(issueId, sub);

      // Feed prompt via stdin then close
      if (proc.stdin) {
        proc.stdin.write(new TextEncoder().encode(prompt));
        proc.stdin.end();
      }

      // Timeout guard
      if (this.turnTimeout > 0) {
        timer = setTimeout(() => {
          killed = true;
          proc.kill();
        }, this.turnTimeout);
        sub.timer = timer;
      }

      proc.exited.then(async (code) => {
        if (timer) clearTimeout(timer);
        this.active.delete(issueId);

        // Read stdout and stderr
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        if (stderr.trim()) {
          log.debug("agent stderr", { issueId, stderr: stderr.slice(0, 1000) });
        }

        if (killed) {
          reject(new Error(`timeout after ${this.turnTimeout}ms`));
        } else if (code !== 0) {
          reject(new Error(`agent exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }
}

interface Subprocess {
  proc: ReturnType<typeof Bun.spawn>;
  timer: ReturnType<typeof setTimeout> | undefined;
}