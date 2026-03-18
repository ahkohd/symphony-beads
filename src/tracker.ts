// ---------------------------------------------------------------------------
// Beads tracker client — wraps the `bd` CLI
// ---------------------------------------------------------------------------

import type { Issue, ServiceConfig } from "./types.ts";
import { exec } from "./exec.ts";
import { log } from "./log.ts";

export class BeadsTracker {
  private cwd: string;
  private activeStates: Set<string>;
  private terminalStates: Set<string>;

  constructor(config: ServiceConfig) {
    this.cwd = config.tracker.project_path;
    this.activeStates = new Set(config.tracker.active_states.map((s) => s.toLowerCase()));
    this.terminalStates = new Set(config.tracker.terminal_states.map((s) => s.toLowerCase()));
  }

  /** Fetch all issues whose state is in the active set. */
  async fetchCandidates(): Promise<Issue[]> {
    const raw = await this.bd(["list", "--json"]);
    if (!raw) return [];
    const issues = this.parseList(raw);
    return issues.filter((i) => this.activeStates.has(i.state.toLowerCase()));
  }

  /** Fetch current state for a set of issue IDs (reconciliation). */
  async fetchStatesById(ids: string[]): Promise<Issue[]> {
    if (ids.length === 0) return [];
    const results: Issue[] = [];
    for (const id of ids) {
      const raw = await this.bd(["show", id, "--json"]);
      if (!raw) continue;
      const parsed = this.parseShow(raw);
      if (parsed) results.push(parsed);
    }
    return results;
  }

  /** Fetch IDs of issues in terminal states (startup cleanup). */
  async fetchTerminalIds(): Promise<string[]> {
    const raw = await this.bd(["list", "--json"]);
    if (!raw) return [];
    const issues = this.parseList(raw);
    return issues
      .filter((i) => this.terminalStates.has(i.state.toLowerCase()))
      .map((i) => i.id);
  }

  isActive(state: string): boolean {
    return this.activeStates.has(state.toLowerCase());
  }

  isTerminal(state: string): boolean {
    return this.terminalStates.has(state.toLowerCase());
  }

  // -- Private ---------------------------------------------------------------

  private async bd(args: string[]): Promise<string | null> {
    const result = await exec(["bd", ...args], { cwd: this.cwd });
    if (result.code !== 0) {
      if (result.stderr.trim()) {
        log.debug("bd command failed", { args, stderr: result.stderr.trim() });
      }
      return null;
    }
    return result.stdout;
  }

  private parseList(raw: string): Issue[] {
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.map((item: BeadsRaw) => this.normalize(item));
    } catch {
      log.warn("failed to parse bd list output");
      return [];
    }
  }

  private parseShow(raw: string): Issue | null {
    try {
      const item = JSON.parse(raw);
      if (!item || typeof item !== "object") return null;
      return this.normalize(item as BeadsRaw);
    } catch {
      log.warn("failed to parse bd show output");
      return null;
    }
  }

  private normalize(raw: BeadsRaw): Issue {
    return {
      id: raw.id,
      identifier: raw.id,
      title: raw.title || "Untitled",
      description: raw.description ?? null,
      priority: typeof raw.priority === "number" ? raw.priority : null,
      state: raw.status || "open",
      labels: (raw.labels ?? []).map((l) => l.toLowerCase()),
      blocked_by: this.extractBlockers(raw),
      issue_type: raw.issue_type ?? null,
      metadata: raw.metadata ?? null,
      created_at: raw.created_at ?? null,
      updated_at: raw.updated_at ?? null,
    };
  }

  private extractBlockers(raw: BeadsRaw): Issue["blocked_by"] {
    if (!raw.deps || !Array.isArray(raw.deps)) return [];
    return raw.deps
      .filter((d) => {
        const rel = d.split(":")[0];
        return rel === "blocked-by" || rel === "blocks";
      })
      .map((d) => {
        const target = d.split(":")[1] ?? d;
        return { id: target, identifier: target, state: null };
      });
  }
}

interface BeadsRaw {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
  labels?: string[];
  deps?: string[];
  metadata?: Record<string, string>;
  created_at?: string;
  updated_at?: string;
}