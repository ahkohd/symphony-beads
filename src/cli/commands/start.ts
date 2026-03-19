import { dirname, resolve } from "node:path";
import { validateConfig } from "../../config.ts";
import {
  acquireLock,
  checkWorkspaceCollisions,
  isPidAlive,
  readProjectLock,
  registerInstance,
  releaseLock,
  unregisterInstance,
} from "../../lock.ts";
import { log, setLogFile } from "../../log.ts";
import { Orchestrator } from "../../orchestrator.ts";
import { PrMonitor } from "../../pr-monitor.ts";
import { BeadsTracker } from "../../tracker.ts";
import { WorkflowWatcher } from "../../watcher.ts";
import { WorkspaceManager } from "../../workspace.ts";
import { exitCommandError, printJson } from "../output.ts";
import type { Args } from "../types.ts";
import { loadWorkflow, type ParsedWorkflow } from "../workflow.ts";

export async function runStartCommand(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow, args.json);
  const errors = validateConfig(workflow.config);

  if (errors.length > 0) {
    for (const error of errors) {
      log.error(error);
    }
    process.exit(1);
  }

  if (!args.foreground) {
    await daemonize(args, workflow.config);
    return;
  }

  await runStartForeground(args, workflow);
}

async function daemonize(args: Args, config: ParsedWorkflow["config"]): Promise<void> {
  const projectDir = resolve(dirname(args.workflow));

  const existingLock = await readProjectLock(projectDir);
  if (existingLock && isPidAlive(existingLock.pid)) {
    const message = `symphony is already running (PID ${existingLock.pid}). Use symphony stop first.`;
    exitCommandError({
      args,
      payload: {
        error: "already_running",
        pid: existingLock.pid,
        message,
      },
      message,
    });
  }

  const logFile = config.log.file
    ? resolve(dirname(args.workflow), config.log.file)
    : resolve(dirname(args.workflow), "symphony.log");

  const { mkdir } = await import("node:fs/promises");
  const { closeSync, openSync } = await import("node:fs");
  await mkdir(dirname(logFile), { recursive: true });

  const logFd = openSync(logFile, "a");

  const childArgs: string[] = ["start", "--foreground"];
  if (args.json) childArgs.push("--json");
  if (args.workflow !== "WORKFLOW.md") childArgs.push("--workflow", args.workflow);
  if (args.verbose) childArgs.push("--verbose");

  const entryPoint = resolve(import.meta.dir, "..", "..", "cli.ts");
  const child = Bun.spawn(["bun", entryPoint, ...childArgs], {
    cwd: process.cwd(),
    stdout: logFd,
    stderr: logFd,
    stdin: "ignore",
    detached: true,
    env: { ...process.env, SYMPHONY_DAEMON: "1" },
  });

  child.unref();

  await Bun.sleep(500);

  try {
    closeSync(logFd);
  } catch {
    // ignore close errors
  }

  if (child.exitCode !== null) {
    const message = `daemon failed to start (exit code ${child.exitCode}). Check ${logFile} for details.`;
    exitCommandError({
      args,
      payload: {
        error: "daemon_failed",
        exit_code: child.exitCode,
        log_file: logFile,
      },
      message,
    });
  }

  if (args.json) {
    printJson({ started: true, pid: child.pid, log_file: logFile });
  } else {
    console.log(`symphony started (PID ${child.pid})`);
  }

  process.exit(0);
}

async function runStartForeground(args: Args, workflow: ParsedWorkflow): Promise<void> {
  const { config } = workflow;

  if (config.log.file) {
    await setLogFile(config.log.file);
  }

  const projectDir = resolve(dirname(args.workflow));
  const workspaceRoot = resolve(config.workspace.root);

  try {
    await acquireLock(projectDir, workspaceRoot, args.workflow);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitCommandError({
      args,
      payload: {
        error: "lock_failed",
        message,
      },
      message,
    });
  }

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
    for (const conflict of conflicts) {
      log.warn("workspace root collision detected", {
        other_project: conflict.project_path,
        other_pid: conflict.pid,
        shared_workspace: conflict.workspace_root,
      });
    }

    if (args.json) {
      printJson({
        error: "workspace_collision",
        conflicts: conflicts.map((conflict) => ({
          project: conflict.project_path,
          pid: conflict.pid,
          workspace: conflict.workspace_root,
        })),
      });
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

  const workflowPath = resolve(args.workflow);
  const watcher = new WorkflowWatcher(workflowPath, orchestrator);
  await watcher.start();

  const prMonitor = new PrMonitor(config);
  prMonitor.start();

  const shutdown = async () => {
    prMonitor.stop();
    watcher.stop();
    orchestrator.stop();
    await releaseLock(projectDir);
    await unregisterInstance(projectDir);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await orchestrator.start();
}
