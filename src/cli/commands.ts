import { dirname, resolve } from "node:path";
import { type parseWorkflow, validateConfig } from "../config.ts";
import { runDoctor } from "../doctor.ts";
import { exec } from "../exec.ts";
import {
  acquireLock,
  checkWorkspaceCollisions,
  isPidAlive,
  listInstances,
  readProjectLock,
  registerInstance,
  releaseLock,
  unregisterInstance,
} from "../lock.ts";
import { log } from "../log.ts";
import { Orchestrator } from "../orchestrator.ts";
import { PrMonitor } from "../pr-monitor.ts";
import { BeadsTracker } from "../tracker.ts";
import { WorkflowWatcher } from "../watcher.ts";
import { WorkspaceManager } from "../workspace.ts";
import type { Args } from "./types.ts";
import { loadWorkflow } from "./workflow.ts";

export async function cmdStart(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow);
  const config = workflow.config;

  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const error of errors) {
      log.error(error);
    }
    process.exit(1);
  }

  if (!args.foreground) {
    await daemonize(args, config);
    return;
  }

  await cmdStartForeground(args, workflow);
}

async function daemonize(
  args: Args,
  config: ReturnType<typeof parseWorkflow>["config"],
): Promise<void> {
  const projectDir = resolve(dirname(args.workflow));

  const existingLock = await readProjectLock(projectDir);
  if (existingLock && isPidAlive(existingLock.pid)) {
    const message = `symphony is already running (PID ${existingLock.pid}). Use symphony stop first.`;
    if (args.json) {
      console.log(JSON.stringify({ error: "already_running", pid: existingLock.pid, message }));
    } else {
      log.error(message);
    }
    process.exit(1);
  }

  const logFile = config.log.file
    ? resolve(dirname(args.workflow), config.log.file)
    : resolve(dirname(args.workflow), "symphony.log");

  const { mkdir: mkdirFs } = await import("node:fs/promises");
  const { closeSync, openSync } = await import("node:fs");
  await mkdirFs(dirname(logFile), { recursive: true });

  const logFd = openSync(logFile, "a");

  const childArgs: string[] = ["start", "--foreground"];
  if (args.json) childArgs.push("--json");
  if (args.workflow !== "WORKFLOW.md") childArgs.push("--workflow", args.workflow);
  if (args.verbose) childArgs.push("--verbose");

  const entryPoint = resolve(import.meta.dir, "../cli.ts");
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
    // ignore
  }

  if (child.exitCode !== null) {
    const message = `daemon failed to start (exit code ${child.exitCode}). Check ${logFile} for details.`;
    if (args.json) {
      console.log(
        JSON.stringify({ error: "daemon_failed", exit_code: child.exitCode, log_file: logFile }),
      );
    } else {
      log.error(message);
    }
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify({ started: true, pid: child.pid, log_file: logFile }));
  } else {
    console.log(`symphony started (PID ${child.pid})`);
  }

  process.exit(0);
}

async function cmdStartForeground(
  args: Args,
  workflow: ReturnType<typeof parseWorkflow>,
): Promise<void> {
  const config = workflow.config;

  if (config.log.file) {
    const { setLogFile } = await import("../log.ts");
    await setLogFile(config.log.file);
  }

  const projectDir = resolve(dirname(args.workflow));
  const workspaceRoot = resolve(config.workspace.root);

  try {
    await acquireLock(projectDir, workspaceRoot, args.workflow);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.json) {
      console.log(JSON.stringify({ error: "lock_failed", message }));
    } else {
      log.error(message);
    }
    process.exit(1);
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
      console.log(
        JSON.stringify({
          error: "workspace_collision",
          conflicts: conflicts.map((conflict) => ({
            project: conflict.project_path,
            pid: conflict.pid,
            workspace: conflict.workspace_root,
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

  const workflowAbsPath = resolve(args.workflow);
  const watcher = new WorkflowWatcher(workflowAbsPath, orchestrator);
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

export async function cmdStatus(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow);
  const tracker = new BeadsTracker(workflow.config);
  const candidates = await tracker.fetchCandidates();
  const terminalIds = await tracker.fetchTerminalIds();

  const output = {
    candidates: candidates.length,
    terminal: terminalIds.length,
    issues: candidates.map((issue) => ({
      id: issue.id,
      title: issue.title,
      state: issue.state,
      priority: issue.priority,
    })),
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  for (const issue of output.issues) {
    console.log(`  ${issue.id}  P${issue.priority ?? "-"}  [${issue.state}]  ${issue.title}`);
  }

  if (output.issues.length === 0) {
    console.log("  (no active issues)");
  }
}

export async function cmdValidate(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow);
  const errors = validateConfig(workflow.config);

  const projectDir = resolve(dirname(args.workflow));
  const workspaceRoot = resolve(workflow.config.workspace.root);
  const conflicts = await checkWorkspaceCollisions(projectDir, workspaceRoot);
  const warnings: string[] = [];

  for (const conflict of conflicts) {
    warnings.push(
      `workspace root collision: "${workspaceRoot}" is also used by project "${conflict.project_path}" (PID ${conflict.pid})`,
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
    return;
  }

  if (errors.length === 0) {
    log.info("workflow is valid", { file: args.workflow });
    console.log(`  tracker:        ${workflow.config.tracker.kind}`);
    console.log(`  project:        ${workflow.config.tracker.project_path}`);
    console.log(`  runner:         ${workflow.config.runner.command}`);
    console.log(`  max_concurrent: ${workflow.config.agent.max_concurrent}`);
    console.log(`  poll_ms:        ${workflow.config.polling.interval_ms}`);
    console.log(`  prompt:         ${workflow.prompt_template.length} chars`);
    for (const warning of warnings) {
      log.warn(warning);
    }
    return;
  }

  log.error("workflow has errors", { file: args.workflow });
  for (const error of errors) {
    console.log(`  - ${error}`);
  }
  for (const warning of warnings) {
    log.warn(warning);
  }
  process.exit(1);
}

export async function cmdInit(args: Args): Promise<void> {
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

  const configResult = await exec(["bd", "config", "set", "status.custom", "review"], {
    cwd: process.cwd(),
  });
  const reviewConfigured = configResult.code === 0;

  if (args.json) {
    console.log(JSON.stringify({ created: path, review_status_configured: reviewConfigured }));
    return;
  }

  log.info("created workflow file", { path });
  if (reviewConfigured) {
    log.info("configured beads custom status: review");
  } else {
    log.warn(
      "could not configure 'review' custom status — run: bd config set status.custom \"review\"",
    );
  }
}

export async function cmdInstances(args: Args): Promise<void> {
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
  for (const instance of instances) {
    console.log(`  PID:        ${instance.pid}`);
    console.log(`  Project:    ${instance.project_path}`);
    console.log(`  Workspace:  ${instance.workspace_root}`);
    console.log(`  Workflow:   ${instance.workflow_file}`);
    console.log(`  Started:    ${instance.started_at}`);
    console.log("");
  }
}

export async function cmdStop(args: Args): Promise<void> {
  if (args.all) {
    await cmdStopAll(args);
    return;
  }

  const projectDir = resolve(dirname(args.workflow));
  const lockInfo = await readProjectLock(projectDir);

  if (!lockInfo) {
    if (args.json) {
      console.log(
        JSON.stringify({
          error: "not_running",
          message: "No symphony instance running for this project",
        }),
      );
    } else {
      log.info("no symphony instance running for this project");
    }
    process.exit(1);
  }

  const result = await stopProcess(lockInfo);

  await releaseLock(projectDir);
  await unregisterInstance(projectDir);

  if (args.json) {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.killed) {
    log.info("stopped symphony instance", { pid: result.pid, signal: result.signal });
  } else if (result.already_dead) {
    log.info("instance was already stopped (stale lock cleaned up)", { pid: result.pid });
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

  const results: Array<{
    pid: number;
    project: string;
    killed: boolean;
    already_dead: boolean;
    signal: string;
  }> = [];

  for (const instance of instances) {
    const result = await stopProcess(instance);
    results.push({ ...result, project: instance.project_path });

    await releaseLock(instance.project_path);
    await unregisterInstance(instance.project_path);
  }

  if (args.json) {
    console.log(JSON.stringify({ stopped: results }));
    return;
  }

  for (const result of results) {
    if (result.killed) {
      log.info("stopped instance", {
        pid: result.pid,
        project: result.project,
        signal: result.signal,
      });
    } else if (result.already_dead) {
      log.info("cleaned up stale instance", { pid: result.pid, project: result.project });
    }
  }

  console.log(
    `\nStopped ${results.filter((result) => result.killed).length} instance(s), cleaned ${results.filter((result) => result.already_dead).length} stale lock(s).`,
  );
}

async function stopProcess(info: {
  pid: number;
}): Promise<{ pid: number; killed: boolean; already_dead: boolean; signal: string }> {
  const { pid } = info;

  if (!isPidAlive(pid)) {
    return { pid, killed: false, already_dead: true, signal: "none" };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { pid, killed: false, already_dead: true, signal: "none" };
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await Bun.sleep(250);
    if (!isPidAlive(pid)) {
      return { pid, killed: true, already_dead: false, signal: "SIGTERM" };
    }
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return { pid, killed: true, already_dead: false, signal: "SIGTERM" };
  }

  await Bun.sleep(500);
  return { pid, killed: true, already_dead: false, signal: "SIGKILL" };
}

export async function cmdDoctor(args: Args): Promise<void> {
  const report = await runDoctor(args.workflow);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("");
    const maxName = Math.max(...report.checks.map((check) => check.name.length));
    for (const check of report.checks) {
      const status = check.ok ? "ok  " : "FAIL";
      const pad = check.name.padEnd(maxName);
      console.log(`  ${pad}  ${status}  ${check.detail}`);
    }
    console.log("");
    if (report.ok) {
      console.log("  All checks passed.");
    } else {
      const failed = report.checks.filter((check) => !check.ok).length;
      console.log(`  ${failed} check(s) failed.`);
    }
    console.log("");
  }

  if (!report.ok) {
    process.exit(1);
  }
}

export async function cmdLogs(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow);
  const logFile = workflow.config.log.file;

  if (!logFile) {
    if (args.json) {
      console.log(
        JSON.stringify({
          error: "no_log_file",
          message: "no log file configured in WORKFLOW.md (log.file)",
        }),
      );
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

  const content = await file.text();
  const allLines = content.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
    allLines.pop();
  }

  const startIndex = Math.max(0, allLines.length - args.lines);
  const tailLines = allLines.slice(startIndex);

  for (const line of tailLines) {
    if (line.trim()) {
      console.log(line);
    }
  }

  if (args.follow) {
    let offset = content.length;
    const { watch } = await import("node:fs");

    const watcher = watch(resolvedPath, async () => {
      try {
        const watchedFile = Bun.file(resolvedPath);
        const size = watchedFile.size;
        if (size <= offset) {
          if (size < offset) offset = 0;
          return;
        }

        const newContent = await watchedFile.slice(offset, size).text();
        offset = size;
        const newLines = newContent.split("\n");
        for (const line of newLines) {
          if (line.trim()) {
            console.log(line);
          }
        }
      } catch {
        // ignore
      }
    });

    const pollInterval = setInterval(async () => {
      try {
        const watchedFile = Bun.file(resolvedPath);
        const size = watchedFile.size;
        if (size <= offset) {
          if (size < offset) offset = 0;
          return;
        }

        const newContent = await watchedFile.slice(offset, size).text();
        offset = size;
        const newLines = newContent.split("\n");
        for (const line of newLines) {
          if (line.trim()) {
            console.log(line);
          }
        }
      } catch {
        // ignore
      }
    }, 1000);

    const cleanup = () => {
      watcher.close();
      clearInterval(pollInterval);
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    await new Promise(() => {});
  }
}

export async function cmdTui(): Promise<void> {
  const { launchKanban } = await import("../tui/app.tsx");
  await launchKanban();
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
