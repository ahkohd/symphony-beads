// ---------------------------------------------------------------------------
// WORKFLOW.md parser — YAML front-matter + Mustache prompt body
// ---------------------------------------------------------------------------

import type { ServiceConfig, WorkflowDefinition } from "./types.ts";

const DEFAULTS: ServiceConfig = {
  tracker: {
    kind: "beads",
    project_path: ".",
    active_states: ["open", "in_progress"],
    terminal_states: ["done", "closed", "cancelled", "duplicate"],
  },
  polling: { interval_ms: 30_000 },
  workspace: { root: "./workspaces" },
  hooks: {
    after_create: null,
    before_run: null,
    after_run: null,
    before_remove: null,
    timeout_ms: 60_000,
  },
  agent: {
    max_concurrent: 5,
    max_turns: 20,
    max_retry_backoff_ms: 300_000,
  },
  runner: {
    command: "pi -p --no-session",
    model: null,
    turn_timeout_ms: 3_600_000,
    stall_timeout_ms: 300_000,
  },
  log: {
    file: null,
  },
};

const DEFAULT_PROMPT = `You are working on a Beads issue.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
Description: {{ issue.description }}

Implement the solution, then mark it done:
  bd update {{ issue.identifier }} --status done
`;

// -- Public API --------------------------------------------------------------

export function parseWorkflow(content: string): WorkflowDefinition {
  const { frontMatter, body } = splitFrontMatter(content);
  const config = structuredClone(DEFAULTS);

  if (frontMatter) {
    const raw = parseYaml(frontMatter);
    const cfg = config as unknown as Record<string, unknown>;
    merge(cfg, "tracker", raw);
    merge(cfg, "polling", raw);
    merge(cfg, "workspace", raw);
    merge(cfg, "hooks", raw);
    merge(cfg, "agent", raw);
    merge(cfg, "runner", raw);
    merge(cfg, "log", raw);
  }

  resolveEnv(config);
  resolvePaths(config);

  return { config, prompt_template: body || DEFAULT_PROMPT };
}

export function validateConfig(config: ServiceConfig): string[] {
  const errors: string[] = [];

  if (config.tracker.kind !== "beads") {
    errors.push(`unsupported tracker kind: ${config.tracker.kind}`);
  }
  if (!config.runner.command) {
    errors.push("runner.command is empty");
  }
  if (config.agent.max_concurrent < 1) {
    errors.push("agent.max_concurrent must be >= 1");
  }
  if (config.polling.interval_ms < 1000) {
    errors.push("polling.interval_ms must be >= 1000");
  }

  return errors;
}

// -- Front-matter split ------------------------------------------------------

function splitFrontMatter(content: string): { frontMatter: string | null; body: string } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontMatter: null, body: content.trim() };
  }

  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") {
      const fm = lines.slice(1, i).join("\n");
      const body = lines.slice(i + 1).join("\n").trim();
      return { frontMatter: fm, body };
    }
  }

  return { frontMatter: null, body: content.trim() };
}

// -- Minimal 2-level YAML parser ---------------------------------------------

function parseYaml(yaml: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  let section: string | null = null;

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;

    const key = trimmed.slice(0, colon).trim();
    const raw = trimmed.slice(colon + 1).trim();
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      if (!raw || raw.startsWith("#")) {
        section = key;
        if (!result[section]) result[section] = {};
      } else {
        // Top-level scalar — ignore (we only support sections)
      }
    } else if (section && result[section]) {
      result[section]![key] = coerceValue(raw);
    }
  }

  return result;
}

function coerceValue(raw: string): unknown {
  const v = raw.split("#")[0]!.trim();
  if (!v) return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith("[") && v.endsWith("]")) {
    return v.slice(1, -1).split(",").map((s) => coerceValue(s.trim()));
  }
  return v.replace(/^["']|["']$/g, "");
}

// -- Helpers -----------------------------------------------------------------

function merge(
  config: Record<string, unknown>,
  key: string,
  raw: Record<string, Record<string, unknown>>,
): void {
  const section = raw[key];
  if (!section) return;
  const target = config[key];
  if (target && typeof target === "object") {
    Object.assign(target, section);
  }
}

function resolveEnv(config: ServiceConfig): void {
  const tk = config.tracker as unknown as Record<string, unknown>;
  for (const key of Object.keys(tk)) {
    const val = tk[key];
    if (typeof val === "string" && val.startsWith("$")) {
      const env = process.env[val.slice(1)];
      if (env) tk[key] = env;
    }
  }
}

function resolvePaths(config: ServiceConfig): void {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (config.workspace.root.startsWith("~")) {
    config.workspace.root = config.workspace.root.replace("~", home);
  }
  if (config.log.file && config.log.file.startsWith("~")) {
    config.log.file = config.log.file.replace("~", home);
  }
  if (config.tracker.project_path.startsWith("~")) {
    config.tracker.project_path = config.tracker.project_path.replace("~", home);
  }
}