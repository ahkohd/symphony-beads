import { describe, expect, it } from "bun:test";
import { parseWorkflow, validateConfig } from "./config.ts";
import type { ServiceConfig } from "./types.ts";

// ---------------------------------------------------------------------------
// Defaults & front-matter splitting
// ---------------------------------------------------------------------------

describe("parseWorkflow defaults", () => {
  it("returns defaults when no front-matter", () => {
    const wf = parseWorkflow("Just a prompt.");
    expect(wf.config.tracker.kind).toBe("beads");
    expect(wf.config.agent.max_concurrent).toBe(5);
    expect(wf.config.polling.interval_ms).toBe(30_000);
    expect(wf.config.runner.command).toBe("pi --no-session");
    expect(wf.config.hooks.after_create).toBeNull();
    expect(wf.prompt_template).toBe("Just a prompt.");
  });

  it("returns default prompt when body is empty", () => {
    const wf = parseWorkflow(`---
agent:
  max_concurrent: 2
---
`);
    expect(wf.prompt_template).toContain("{{ issue.identifier }}");
  });

  it("uses provided prompt body over default", () => {
    const wf = parseWorkflow(`---
agent:
  max_concurrent: 2
---
Custom prompt: {{ issue.title }}`);
    expect(wf.prompt_template).toBe("Custom prompt: {{ issue.title }}");
  });
});

// ---------------------------------------------------------------------------
// YAML parsing of scalar types
// ---------------------------------------------------------------------------

describe("parseWorkflow YAML scalar coercion", () => {
  it("coerces booleans", () => {
    const wf = parseWorkflow(`---
runner:
  command: pi
  model: null
---
Prompt.`);
    expect(wf.config.runner.model).toBeNull();
  });

  it("coerces integers and floats", () => {
    const wf = parseWorkflow(`---
agent:
  max_concurrent: 10
  max_retry_backoff_ms: 600000
polling:
  interval_ms: 5000
---
Prompt.`);
    expect(wf.config.agent.max_concurrent).toBe(10);
    expect(wf.config.agent.max_retry_backoff_ms).toBe(600000);
    expect(wf.config.polling.interval_ms).toBe(5000);
  });

  it("strips inline comments", () => {
    const wf = parseWorkflow(`---
agent:
  max_concurrent: 3  # keep low
---
Prompt.`);
    expect(wf.config.agent.max_concurrent).toBe(3);
  });

  it("strips surrounding quotes from strings", () => {
    const wf = parseWorkflow(`---
runner:
  command: "pi -p --no-session"
---
Prompt.`);
    expect(wf.config.runner.command).toBe("pi -p --no-session");
  });

  it("parses inline arrays", () => {
    const wf = parseWorkflow(`---
tracker:
  active_states: [open, in_progress, review]
---
Prompt.`);
    expect(wf.config.tracker.active_states).toEqual(["open", "in_progress", "review"]);
  });
});

// ---------------------------------------------------------------------------
// Environment variable resolution
// ---------------------------------------------------------------------------

describe("parseWorkflow env resolution", () => {
  it("resolves $ENV_VAR in tracker fields", () => {
    const orig = process.env.SYMPHONY_TEST_PATH;
    process.env.SYMPHONY_TEST_PATH = "/custom/path";
    try {
      const wf = parseWorkflow(`---
tracker:
  project_path: $SYMPHONY_TEST_PATH
---
Prompt.`);
      expect(wf.config.tracker.project_path).toBe("/custom/path");
    } finally {
      if (orig === undefined) delete process.env.SYMPHONY_TEST_PATH;
      else process.env.SYMPHONY_TEST_PATH = orig;
    }
  });

  it("leaves $VAR unchanged if env var not set", () => {
    delete process.env.__SYMPHONY_NONEXISTENT__;
    const wf = parseWorkflow(`---
tracker:
  project_path: $__SYMPHONY_NONEXISTENT__
---
Prompt.`);
    expect(wf.config.tracker.project_path).toBe("$__SYMPHONY_NONEXISTENT__");
  });
});

// ---------------------------------------------------------------------------
// Path resolution (tilde expansion)
// ---------------------------------------------------------------------------

describe("parseWorkflow path resolution", () => {
  it("expands ~ in workspace.root", () => {
    const wf = parseWorkflow(`---
workspace:
  root: ~/my-workspaces
---
Prompt.`);
    const home = process.env.HOME || process.env.USERPROFILE || "";
    expect(wf.config.workspace.root).toBe(home + "/my-workspaces");
  });

  it("expands ~ in log.file", () => {
    const wf = parseWorkflow(`---
log:
  file: ~/logs/symphony.log
---
Prompt.`);
    const home = process.env.HOME || process.env.USERPROFILE || "";
    expect(wf.config.log.file).toBe(home + "/logs/symphony.log");
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe("validateConfig", () => {
  function makeConfig(overrides: Partial<Record<string, unknown>> = {}): ServiceConfig {
    const wf = parseWorkflow("Prompt.");
    const cfg = wf.config;
    // Apply overrides at the nested level
    for (const [path, val] of Object.entries(overrides)) {
      const parts = path.split(".");
      let target: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
      for (let i = 0; i < parts.length - 1; i++) {
        target = target[parts[i]!] as Record<string, unknown>;
      }
      target[parts[parts.length - 1]!] = val;
    }
    return cfg;
  }

  it("returns no errors for valid defaults", () => {
    const errors = validateConfig(makeConfig());
    expect(errors).toEqual([]);
  });

  it("rejects unsupported tracker kind", () => {
    const errors = validateConfig(makeConfig({ "tracker.kind": "jira" }));
    expect(errors).toContainEqual(expect.stringContaining("unsupported tracker kind"));
  });

  it("rejects empty runner command", () => {
    const errors = validateConfig(makeConfig({ "runner.command": "" }));
    expect(errors).toContainEqual(expect.stringContaining("runner.command is empty"));
  });

  it("rejects max_concurrent < 1", () => {
    const errors = validateConfig(makeConfig({ "agent.max_concurrent": 0 }));
    expect(errors).toContainEqual(expect.stringContaining("max_concurrent"));
  });

  it("rejects polling interval < 1000", () => {
    const errors = validateConfig(makeConfig({ "polling.interval_ms": 500 }));
    expect(errors).toContainEqual(expect.stringContaining("interval_ms"));
  });

  it("can accumulate multiple errors", () => {
    const errors = validateConfig(
      makeConfig({ "runner.command": "", "agent.max_concurrent": -1, "polling.interval_ms": 0 }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// YAML pipe strings (existing tests, kept intact)
// ---------------------------------------------------------------------------

describe("parseWorkflow YAML pipe strings", () => {
  it("parses basic pipe (|) multiline hook", () => {
    const content = `---
hooks:
  after_create: |
    git clone $REPO_URL .
    npm install
---

Prompt text here.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\nnpm install\n");
  });

  it("parses pipe-strip (|-) without trailing newline", () => {
    const content = `---
hooks:
  after_create: |-
    git clone $REPO_URL .
    npm install
---

Prompt text here.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\nnpm install");
  });

  it("parses pipe-keep (|+) preserving trailing blank lines", () => {
    const content = `---
hooks:
  after_create: |+
    git clone $REPO_URL .
    npm install

---

Prompt text here.
`;
    const wf = parseWorkflow(content);
    // |+ keeps trailing empty lines plus final newline
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\nnpm install\n\n");
  });

  it("parses multiple pipe hooks", () => {
    const content = `---
hooks:
  after_create: |
    git clone $REPO_URL .
    npm install
  before_run: |
    git fetch origin
    git checkout -B issue-branch
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\nnpm install\n");
    expect(wf.config.hooks.before_run).toBe("git fetch origin\ngit checkout -B issue-branch\n");
  });

  it("still parses single-line values correctly", () => {
    const content = `---
hooks:
  after_create: echo hello
  timeout_ms: 30000
workspace:
  root: ./workspaces
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("echo hello");
    expect(wf.config.hooks.timeout_ms).toBe(30000);
    expect(wf.config.workspace.root).toContain("workspaces");
  });

  it("handles pipe block with empty lines in the middle", () => {
    const content = `---
hooks:
  after_create: |
    echo "step 1"

    echo "step 2"
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe('echo "step 1"\n\necho "step 2"\n');
  });

  it("handles pipe followed by another section", () => {
    const content = `---
hooks:
  after_create: |
    git clone $REPO_URL .
agent:
  max_concurrent: 3
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\n");
    expect(wf.config.agent.max_concurrent).toBe(3);
  });

  it("returns null for hooks not specified", () => {
    const content = `---
hooks:
  timeout_ms: 5000
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBeNull();
    expect(wf.config.hooks.before_run).toBeNull();
  });
});
