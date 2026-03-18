// ---------------------------------------------------------------------------
// WORKFLOW.md parser — YAML front-matter + Mustache prompt body
// ---------------------------------------------------------------------------

import type { ServiceConfig, WorkflowDefinition } from "./types.ts";

const DEFAULTS: ServiceConfig = {
  tracker: {
    kind: "beads",
    project_path: ".",
    active_states: ["open", "in_progress"],
    terminal_states: ["closed", "cancelled", "duplicate"],
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
    command: "pi --no-session",
    model: null,
    turn_timeout_ms: 3_600_000,
    stall_timeout_ms: 300_000,
  },
  log: {
    file: null,
  },
  server: {
    port: null,
    hostname: "127.0.0.1",
  },
};

const DEFAULT_PROMPT = `You are working on a Beads issue.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
Description: {{ issue.description }}
Priority: {{ issue.priority }}
Labels: {{ issue.labels }}

## Workflow

Follow these steps in order:

### 1. Create a feature branch
\`\`\`bash
git checkout -b issue/{{ issue.identifier }}
\`\`\`

### 2. Implement the solution
- Make the necessary code changes
- Commit your work with clear, descriptive messages:
  \`\`\`bash
  git add -A
  git commit -m "issue/{{ issue.identifier }}: <describe what changed>"
  \`\`\`

### 3. Push the branch
\`\`\`bash
git push origin HEAD
\`\`\`

### 4. Move the issue to review
\`\`\`bash
bd update {{ issue.identifier }} --status review
\`\`\`

### 5. Add a summary comment
\`\`\`bash
bd comment {{ issue.identifier }} "Summary of changes: <describe what was done and any notes for the reviewer>"
\`\`\`

**Important**: Do NOT mark the issue as done. Moving it to \`review\` hands it off
to a human reviewer. The reviewer will either accept (move to done) or request
rework (move back to open).
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
    merge(cfg, "server", raw);
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
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colon).trim();
    const raw = trimmed.slice(colon + 1).trim();
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      if (!raw || raw.startsWith("#")) {
        section = key;
        if (!result[section]) result[section] = {};
      }
      // else: Top-level scalar — ignore (we only support sections)
      i++;
    } else if (section && result[section]) {
      // Check for YAML literal block scalar (pipe syntax)
      if (raw === "|" || raw === "|-" || raw === "|+") {
        const chopMode = raw === "|-" ? "strip" : raw === "|+" ? "keep" : "clip";
        const keyIndent = indent;
        const blockLines: string[] = [];
        let blockIndent: number | null = null;
        i++;

        while (i < lines.length) {
          const bLine = lines[i]!;
          const bTrimmed = bLine.trim();

          // Empty/whitespace-only lines are preserved inside the block
          if (!bTrimmed) {
            blockLines.push("");
            i++;
            continue;
          }

          const bIndent = bLine.length - bLine.trimStart().length;

          if (blockIndent === null) {
            // First content line determines the block indent level
            if (bIndent > keyIndent) {
              blockIndent = bIndent;
            } else {
              break; // Not indented enough — empty block
            }
          }

          if (bIndent < blockIndent) {
            break; // Dedented — end of block
          }

          blockLines.push(bLine.slice(blockIndent));
          i++;
        }

        // Trim trailing empty lines for clip/strip modes
        if (chopMode !== "keep") {
          while (blockLines.length > 0 && blockLines[blockLines.length - 1] === "") {
            blockLines.pop();
          }
        }

        let text: string;
        if (chopMode === "strip") {
          text = blockLines.join("\n");
        } else {
          // clip and keep both end with \n (keep preserves extra blanks above)
          text = blockLines.length > 0 ? blockLines.join("\n") + "\n" : "";
        }

        result[section]![key] = text;
      } else {
        result[section]![key] = coerceValue(raw);
        i++;
      }
    } else {
      i++;
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