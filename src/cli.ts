#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Symphony CLI — Beads Edition
//
// Subcommands:
//   start     Start the orchestrator daemon
//   status    Show current orchestrator state
//   validate  Validate WORKFLOW.md
//   init      Initialize a new WORKFLOW.md
//   instances List all running symphony instances
//   doctor    Verify dependencies, config, and runtime state
//   logs      Tail the symphony log file
//   stop      Stop a running symphony instance
//
// Global flags:
//   --json          JSON output
//   --workflow PATH  Path to WORKFLOW.md (default: ./WORKFLOW.md)
//   --verbose        Verbose logging
//   -h, --help       Show help
//   -v, --version    Show version
// ---------------------------------------------------------------------------

import { resolve, dirname } from "path";
import { parseWorkflow, validateConfig } from "./config.ts";
import { BeadsTracker } from "./tracker.ts";
import { WorkspaceManager } from "./workspace.ts";
import { Orchestrator } from "./orchestrator.ts";
import { WorkflowWatcher } from "./watcher.ts";
import { log, setJsonMode, isJsonMode, setLogFile } from "./log.ts";
import { PrMonitor } from "./pr-monitor.ts";
import { runDoctor } from "./doctor.ts";
import { HttpDashboard } from "./server.ts";
import {
  acquireLock,
  releaseLock,
  registerInstance,
  unregisterInstance,
  checkWorkspaceCollisions,
  listInstances,
  readProjectLock,
  isPidAlive,
} from "./lock.ts";

const VERSION = "0.1.0";

// -- Arg parsing -------------------------------------------------------------

interface Args {
  command: string;
  json: boolean;
  workflow: string;
  port: number | null;
  verbose: boolean;
  follow: boolean;
  lines: number;
  all: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    json: false,
    workflow: "WORKFLOW.md",
    port: null,
    verbose: false,
    follow: false,
    lines: 50,
    all: false,
  };

  const positional: string[] = [];
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--workflow":
        args.workflow = argv[++i] ?? "WORKFLOW.md";
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--port":
        args.port = parseInt(argv[++i] ?? "", 10);
        if (isNaN(args.port) || args.port < 1) args.port = null;
        break;
      case "-f":
      case "--follow":
        args.follow = true;
        break;
      case "--lines":
      case "-n":
        args.lines = parseInt(argv[++i] ?? "50", 10);
        if (isNaN(args.lines) || args.lines < 1) args.lines = 50;
        break;
      case "--all":
        args.all = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      default:
        if (arg.startsWith("-")) {
          error(`unknown flag: ${arg}`);
        }
        positional.push(arg);
    }
  }

  // Handle help/version after collecting all flags so --json works
  if (help) {
    printUsage();
    process.exit(0);
  }
  if (version) {
    printVersion(args.json);
    process.exit(0);
  }

  args.command = positional[0] ?? "";
  return args;
}

// -- Subcommands -------------------------------------------------------------

async function cmdStart(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow);
  const config = workflow.config;

  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const e of errors) log.error(e);
    process.exit(1);
  }

  // Set up per-project log file if configured
  if (config.log.file) {
    await setLogFile(config.log.file);
  }

  const projectDir = resolve(dirname(args.workflow));
  const workspaceRoot = resolve(config.workspace.root);

  // 1. Acquire project-level lock (prevents duplicate instances)
  let lockPath: string;
  try {
    lockPath = await acquireLock(projectDir, workspaceRoot, args.workflow);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (args.json) {
      console.log(JSON.stringify({ error: "lock_failed", message: msg }));
    } else {
      log.error(msg);
    }
    process.exit(1);
  }

  // 2. Register in global instance registry & check for workspace collisions
  const lockInfo = {
    pid: process.pid,
    project_path: resolve(projectDir),
    workspace_root: workspaceRoot,
    workflow_file: args.workflow,
    started_at: new Date().toISOString(),
  };
  await registerInstance(lockInfo);

  const conflicts = await checkWorkspaceCollisions(projectDir, workspaceRoot);
  if (conflicts.length > 0) {
    for (const c of conflicts) {
      log.warn("workspace root collision detected", {
        other_project: c.project_path,
        other_pid: c.pid,
        shared_workspace: c.workspace_root,
      });
    }
    if (args.json) {
      console.log(
        JSON.stringify({
          error: "workspace_collision",
          conflicts: conflicts.map((c) => ({
            project: c.project_path,
            pid: c.pid,
            workspace: c.workspace_root,
          })),
        }),
      );
    } else {
      log.error(
        "Aborting: another symphony instance is using the same workspace root. " +
          "Change workspace.root in your WORKFLOW.md to avoid conflicts.",
      );
    }
    await releaseLock(projectDir);
    await unregisterInstance(projectDir);
    process.exit(1);
  }

  if (!args.json) {
    log.info("symphony-beads starting", {
      pid: process.pid,
      tracker: config.tracker.kind,
      project: config.tracker.project_path,
      workspace_root: workspaceRoot,
      poll_ms: config.polling.interval_ms,
      max_concurrent: config.agent.max_concurrent,
      runner: config.runner.command,
      log_file: config.log.file ?? "(stdout)",
    });
  }

  const tracker = new BeadsTracker(config);
  const workspace = new WorkspaceManager(config);
  const orchestrator = new Orchestrator(config, workflow.prompt_template, tracker, workspace);

  // Watch WORKFLOW.md for changes and hot-reload config (spec §6.2)
  const workflowAbsPath = resolve(args.workflow);
  const watcher = new WorkflowWatcher(workflowAbsPath, orchestrator);
  await watcher.start();

  // Monitor GitHub PRs — auto-close on merge, reopen on changes requested
  const prMonitor = new PrMonitor(config);
  prMonitor.start();

  // Graceful shutdown with cleanup
  const shutdown = async () => {
    prMonitor.stop();
    watcher.stop();
    orchestrator.stop();
    await releaseLock(projectDir);
    await unregisterInstance(projectDir);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());

  await orchestrator.start();
}

async function cmdStatus(args: Args): Promise<void> {
  // Status reads from a running orchestrator. For now, query beads directly.
  const workflow = await loadWorkflow(args.workflow);
  const tracker = new BeadsTracker(workflow.config);
  const candidates = await tracker.fetchCandidates();
  const terminalIds = await tracker.fetchTerminalIds();

  const output = {
    candidates: candidates.length,
    terminal: terminalIds.length,
    issues: candidates.map((i) => ({
      id: i.id,
      title: i.title,
      state: i.state,
      priority: i.priority,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    log.info("issue status", { candidates: output.candidates, terminal: output.terminal });
    for (const issue of output.issues) {
      console.log(`  ${issue.id}  P${issue.priority ?? "-"}  [${issue.state}]  ${issue.title}`);
    }
    if (output.issues.length === 0) {
      console.log("  (no active issues)");
    }
  }
}

async function cmdValidate(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow);
  const errors = validateConfig(workflow.config);

  // Check for workspace collisions with other running instances
  const projectDir = resolve(dirname(args.workflow));
  const workspaceRoot = resolve(workflow.config.workspace.root);
  const conflicts = await checkWorkspaceCollisions(projectDir, workspaceRoot);
  const warnings: string[] = [];
  for (const c of conflicts) {
    warnings.push(
      `workspace root collision: "${workspaceRoot}" is also used by project "${c.project_path}" (PID ${c.pid})`,
    );
  }

  const output = {
    valid: errors.length === 0,
    errors,
    warnings,
    config: workflow.config,
    prompt_template_length: workflow.prompt_template.length,
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
  } else if (errors.length === 0) {
    log.info("workflow is valid", { file: args.workflow });
    console.log(`  tracker:        ${workflow.config.tracker.kind}`);
    console.log(`  project:        ${workflow.config.tracker.project_path}`);
    console.log(`  runner:         ${workflow.config.runner.command}`);
    console.log(`  max_concurrent: ${workflow.config.agent.max_concurrent}`);
    console.log(`  poll_ms:        ${workflow.config.polling.interval_ms}`);
    console.log(`  prompt:         ${workflow.prompt_template.length} chars`);
    for (const w of warnings) {
      log.warn(w);
    }
  } else {
    log.error("workflow has errors", { file: args.workflow });
    for (const e of errors) {
      console.log(`  - ${e}`);
    }
    for (const w of warnings) {
      log.warn(w);
    }
    process.exit(1);
  }
}

async function cmdInit(args: Args): Promise<void> {
  const path = args.workflow;
  const file = Bun.file(path);
  if (await file.exists()) {
    if (args.json) {
      console.log(JSON.stringify({ error: "file already exists", path }));
    } else {
      log.error(`${path} already exists`);
    }
    process.exit(1);
  }

  await Bun.write(path, DEFAULT_WORKFLOW);

  // Configure the 'review' custom status in beads so agents can use it.
  // This status is intentionally NOT in active_states or terminal_states,
  // causing the orchestrator to stop the agent while preserving the workspace.
  const { exec: execCmd } = await import("./exec.ts");
  const configResult = await execCmd(["bd", "config", "set", "status.custom", "review"], {
    cwd: process.cwd(),
  });
  const reviewConfigured = configResult.code === 0;

  if (args.json) {
    console.log(JSON.stringify({ created: path, review_status_configured: reviewConfigured }));
  } else {
    log.info("created workflow file", { path });
    if (reviewConfigured) {
      log.info("configured beads custom status: review");
    } else {
      log.warn(
        "could not configure 'review' custom status — run: bd config set status.custom \"review\"",
      );
    }
  }
}

async function cmdInstances(args: Args): Promise<void> {
  const instances = await listInstances();

  if (args.json) {
    console.log(JSON.stringify({ instances }, null, 2));
    return;
  }

  if (instances.length === 0) {
    console.log("No running symphony instances.");
    return;
  }

  console.log(`Running symphony instances (${instances.length}):\n`);
  for (const inst of instances) {
    console.log(`  PID:        ${inst.pid}`);
    console.log(`  Project:    ${inst.project_path}`);
    console.log(`  Workspace:  ${inst.workspace_root}`);
    console.log(`  Workflow:   ${inst.workflow_file}`);
    console.log(`  Started:    ${inst.started_at}`);
    console.log("");
  }
}

async function cmdDoctor(args: Args): Promise<void> {
  const report = await runDoctor(args.workflow);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("");
    const maxName = Math.max(...report.checks.map((c) => c.name.length));
    for (const check of report.checks) {
      const status = check.ok ? "ok  " : "FAIL";
      const pad = check.name.padEnd(maxName);
      console.log(`  ${pad}  ${status}  ${check.detail}`);
    }
    console.log("");
    if (report.ok) {
      console.log("  All checks passed.");
    } else {
      const failed = report.checks.filter((c) => !c.ok).length;
      console.log(`  ${failed} check(s) failed.`);
    }
    console.log("");
  }

  if (!report.ok) process.exit(1);
}

async function cmdLogs(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow);
  const logFile = workflow.config.log.file;

  if (!logFile) {
    if (args.json) {
      console.log(JSON.stringify({ error: "no_log_file", message: "no log file configured in WORKFLOW.md (log.file)" }));
    } else {
      log.error("no log file configured in WORKFLOW.md (log.file)");
    }
    process.exit(1);
  }

  const resolvedPath = resolve(dirname(args.workflow), logFile);
  const file = Bun.file(resolvedPath);

  if (!(await file.exists())) {
    if (args.json) {
      console.log(JSON.stringify({ error: "log_file_not_found", path: resolvedPath }));
    } else {
      log.error(`log file not found: ${resolvedPath}`);
    }
    process.exit(1);
  }

  // Read and output the last N lines
  const content = await file.text();
  const allLines = content.split("\n");
  // Remove trailing empty line from split
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  const startIdx = Math.max(0, allLines.length - args.lines);
  const tailLines = allLines.slice(startIdx);

  if (args.json) {
    // Output raw JSON log lines — each line in the log file is already JSON
    for (const line of tailLines) {
      if (line.trim()) console.log(line);
    }
  } else {
    for (const line of tailLines) {
      if (line.trim()) console.log(line);
    }
  }

  // Follow mode: watch file for new content and stream it
  if (args.follow) {
    let offset = content.length;
    const { watch } = await import("fs");

    const watcher = watch(resolvedPath, async () => {
      try {
        const f = Bun.file(resolvedPath);
        const size = f.size;
        if (size <= offset) {
          // File was truncated/rotated — reset
          if (size < offset) offset = 0;
          return;
        }
        const newContent = await f.slice(offset, size).text();
        offset = size;
        const newLines = newContent.split("\n");
        for (const line of newLines) {
          if (line.trim()) console.log(line);
        }
      } catch {
        // File may have been removed — ignore
      }
    });

    // Also poll periodically since fs.watch may miss events on some systems
    const pollInterval = setInterval(async () => {
      try {
        const f = Bun.file(resolvedPath);
        const size = f.size;
        if (size <= offset) {
          if (size < offset) offset = 0;
          return;
        }
        const newContent = await f.slice(offset, size).text();
        offset = size;
        const newLines = newContent.split("\n");
        for (const line of newLines) {
          if (line.trim()) console.log(line);
        }
      } catch {
        // ignore
      }
    }, 1000);

    // Keep process alive; clean up on SIGINT/SIGTERM
    const cleanup = () => {
      watcher.close();
      clearInterval(pollInterval);
      process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    // Block forever
    await new Promise(() => {});
  }
}

// -- Helpers -----------------------------------------------------------------

async function loadWorkflow(path: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (isJsonMode()) {
      console.log(JSON.stringify({ error: "workflow file not found", path }));
    } else {
      log.error(`workflow file not found: ${path}`);
      console.log(`\nRun: symphony init`);
    }
    process.exit(1);
  }
  const content = await file.text();
  return parseWorkflow(content);
}

function printUsage(): void {
  console.log(`symphony-beads ${VERSION}

Usage: symphony <command> [flags]

Commands:
  start      Start the orchestrator daemon
  status     Show current issue status from beads
  validate   Validate WORKFLOW.md configuration
  init       Create a new WORKFLOW.md
  instances  List all running symphony instances
  doctor     Verify dependencies, config, and runtime state
  logs       Tail the symphony log file
  stop       Stop a running symphony instance

Flags:
  --json           Output as JSON
  --workflow PATH   Workflow file (default: WORKFLOW.md)
  --verbose         Verbose output
  -h, --help        Show this help
  -v, --version     Show version

Logs flags:
  -f, --follow     Follow the log file (like tail -f)
  -n, --lines N    Number of lines to show (default: 50)

Stop flags:
  --all            Stop all registered symphony instances`);
}

function printVersion(json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ version: VERSION }));
  } else {
    console.log(`symphony-beads ${VERSION}`);
  }
}

function error(msg: string): never {
  console.error(`error: ${msg}\n`);
  printUsage();
  process.exit(1);
}

const DEFAULT_WORKFLOW = `---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: ./workspaces
agent:
  max_concurrent: 5
  max_turns: 20
runner:
  command: pi -p --no-session
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
polling:
  interval_ms: 30000
hooks:
  after_create: |
    git clone $REPO_URL . 2>/dev/null || true
    rm -rf .beads 2>/dev/null; ln -sf "$SYMPHONY_PROJECT_PATH/.beads" .beads
  before_run: |
    git fetch origin 2>/dev/null || true
    if git rev-parse --verify origin/issue/$SYMPHONY_ISSUE_ID >/dev/null 2>&1; then
      git checkout -B issue/$SYMPHONY_ISSUE_ID origin/issue/$SYMPHONY_ISSUE_ID
    else
      git checkout -B issue/$SYMPHONY_ISSUE_ID origin/HEAD 2>/dev/null || git checkout -B issue/$SYMPHONY_ISSUE_ID
    fi
log:
  file: ./symphony.log
---

You are working on a Beads issue.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
Description: {{ issue.description }}
Priority: {{ issue.priority }}
Labels: {{ issue.labels }}

## Workflow

Follow these steps in order:

### 1. Implement the solution
- You are on branch issue/{{ issue.identifier }}
- Make the necessary code changes
- Commit your work with clear, descriptive messages:
  \`\`\`bash
  git add -A
  git commit -m "{{ issue.identifier }}: <describe what changed>"
  \`\`\`

### 2. Push and create a pull request
\`\`\`bash
git push -u origin HEAD
gh pr create --title "{{ issue.identifier }}: {{ issue.title }}" --body "Resolves {{ issue.identifier }}" --fill 2>/dev/null || true
\`\`\`

### 3. Hand off for review
\`\`\`bash
bd update {{ issue.identifier }} --status review
bd comment {{ issue.identifier }} "PR pushed. Summary: <describe what was done>"
\`\`\`

**Important**: Do NOT mark the issue as done. Moving to \`review\` hands off to
a human reviewer. They will merge the PR and mark done, or request rework.
`;

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.json) setJsonMode(true);

  switch (args.command) {
    case "start":
      await cmdStart(args);
      break;
    case "status":
      await cmdStatus(args);
      break;
    case "validate":
      await cmdValidate(args);
      break;
    case "init":
      await cmdInit(args);
      break;
    case "instances":
      await cmdInstances(args);
      break;
    case "doctor":
      await cmdDoctor(args);
      break;
    case "logs":
      await cmdLogs(args);
      break;
    case "stop":
      await cmdStop(args);
      break;
    case "":
      error("no command specified");
    default:
      error(`unknown command: ${args.command}`);
  }
}

main().catch((err) => {
  if (isJsonMode()) {
    console.error(JSON.stringify({ error: String(err) }));
  } else {
    log.error(String(err));
  }
  process.exit(1);
});
