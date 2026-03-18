// ---------------------------------------------------------------------------
// Agent runner — spawns pi sessions for each issue
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { exec } from "./exec.ts";
import { log } from "./log.ts";
import { renderPrompt } from "./template.ts";
import type { AgentEvent, Issue, RunnerConfig, TokenCount } from "./types.ts";
import type { WorkspaceManager } from "./workspace.ts";

export type EventCallback = (event: AgentEvent) => void;

export class AgentRunner {
  private commandTemplate: string;
  private model: string | null;
  private models: Record<string, string> | null;
  private turnTimeout: number;
  private projectPath: string | null;
  private active: Map<string, Subprocess> = new Map();

  constructor(config: RunnerConfig, projectPath?: string) {
    this.commandTemplate = config.command;
    this.model = config.model;
    this.models = config.models;
    this.turnTimeout = config.turn_timeout_ms;
    this.projectPath = projectPath ?? null;
  }

  /**
   * Build the command array for a given issue, resolving model routing.
   * Returns { command, env } where env contains SYMPHONY_MODEL if resolved.
   */
  private buildCommand(issue: Issue): { command: string[]; env: Record<string, string> } {
    const resolved = resolveModel(issue, this.models);
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    // Point bd commands at the main project's beads DB, not the workspace
    if (this.projectPath) {
      env.BEADS_DIR = join(this.projectPath, ".beads");
    }

    let cmdStr = this.commandTemplate;

    if (resolved) {
      // Set env var for the spawned process
      env.SYMPHONY_MODEL = resolved;
      // Substitute $SYMPHONY_MODEL in the command template
      cmdStr = cmdStr.replace(/\$SYMPHONY_MODEL\b/g, resolved);
      cmdStr = cmdStr.replace(/\$\{SYMPHONY_MODEL\}/g, resolved);
    } else {
      // No model resolved — remove $SYMPHONY_MODEL references to avoid
      // passing a literal "$SYMPHONY_MODEL" string as an argument
      delete env.SYMPHONY_MODEL;
      cmdStr = cmdStr.replace(/\$SYMPHONY_MODEL\b/g, "");
      cmdStr = cmdStr.replace(/\$\{SYMPHONY_MODEL\}/g, "");
    }

    const parts = cmdStr.split(/\s+/).filter(Boolean);

    // Legacy support: if config.model is set (no models map), append --model
    if (!this.models && this.model) {
      parts.push("--model", this.model);
    }

    return { command: parts, env };
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

    // Detect rework: if a PR already exists for this issue branch, fetch
    // review feedback so the agent knows what the reviewer wants fixed.
    const branchName = `issue/${issue.identifier}`;
    const reviewFeedback = await fetchPrReviewFeedback(ws.path, branchName);
    if (reviewFeedback) {
      log.info("rework detected — injecting PR review feedback", {
        issue_id: issue.id,
        branch: branchName,
      });
    }

    const prompt = renderPrompt(promptTemplate, issue, attempt, {
      review_feedback: reviewFeedback ?? "",
    });
    const taskFile = join(ws.path, "TASK.md");
    await Bun.write(taskFile, prompt);

    const sessionId = `pi-${issue.id}-${attempt}`;
    onEvent({ kind: "session_started", session_id: sessionId });

    try {
      const stdout = await this.spawn(ws.path, prompt, issue, onEvent);
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

  private spawn(
    cwd: string,
    prompt: string,
    issue: Issue,
    onEvent: EventCallback,
  ): Promise<string> {
    const issueId = issue.id;
    return new Promise<string>((resolve, reject) => {
      const { command, env } = this.buildCommand(issue);

      if (command.length === 0) {
        return reject(new Error("runner command is empty"));
      }

      // Detect pi runner — inject --mode json for structured token tracking
      const useJsonMode = isPiCommand(command);
      const baseCommand = useJsonMode ? injectJsonMode(command) : command;

      // Pass prompt as argument — allows pi to use tools (bash, edit, write)
      // instead of just printing. The prompt is also written to TASK.md as context.
      const fullCommand = [...baseCommand, prompt];
      log.debug("spawning agent", {
        issueId,
        command: baseCommand.join(" "),
        cwd,
        model: env.SYMPHONY_MODEL ?? null,
        jsonMode: useJsonMode,
      });

      const proc = Bun.spawn(fullCommand, {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env,
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      let killed = false;

      const sub: Subprocess = { proc, timer: undefined };
      this.active.set(issueId, sub);

      // Timeout guard
      if (this.turnTimeout > 0) {
        timer = setTimeout(() => {
          killed = true;
          proc.kill();
        }, this.turnTimeout);
        sub.timer = timer;
      }

      // For pi JSON mode: stream-parse stdout line-by-line for token events.
      // For non-pi runners: accumulate raw text.
      const tokens: TokenCount = {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        total: 0,
        cost: 0,
      };
      const textParts: string[] = [];
      const rawChunks: string[] = [];

      const readStdout = async () => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let lineBuffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (useJsonMode) {
              lineBuffer += chunk;
              const lines = lineBuffer.split("\n");
              lineBuffer = lines.pop() ?? "";
              for (const line of lines) {
                if (line.trim()) {
                  parseJsonLine(line, tokens, textParts, onEvent);
                }
              }
            } else {
              rawChunks.push(chunk);
            }
          }
          // Flush remaining buffer
          const remaining = decoder.decode();
          if (useJsonMode) {
            const finalBuf = lineBuffer + remaining;
            if (finalBuf.trim()) {
              parseJsonLine(finalBuf, tokens, textParts, onEvent);
            }
          } else if (remaining) {
            rawChunks.push(remaining);
          }
        } catch {
          // Stream may be cancelled on kill — ignore
        }
      };

      const stdoutPromise = readStdout();

      proc.exited.then(async (code) => {
        if (timer) clearTimeout(timer);
        this.active.delete(issueId);

        // Wait for stdout stream reading to complete
        await stdoutPromise;

        // Read stderr
        const stderr = await new Response(proc.stderr).text();
        if (stderr.trim()) {
          log.debug("agent stderr", { issueId, stderr: stderr.slice(0, 1000) });
        }

        // Build output text
        const stdout = useJsonMode ? textParts.join("\n") : rawChunks.join("");

        // Emit final token state so orchestrator has accurate numbers
        // even if the agent didn't produce a final message_end event
        if (tokens.total > 0) {
          onEvent({ kind: "token_update", tokens: { ...tokens } });
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

// ---------------------------------------------------------------------------
// PR review feedback for rework detection
// ---------------------------------------------------------------------------

interface GhReview {
  author?: { login?: string };
  body?: string;
  state?: string;
  submittedAt?: string;
}

interface GhComment {
  author?: { login?: string };
  body?: string;
  createdAt?: string;
}

/**
 * Check if a PR exists for the given branch and return formatted review
 * feedback. Returns null if no PR exists or there's no actionable feedback.
 */
async function fetchPrReviewFeedback(cwd: string, branchName: string): Promise<string | null> {
  const result = await exec(["gh", "pr", "view", branchName, "--json", "number,reviews,comments"], {
    cwd,
  });

  if (result.code !== 0) {
    // No PR found or gh CLI not available — not a rework
    return null;
  }

  try {
    const data = JSON.parse(result.stdout) as {
      number?: number;
      reviews?: GhReview[];
      comments?: GhComment[];
    };

    const parts: string[] = [];

    // Include reviews (especially CHANGES_REQUESTED with body text)
    if (data.reviews?.length) {
      for (const review of data.reviews) {
        if (review.body?.trim()) {
          const author = review.author?.login ?? "reviewer";
          const state = review.state ?? "COMMENTED";
          parts.push(`**${author}** (${state}):\n${review.body.trim()}`);
        }
      }
    }

    // Include PR-level comments
    if (data.comments?.length) {
      for (const comment of data.comments) {
        if (comment.body?.trim()) {
          const author = comment.author?.login ?? "commenter";
          parts.push(`**${author}**:\n${comment.body.trim()}`);
        }
      }
    }

    if (parts.length === 0) return null;

    return parts.join("\n\n---\n\n");
  } catch {
    log.debug("failed to parse gh pr view output", { branch: branchName });
    return null;
  }
}

interface Subprocess {
  proc: ReturnType<typeof Bun.spawn>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

// ---------------------------------------------------------------------------
// Pi command detection
// ---------------------------------------------------------------------------

/**
 * Detect whether the command array is running a pi agent.
 * Returns true if the binary is 'pi' (or a path ending in '/pi').
 */
export function isPiCommand(command: string[]): boolean {
  if (command.length === 0) return false;
  const bin = command[0]!;
  return bin === "pi" || bin.endsWith("/pi");
}

// ---------------------------------------------------------------------------
// JSON stdout parsing — extract token usage from pi --mode json events
// ---------------------------------------------------------------------------

/**
 * Insert `--mode json` into a pi command array. Placed after the first
 * element (the binary name) so that sub-commands and other flags are preserved.
 */
export function injectJsonMode(command: string[]): string[] {
  return [command[0]!, "--mode", "json", ...command.slice(1)];
}

/**
 * Parse one JSON line from pi's --mode json output. Extracts token usage
 * from `message_end` events (assistant role) and text content from `turn_end`.
 *
 * Pi's usage object includes:
 *   - input: non-cached input tokens
 *   - output: generated output tokens
 *   - cacheRead: input tokens served from cache
 *   - cacheWrite: input tokens written to cache
 *   - totalTokens: input + output + cacheRead + cacheWrite
 *   - cost: { input, output, cacheRead, cacheWrite, total }
 *
 * We accumulate all fields across turns. The `agent_end` event carries the
 * final message list with per-message usage which we use as authoritative
 * totals (replaces accumulated values).
 */
export function parseJsonLine(
  line: string,
  tokens: TokenCount,
  textParts: string[],
  onEvent: EventCallback,
): void {
  try {
    const event = JSON.parse(line);
    if (!event || typeof event !== "object" || !event.type) return;

    // Extract token usage from message_end events (assistant messages).
    // Each message_end carries the usage for that individual API call.
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const usage = event.message.usage;
      if (usage && typeof usage === "object") {
        tokens.input += num(usage.input);
        tokens.output += num(usage.output);
        tokens.cache_read += num(usage.cacheRead);
        tokens.cache_write += num(usage.cacheWrite);
        tokens.total = tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;
        tokens.cost += num(usage.cost?.total);
        emitTokenUpdate(tokens, onEvent);
      }
    }

    // agent_end carries the full message list with per-message usage.
    // This is the authoritative final accounting — replace accumulated values.
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      let input = 0,
        output = 0,
        cacheRead = 0,
        cacheWrite = 0,
        cost = 0;
      for (const msg of event.messages) {
        if (msg.role === "assistant" && msg.usage && typeof msg.usage === "object") {
          input += num(msg.usage.input);
          output += num(msg.usage.output);
          cacheRead += num(msg.usage.cacheRead);
          cacheWrite += num(msg.usage.cacheWrite);
          cost += num(msg.usage.cost?.total);
        }
      }
      // Authoritative — replace
      tokens.input = input;
      tokens.output = output;
      tokens.cache_read = cacheRead;
      tokens.cache_write = cacheWrite;
      tokens.total = input + output + cacheRead + cacheWrite;
      tokens.cost = cost;
      emitTokenUpdate(tokens, onEvent);
    }

    // Session-level cumulative usage from session_end / usage_summary events.
    // Some runners may emit these — handle as authoritative if present.
    if (
      (event.type === "session_end" || event.type === "usage_summary") &&
      event.usage &&
      typeof event.usage === "object"
    ) {
      const u = event.usage;
      tokens.input = num(u.input_tokens) || num(u.input) || tokens.input;
      tokens.output = num(u.output_tokens) || num(u.output) || tokens.output;
      tokens.cache_read = num(u.cache_read_tokens) || num(u.cacheRead) || tokens.cache_read;
      tokens.cache_write = num(u.cache_write_tokens) || num(u.cacheWrite) || tokens.cache_write;
      tokens.total = tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;
      tokens.cost = num(u.total_cost) || num(u.cost?.total) || tokens.cost;
      emitTokenUpdate(tokens, onEvent);
    }

    // Extract text content from turn_end for RESULT.md
    if (event.type === "turn_end" && event.message?.role === "assistant") {
      const content = event.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            textParts.push(block.text);
          }
        }
      }
    }
  } catch {
    // Not valid JSON — ignore (could be plain-text output from non-pi runners)
  }
}

/** Safely extract a number from a value, returning 0 for non-numbers. */
function num(v: unknown): number {
  return typeof v === "number" && !Number.isNaN(v) ? v : 0;
}

/** Emit a token_update event with a snapshot of the current token state. */
function emitTokenUpdate(tokens: TokenCount, onEvent: EventCallback): void {
  onEvent({
    kind: "token_update",
    tokens: { ...tokens },
  });
}

// ---------------------------------------------------------------------------
// Model resolution — exported for testing
// ---------------------------------------------------------------------------

/**
 * Resolve the model for an issue based on the models map.
 *
 * Resolution order:
 * 1. Per-issue metadata override (`metadata.model`)
 * 2. Issue type match (bug, feature, chore, etc.)
 * 3. Priority match (P0, P1, P2, P3, P4)
 * 4. Default model (`default` key)
 *
 * First match wins. Returns null if no models map or no match.
 */
export function resolveModel(issue: Issue, models: Record<string, string> | null): string | null {
  if (!models) return null;

  // 1. Per-issue metadata override
  if (issue.metadata?.model) {
    return issue.metadata.model;
  }

  // 2. Issue type match
  if (issue.issue_type) {
    const typeKey = issue.issue_type.toLowerCase();
    if (models[typeKey]) {
      return models[typeKey]!;
    }
  }

  // 3. Priority match (P0-P4)
  if (issue.priority !== null && issue.priority !== undefined) {
    const priorityKey = `P${issue.priority}`;
    if (models[priorityKey]) {
      return models[priorityKey]!;
    }
  }

  // 4. Default
  if (models.default) {
    return models.default;
  }

  return null;
}
