#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Symphony CLI — Beads Edition
//
// Subcommands:
//   start     Start the orchestrator (daemonizes by default; -f for foreground)
//   status    Show current orchestrator state
//   validate  Validate WORKFLOW.md
//   init      Initialize a new WORKFLOW.md
//   instances List all running symphony instances
//   doctor    Verify dependencies, config, and runtime state
//   logs      Tail the symphony log file
//   stop      Stop a running symphony instance
//   dashboard Launch the live agent status dashboard
//
// Global flags:
//   --json          JSON output
//   --workflow PATH  Path to WORKFLOW.md (default: ./WORKFLOW.md)
//   --verbose        Verbose logging
//   -h, --help       Show help
//   -v, --version    Show version
// ---------------------------------------------------------------------------

import { resolve, dirname, join, parse as parsePath } from "path";
import { existsSync } from "fs";
import { parseWorkflow, validateConfig } from "./config.ts";
import type { ServiceConfig } from "./types.ts";
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
  updateLockHttpInfo,
} from "./lock.ts";

const VERSION = "0.1.0";

// -- Arg parsing -------------------------------------------------------------

interface Args {
  command: string;
  json: boolean;
  workflow: string;
  port: number | null;
  host: string;
  verbose: boolean;
  foreground: boolean;
  follow: boolean;
  shortF: boolean;
  lines: number;
  all: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    json: false,
    workflow: "WORKFLOW.md",
    port: null,
    host: "127.0.0.1",
    verbose: false,
    foreground: false,
    follow: false,
    shortF: false,
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
      case "--foreground":
        args.foreground = true;
        break;
      case "-f":
        args.shortF = true; // resolved per-command in main(): start → foreground, logs → follow
        break;
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

  // If not foreground, daemonize by spawning a child with --foreground
  if (!args.foreground) {
    await daemonize(args, config);
    return;
  }

  // --- Foreground mode (the actual orchestrator logic) ---
  await cmdStartForeground(args, workflow);
}

/**
 * Daemonize: spawn a child process running `symphony start --foreground`,
 * redirect stdout/stderr to the log file, print PID, and exit.
 */
async function daemonize(args: Args, config: ReturnType<typeof parseWorkflow>["config"]): Promise<void> {
  const projectDir = resolve(dirname(args.workflow));

  // Pre-flight: check if already running (before spawning child)
  const existingLock = await readProjectLock(projectDir);
  if (existingLock && isPidAlive(existingLock.pid)) {
    const msg = `symphony is already running (PID ${existingLock.pid}). Use symphony stop first.`;
    if (args.json) {
      console.log(JSON.stringify({ error: "already_running", pid: existingLock.pid, message: msg }));
    } else {
      log.error(msg);
    }
    process.exit(1);
  }

  // Determine log file path — required for daemon mode
  const logFile = config.log.file
    ? resolve(dirname(args.workflow), config.log.file)
    : resolve(dirname(args.workflow), "symphony.log");

  // Ensure log directory exists
  const { mkdir: mkdirFs } = await import("fs/promises");
  const { openSync, closeSync } = await import("fs");
  await mkdirFs(dirname(logFile), { recursive: true });

  // Open log file in append mode so daemon restarts don't truncate history
  const logFd = openSync(logFile, "a");

  // Build the child command args: replay original args but add --foreground
  const childArgs: string[] = ["start", "--foreground"];
  if (args.json) childArgs.push("--json");
  if (args.workflow !== "WORKFLOW.md") childArgs.push("--workflow", args.workflow);
  if (args.verbose) childArgs.push("--verbose");
  if (args.port !== null) childArgs.push("--port", String(args.port));

  // Spawn the daemon child. Use the same entry point (this script).
  // Both stdout and stderr share the same fd so all output goes to one log file.
  const entryPoint = resolve(import.meta.dir, "cli.ts");
  const child = Bun.spawn(["bun", entryPoint, ...childArgs], {
    cwd: process.cwd(),
    stdout: logFd,
    stderr: logFd,
    stdin: "ignore",
    detached: true,
    env: { ...process.env, SYMPHONY_DAEMON: "1" },
  });

  // Detach from parent — child runs in its own session (setsid)
  child.unref();

  // Brief wait to verify the child started successfully
  await Bun.sleep(500);

  // Close the log fd in the parent — the child inherited its own copy
  try { closeSync(logFd); } catch { /* ignore */ }

  // Check if child is still alive
  if (child.exitCode !== null) {
    // Child already exited — something went wrong
    const msg = `daemon failed to start (exit code ${child.exitCode}). Check ${logFile} for details.`;
    if (args.json) {
      console.log(JSON.stringify({ error: "daemon_failed", exit_code: child.exitCode, log_file: logFile }));
    } else {
      log.error(msg);
    }
    process.exit(1);
  }

  // Success — print PID and exit
  if (args.json) {
    console.log(JSON.stringify({ started: true, pid: child.pid, log_file: logFile }));
  } else {
    console.log(`symphony started (PID ${child.pid})`);
  }

  process.exit(0);
}

/**
 * Foreground start: the actual orchestrator. Blocks the terminal.
 * This is what the daemonized child runs, or what --foreground invokes directly.
 */
async function cmdStartForeground(
  args: Args,
  workflow: ReturnType<typeof parseWorkflow>,
): Promise<void> {
  const config = workflow.config;

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

  // Start optional HTTP dashboard (spec §13.7)
  let httpDashboard: HttpDashboard | null = null;
  const serverPort = args.port ?? config.server?.port ?? null;
  if (serverPort) {
    const httpHostname = config.server?.hostname ?? "127.0.0.1";
    httpDashboard = new HttpDashboard(orchestrator, tracker, {
      port: serverPort,
      hostname: httpHostname,
    });
    httpDashboard.start();
    // Write HTTP port to lock file so TUI can discover it
    await updateLockHttpInfo(projectDir, serverPort, httpHostname);
  }

  // Graceful shutdown with cleanup
  const shutdown = async () => {
    httpDashboard?.stop();
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
  const workflow = await loadWorkflow(args.workflow);
  const projectDir = resolve(dirname(args.workflow));

  // Try to fetch live orchestrator state (includes token counts)
  const { OrchestratorClient } = await import("./tui/live-client.ts");
  const client = new OrchestratorClient(projectDir);
  const liveSnap = await client.fetchLiveState();

  if (liveSnap) {
    // Live orchestrator is running — show rich status with tokens
    if (args.json) {
      console.log(JSON.stringify(liveSnap, null, 2));
    } else {
      const c = liveSnap.counts;
      const t = liveSnap.totals;
      console.log(`  Running: ${c.running}  Retrying: ${c.retrying}  Completed: ${c.completed}  Claimed: ${c.claimed}`);
      console.log(`  Tokens:  ${fmtTokens(t.input_tokens)} in / ${fmtTokens(t.output_tokens)} out / ${fmtTokens(t.cache_read_tokens ?? 0)} cache-read / ${fmtTokens(t.cache_write_tokens ?? 0)} cache-write (${fmtTokens(t.total_tokens)} total)`);
      if ((t.total_cost ?? 0) > 0) {
        console.log(`  Cost:    $${t.total_cost.toFixed(4)}`);
      }
      console.log(`  Uptime:  ${fmtDuration(t.seconds_running * 1000)}`);
      console.log("");

      if (liveSnap.running.length > 0) {
        console.log("  Running agents:");
        for (const r of liveSnap.running) {
          const tok = r.tokens.total > 0 ? ` [${fmtTokens(r.tokens.total)} tok, $${(r.tokens.cost ?? 0).toFixed(4)}]` : "";
          console.log(`    ${r.issue_identifier}  [${r.state}]  ${fmtDuration(r.elapsed_ms)}${tok}  ${r.title}`);
        }
        console.log("");
      }

      if (liveSnap.retrying.length > 0) {
        console.log("  Retrying:");
        for (const r of liveSnap.retrying) {
          console.log(`    ${r.identifier}  attempt ${r.attempt}  ${r.error ?? "continuation"}`);
        }
        console.log("");
      }
    }
    return;
  }

  // Fallback: no orchestrator running — query beads directly
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
    log.info("issue status (static — no orchestrator running)", { candidates: output.candidates, terminal: output.terminal });
    for (const issue of output.issues) {
      console.log(`  ${issue.id}  P${issue.priority ?? "-"}  [${issue.state}]  ${issue.title}`);
    }
    if (output.issues.length === 0) {
      console.log("  (no active issues)");
    }
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
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

async function cmdStop(args: Args): Promise<void> {
  if (args.all) {
    await cmdStopAll(args);
    return;
  }

  // Stop the instance for the current project
  const projectDir = resolve(dirname(args.workflow));
  const lockInfo = await readProjectLock(projectDir);

  if (!lockInfo) {
    if (args.json) {
      console.log(JSON.stringify({ error: "not_running", message: "No symphony instance running for this project" }));
    } else {
      log.info("no symphony instance running for this project");
    }
    process.exit(1);
  }

  const result = await stopProcess(lockInfo);

  // Clean up lock file and registry
  await releaseLock(projectDir);
  await unregisterInstance(projectDir);

  if (args.json) {
    console.log(JSON.stringify(result));
  } else {
    if (result.killed) {
      log.info(`stopped symphony instance`, { pid: result.pid, signal: result.signal });
    } else if (result.already_dead) {
      log.info(`instance was already stopped (stale lock cleaned up)`, { pid: result.pid });
    }
  }
}

async function cmdStopAll(args: Args): Promise<void> {
  const instances = await listInstances();

  if (instances.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ stopped: [], message: "No running instances" }));
    } else {
      console.log("No running symphony instances.");
    }
    return;
  }

  const results: Array<{ pid: number; project: string; killed: boolean; already_dead: boolean; signal: string }> = [];

  for (const inst of instances) {
    const result = await stopProcess(inst);
    results.push({ ...result, project: inst.project_path });

    // Clean up lock file and registry
    await releaseLock(inst.project_path);
    await unregisterInstance(inst.project_path);
  }

  if (args.json) {
    console.log(JSON.stringify({ stopped: results }));
  } else {
    for (const r of results) {
      if (r.killed) {
        log.info(`stopped instance`, { pid: r.pid, project: r.project, signal: r.signal });
      } else if (r.already_dead) {
        log.info(`cleaned up stale instance`, { pid: r.pid, project: r.project });
      }
    }
    console.log(`\nStopped ${results.filter(r => r.killed).length} instance(s), cleaned ${results.filter(r => r.already_dead).length} stale lock(s).`);
  }
}

/** Send SIGTERM, wait up to 5s for graceful shutdown, then SIGKILL if needed. */
async function stopProcess(info: { pid: number }): Promise<{ pid: number; killed: boolean; already_dead: boolean; signal: string }> {
  const { pid } = info;

  if (!isPidAlive(pid)) {
    return { pid, killed: false, already_dead: true, signal: "none" };
  }

  // Send SIGTERM for graceful shutdown
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { pid, killed: false, already_dead: true, signal: "none" };
  }

  // Wait up to 5 seconds for process to exit
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await Bun.sleep(250);
    if (!isPidAlive(pid)) {
      return { pid, killed: true, already_dead: false, signal: "SIGTERM" };
    }
  }

  // Still alive — force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may have died between check and kill
    return { pid, killed: true, already_dead: false, signal: "SIGTERM" };
  }

  // Brief wait for SIGKILL to take effect
  await Bun.sleep(500);

  return { pid, killed: true, already_dead: false, signal: "SIGKILL" };
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

async function cmdTui(): Promise<void> {
  const { launchKanban } = await import("./tui/app.tsx");
  await launchKanban();
}

async function cmdDashboard(args: Args): Promise<void> {
  const { launchDashboard } = await import("./tui/dashboard.tsx");
  const projectDir = resolve(dirname(args.workflow));
  await launchDashboard({ projectDir });
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
  const workflow = parseWorkflow(content);
  // Resolve relative config paths against the workflow directory so they
  // remain correct when symphony is invoked from a subdirectory.
  resolveConfigPaths(workflow.config, resolve(dirname(path)));
  return workflow;
}

/**
 * Resolve relative paths in the parsed config so they are absolute, anchored
 * to the project root (the directory containing WORKFLOW.md).  This makes all
 * downstream consumers (tracker, workspace, lock) independent of cwd.
 */
export function resolveConfigPaths(config: ServiceConfig, projectRoot: string): void {
  if (!isAbsoluteOrTilde(config.workspace.root)) {
    config.workspace.root = resolve(projectRoot, config.workspace.root);
  }
  if (!isAbsoluteOrTilde(config.tracker.project_path)) {
    config.tracker.project_path = resolve(projectRoot, config.tracker.project_path);
  }
  if (config.log.file && !isAbsoluteOrTilde(config.log.file)) {
    config.log.file = resolve(projectRoot, config.log.file);
  }
}

function isAbsoluteOrTilde(p: string): boolean {
  return p.startsWith("/") || p.startsWith("~");
}

function printUsage(): void {
  console.log(`symphony-beads ${VERSION}

Usage: symphony <command> [flags]

Commands:
  start      Start the orchestrator (daemonizes by default)
  status     Show current issue status from beads
  validate   Validate WORKFLOW.md configuration
  init       Create a new WORKFLOW.md
  instances  List all running symphony instances
  doctor     Verify dependencies, config, and runtime state
  logs       Tail the symphony log file
  stop       Stop a running symphony instance
  kanban     Interactive kanban board
  dashboard  Launch the live agent status dashboard

Flags:
  --json           Output as JSON
  --workflow PATH   Workflow file (default: WORKFLOW.md)
  --verbose         Verbose output
  -h, --help        Show this help
  -v, --version     Show version

Start flags:
  -f, --foreground  Run in foreground (don't daemonize)

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
  repo: $SYMPHONY_REPO
  remote: origin
agent:
  max_concurrent: 5
  max_turns: 20
runner:
  command: pi --no-session
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
polling:
  interval_ms: 30000
hooks:
  after_create: |
    git clone --single-branch --branch master $REPO_URL . 2>/dev/null || true
    bun install 2>/dev/null || npm install 2>/dev/null || true
    cat >> AGENTS.md << 'AGENTS'
    # Guidelines
    - Work ONLY within this directory. Do not read or write files outside of it.
    - Do not cd to parent directories or access ../
    - All file paths must be relative to the current working directory.
    - Use git to commit and push your changes when done.
    AGENTS
  before_run: |
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/$SYMPHONY_REMOTE/HEAD 2>/dev/null | sed "s|refs/remotes/$SYMPHONY_REMOTE/||" || echo "master")
    git fetch $SYMPHONY_REMOTE $DEFAULT_BRANCH 2>/dev/null || true
    git fetch $SYMPHONY_REMOTE issue/$SYMPHONY_ISSUE_ID 2>/dev/null || true
      git checkout -B issue/$SYMPHONY_ISSUE_ID $SYMPHONY_REMOTE/issue/$SYMPHONY_ISSUE_ID
    else
      git checkout -B issue/$SYMPHONY_ISSUE_ID $SYMPHONY_REMOTE/$DEFAULT_BRANCH
    fi
    git clean -fd 2>/dev/null || true
log:
  file: ./symphony.log
---

You are working on a single Beads issue. Work ONLY on this issue.
Do not implement other features, even if they seem related or you can
see other open issues on the board. One issue = one branch = one PR.

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

// -- Project root discovery ---------------------------------------------------

/**
 * Walk up from startDir looking for a project root marker (.git, .jj, or
 * WORKFLOW.md). Returns the directory containing the first marker found,
 * or startDir itself if no marker is found.
 */
export function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  while (true) {
    // Check for project root markers
    if (
      existsSync(join(dir, ".git")) ||
      existsSync(join(dir, ".jj")) ||
      existsSync(join(dir, "WORKFLOW.md"))
    ) {
      return dir;
    }

    const parent = parsePath(dir).dir;
    if (parent === dir) {
      // Reached filesystem root without finding a marker
      return resolve(startDir);
    }
    dir = parent;
  }
}

// -- Main --------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.json) setJsonMode(true);

  // Resolve -f shorthand based on command context
  if (args.shortF) {
    if (args.command === "start") {
      args.foreground = true;
    } else if (args.command === "logs") {
      args.follow = true;
    } else {
      // Default: treat -f as foreground for unknown commands
      args.foreground = true;
    }
  }

  // Auto-discover project root: walk up from cwd to find .git/.jj/WORKFLOW.md.
  // Resolve the workflow file relative to the found root so symphony can be
  // invoked from any subdirectory of a project.  Works for both the default
  // WORKFLOW.md and custom --workflow paths.
  if (!existsSync(resolve(args.workflow))) {
    const root = findProjectRoot(process.cwd());
    const candidate = resolve(root, args.workflow);
    if (existsSync(candidate)) {
      args.workflow = candidate;
    }
  }

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
    case "kanban":
      await cmdTui();
      break;
    case "dashboard":
      await cmdDashboard(args);
      break;
    case "":
      error("no command specified");
    default:
      error(`unknown command: ${args.command}`);
  }
}

// Only run main() when executed directly (not when imported for testing)
if (import.meta.main || process.argv[1]?.endsWith("/cli.ts")) {
  main().catch((err) => {
    if (isJsonMode()) {
      console.error(JSON.stringify({ error: String(err) }));
    } else {
      log.error(String(err));
    }
    process.exit(1);
  });
}
