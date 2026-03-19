import { dirname, resolve } from "node:path";
import { validateConfig } from "../../config.ts";
import {
  acquireLock,
  checkWorkspaceCollisions,
  getInstanceId,
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

const DAEMON_READY_TIMEOUT_MS = 10_000;
const DAEMON_READY_POLL_MS = 100;
const DAEMON_READY_STABILITY_MS = 300;

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
  const workflowPath = resolve(args.workflow);
  const projectDir = resolve(dirname(workflowPath));
  const instanceId = getInstanceId(projectDir);

  const existingLock = await readProjectLock(projectDir);
  if (existingLock && isPidAlive(existingLock.pid)) {
    const message = `symphony is already running (PID ${existingLock.pid}). Use symphony stop first.`;
    exitCommandError({
      args,
      payload: {
        error: "already_running",
        instance_id: instanceId,
        pid: existingLock.pid,
        project_dir: projectDir,
        workflow_file: workflowPath,
        message,
      },
      message,
    });
  }

  const logFile = config.log.file ?? resolve(projectDir, "symphony.log");

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

  const readiness = await waitForDaemonReadiness(projectDir, child.pid, child);

  try {
    closeSync(logFd);
  } catch {
    // ignore close errors
  }

  if (!readiness.ready) {
    if (readiness.reason === "exited") {
      const message = `daemon failed to start (exit code ${readiness.exitCode ?? "unknown"}). Check ${logFile} for details.`;
      exitCommandError({
        args,
        payload: {
          error: "daemon_failed",
          instance_id: instanceId,
          pid: child.pid,
          exit_code: readiness.exitCode,
          project_dir: projectDir,
          workflow_file: workflowPath,
          log_file: logFile,
        },
        message,
        hint: `Try: symphony logs -f --workflow ${workflowPath}`,
      });
    }

    const message =
      `daemon did not become healthy within ${DAEMON_READY_TIMEOUT_MS}ms. ` +
      `Check ${logFile} for details.`;
    exitCommandError({
      args,
      payload: {
        error: "daemon_unhealthy",
        instance_id: instanceId,
        pid: child.pid,
        project_dir: projectDir,
        workflow_file: workflowPath,
        log_file: logFile,
        timeout_ms: DAEMON_READY_TIMEOUT_MS,
        lock_pid: readiness.lockPid,
      },
      message,
      hint: `Try: symphony logs -f --workflow ${workflowPath}`,
    });
  }

  if (args.json) {
    printJson({
      started: true,
      mode: "daemon",
      instance_id: instanceId,
      pid: child.pid,
      project_dir: projectDir,
      workflow_file: workflowPath,
      log_file: logFile,
    });
  } else {
    console.log(`symphony started (PID ${child.pid})`);
    console.log(`  instance: ${instanceId}`);
    console.log(`  project:  ${projectDir}`);
    console.log(`  workflow: ${workflowPath}`);
    console.log(`  log:      ${logFile}`);
  }

  process.exit(0);
}

interface DaemonReadinessResult {
  ready: boolean;
  reason: "ready" | "exited" | "timeout";
  exitCode: number | null;
  lockPid: number | null;
}

async function waitForDaemonReadiness(
  projectDir: string,
  expectedPid: number,
  child: ReturnType<typeof Bun.spawn>,
): Promise<DaemonReadinessResult> {
  const deadline = Date.now() + DAEMON_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return {
        ready: false,
        reason: "exited",
        exitCode: child.exitCode,
        lockPid: null,
      };
    }

    const lock = await readProjectLock(projectDir);
    if (lock?.pid === expectedPid && isPidAlive(expectedPid)) {
      await Bun.sleep(DAEMON_READY_STABILITY_MS);

      if (child.exitCode !== null) {
        return {
          ready: false,
          reason: "exited",
          exitCode: child.exitCode,
          lockPid: lock.pid,
        };
      }

      const stableLock = await readProjectLock(projectDir);
      if (stableLock?.pid === expectedPid && isPidAlive(expectedPid)) {
        return {
          ready: true,
          reason: "ready",
          exitCode: child.exitCode,
          lockPid: stableLock.pid,
        };
      }
    }

    await Bun.sleep(DAEMON_READY_POLL_MS);
  }

  if (child.exitCode !== null) {
    return {
      ready: false,
      reason: "exited",
      exitCode: child.exitCode,
      lockPid: null,
    };
  }

  const lock = await readProjectLock(projectDir);
  return {
    ready: false,
    reason: "timeout",
    exitCode: child.exitCode,
    lockPid: lock?.pid ?? null,
  };
}

function printForegroundBanner(params: {
  pid: number;
  instanceId: string;
  projectDir: string;
  workflowPath: string;
  workspaceRoot: string;
  pollMs: number;
  maxConcurrent: number;
  logFile: string | null;
}): void {
  console.log("symphony starting in foreground");
  console.log(`  pid:           ${params.pid}`);
  console.log(`  instance:      ${params.instanceId}`);
  console.log(`  project:       ${params.projectDir}`);
  console.log(`  workflow:      ${params.workflowPath}`);
  console.log(`  workspace:     ${params.workspaceRoot}`);
  console.log(`  poll interval: ${params.pollMs}ms`);
  console.log(`  max workers:   ${params.maxConcurrent}`);
  console.log(`  log:           ${params.logFile ?? "(stdout)"}`);
  console.log("");
}

async function runStartForeground(args: Args, workflow: ParsedWorkflow): Promise<void> {
  const { config } = workflow;

  if (config.log.file) {
    await setLogFile(config.log.file);
  }

  const workflowPath = resolve(args.workflow);
  const projectDir = resolve(dirname(workflowPath));
  const instanceId = getInstanceId(projectDir);
  const workspaceRoot = resolve(config.workspace.root);

  try {
    await acquireLock(projectDir, workspaceRoot, workflowPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitCommandError({
      args,
      payload: {
        error: "lock_failed",
        instance_id: instanceId,
        project_dir: projectDir,
        workflow_file: workflowPath,
        message,
      },
      message,
      hint: "If an instance is running, stop it with: symphony stop",
    });
  }

  const lockInfo = {
    pid: process.pid,
    project_path: resolve(projectDir),
    workspace_root: workspaceRoot,
    workflow_file: workflowPath,
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

    await releaseLock(projectDir);
    await unregisterInstance(projectDir);

    exitCommandError({
      args,
      payload: {
        error: "workspace_collision",
        instance_id: instanceId,
        project_dir: projectDir,
        workflow_file: workflowPath,
        workspace_root: workspaceRoot,
        conflicts: conflicts.map((conflict) => ({
          project: conflict.project_path,
          pid: conflict.pid,
          workspace: conflict.workspace_root,
        })),
      },
      message:
        "another symphony instance is using the same workspace root; " +
        "change workspace.root in WORKFLOW.md to avoid collisions",
      hint: `Run: symphony instances\nThen: symphony stop --all (or stop specific project)`,
    });
  }

  if (!args.json) {
    printForegroundBanner({
      pid: process.pid,
      instanceId,
      projectDir,
      workflowPath,
      workspaceRoot,
      pollMs: config.polling.interval_ms,
      maxConcurrent: config.agent.max_concurrent,
      logFile: config.log.file,
    });

    log.info("symphony-beads starting", {
      pid: process.pid,
      instance_id: instanceId,
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
