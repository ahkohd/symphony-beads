import { dirname, resolve } from "node:path";
import {
  getInstanceId,
  isPidAlive,
  type LockInfo,
  listInstances,
  readProjectLock,
  releaseLock,
  unregisterInstance,
} from "../../lock.ts";
import { log } from "../../log.ts";
import { exitCommandError, printJson } from "../output.ts";
import type { Args } from "../types.ts";

interface StopResult {
  pid: number;
  killed: boolean;
  already_dead: boolean;
  signal: string;
}

interface ServiceStatusSummary {
  running: boolean;
  pid: number | null;
  started_at: string | null;
  stale_lock: boolean;
}

interface StopOutput extends StopResult {
  instance_id: string;
  project_dir: string;
  workflow_file: string;
  service_before: ServiceStatusSummary;
  service_after: ServiceStatusSummary;
}

interface StopAllResult extends StopResult {
  instance_id: string;
  project: string;
  workflow_file: string;
  service_before: ServiceStatusSummary;
  service_after: ServiceStatusSummary;
}

export async function runStopCommand(args: Args): Promise<void> {
  if (args.all && args.instanceId) {
    exitCommandError({
      args,
      payload: {
        error: "stop_flag_conflict",
        message: "--all cannot be combined with --id",
      },
      message: "--all cannot be combined with --id",
      hint: "Use either: symphony stop --all OR symphony stop --id <instance-id>",
    });
  }

  if (args.all) {
    await stopAllInstances(args);
    return;
  }

  if (args.instanceId) {
    await stopInstanceById(args, args.instanceId);
    return;
  }

  const workflowPath = resolve(args.workflow);
  const projectDir = resolve(dirname(workflowPath));
  const lockInfo = await readProjectLock(projectDir);

  if (!lockInfo) {
    exitCommandError({
      args,
      payload: {
        error: "not_running",
        project_dir: projectDir,
        workflow_file: workflowPath,
        service: buildServiceStatus(null),
        message: "No symphony instance running for this project",
      },
      message: "no symphony instance running for this project",
      level: "info",
    });
  }

  const serviceBefore = buildServiceStatus(lockInfo);
  const result = await stopProcess(lockInfo);

  await releaseLock(projectDir);
  await unregisterInstance(projectDir);

  const serviceAfter = await readServiceStatus(projectDir);
  const output: StopOutput = {
    ...result,
    instance_id: getInstanceId(projectDir),
    project_dir: projectDir,
    workflow_file: workflowPath,
    service_before: serviceBefore,
    service_after: serviceAfter,
  };

  if (args.json) {
    printJson(output);
    return;
  }

  if (result.killed) {
    log.info("stopped symphony instance", {
      instance_id: output.instance_id,
      pid: result.pid,
      signal: result.signal,
      project: projectDir,
      workflow: workflowPath,
    });
  } else if (result.already_dead) {
    log.info("instance was already stopped (stale lock cleaned up)", {
      instance_id: output.instance_id,
      pid: result.pid,
      project: projectDir,
      workflow: workflowPath,
    });
  }
}

async function stopInstanceById(args: Args, instanceId: string): Promise<void> {
  const instances = await listInstances();
  const resolved = resolveInstanceTarget(instances, instanceId);

  if (resolved.kind === "not_found") {
    exitCommandError({
      args,
      payload: {
        error: "instance_not_found",
        instance_id: instanceId,
        running_instances: instances.length,
        message: `No running symphony instance found for id ${instanceId}`,
      },
      message: `no running symphony instance found for id ${instanceId}`,
      hint: "Run: symphony instances",
      level: "info",
    });
  }

  if (resolved.kind === "ambiguous") {
    exitCommandError({
      args,
      payload: {
        error: "instance_id_ambiguous",
        instance_id: instanceId,
        matches: resolved.matches,
        message: `Instance id prefix '${instanceId}' matches multiple running instances`,
      },
      message: `instance id prefix '${instanceId}' matches multiple running instances`,
      hint: formatAmbiguousMatchesHint(resolved.matches),
      level: "info",
    });
  }

  const target = resolved.instance;
  const fullInstanceId = getInstanceId(target.project_path);

  const serviceBefore = buildServiceStatus(target);
  const result = await stopProcess(target);

  await releaseLock(target.project_path);
  await unregisterInstance(target.project_path);

  const serviceAfter = await readServiceStatus(target.project_path);
  const output: StopOutput = {
    ...result,
    instance_id: fullInstanceId,
    project_dir: target.project_path,
    workflow_file: target.workflow_file,
    service_before: serviceBefore,
    service_after: serviceAfter,
  };

  if (args.json) {
    printJson(output);
    return;
  }

  if (result.killed) {
    log.info("stopped symphony instance", {
      instance_id: output.instance_id,
      pid: result.pid,
      signal: result.signal,
      project: target.project_path,
      workflow: target.workflow_file,
    });
  } else if (result.already_dead) {
    log.info("instance was already stopped (stale lock cleaned up)", {
      instance_id: output.instance_id,
      pid: result.pid,
      project: target.project_path,
      workflow: target.workflow_file,
    });
  }
}

interface InstanceMatchSummary {
  instance_id: string;
  pid: number;
  project: string;
  workflow_file: string;
}

type InstanceTargetResolution =
  | {
      kind: "found";
      instance: LockInfo;
    }
  | {
      kind: "not_found";
    }
  | {
      kind: "ambiguous";
      matches: InstanceMatchSummary[];
    };

function resolveInstanceTarget(
  instances: LockInfo[],
  requestedId: string,
): InstanceTargetResolution {
  const needle = requestedId.trim();
  if (!needle) {
    return { kind: "not_found" };
  }

  const candidates = instances.map((instance) => ({
    instance,
    instance_id: getInstanceId(instance.project_path),
  }));

  const exact = candidates.find((candidate) => candidate.instance_id === needle);
  if (exact) {
    return { kind: "found", instance: exact.instance };
  }

  const prefixMatches = candidates.filter((candidate) => candidate.instance_id.startsWith(needle));

  if (prefixMatches.length === 0) {
    return { kind: "not_found" };
  }

  if (prefixMatches.length > 1) {
    return {
      kind: "ambiguous",
      matches: prefixMatches
        .map((match) => ({
          instance_id: match.instance_id,
          pid: match.instance.pid,
          project: match.instance.project_path,
          workflow_file: match.instance.workflow_file,
        }))
        .sort((a, b) => a.instance_id.localeCompare(b.instance_id)),
    };
  }

  return { kind: "found", instance: prefixMatches[0]!.instance };
}

function formatAmbiguousMatchesHint(matches: InstanceMatchSummary[]): string {
  const preview = matches.slice(0, 3);
  const lines = ["Matching instances (showing up to 3):"];

  for (const match of preview) {
    lines.push(`  ${match.instance_id}  PID ${match.pid}  ${match.project}`);
  }

  if (matches.length > preview.length) {
    lines.push(`  ...and ${matches.length - preview.length} more`);
  }

  lines.push("Use a longer --id prefix (or exact ID) from: symphony instances");
  return lines.join("\n");
}

async function stopAllInstances(args: Args): Promise<void> {
  const instances = await listInstances();

  if (instances.length === 0) {
    if (args.json) {
      printJson({
        stopped: [],
        total: 0,
        stopped_count: 0,
        stale_count: 0,
        message: "No running instances",
      });
    } else {
      console.log("No running symphony instances.");
    }
    return;
  }

  const results: StopAllResult[] = [];

  for (const instance of instances) {
    const serviceBefore = buildServiceStatus(instance);
    const result = await stopProcess(instance);

    await releaseLock(instance.project_path);
    await unregisterInstance(instance.project_path);

    const serviceAfter = await readServiceStatus(instance.project_path);

    results.push({
      ...result,
      instance_id: getInstanceId(instance.project_path),
      project: instance.project_path,
      workflow_file: instance.workflow_file,
      service_before: serviceBefore,
      service_after: serviceAfter,
    });
  }

  const stoppedCount = results.filter((result) => result.killed).length;
  const staleCount = results.filter((result) => result.already_dead).length;

  if (args.json) {
    printJson({
      stopped: results,
      total: results.length,
      stopped_count: stoppedCount,
      stale_count: staleCount,
    });
    return;
  }

  console.log(`Stopping ${results.length} symphony instance(s):\n`);

  for (const [index, result] of results.entries()) {
    const summary = result.killed
      ? `stopped (${result.signal})`
      : "already stopped (stale lock cleaned)";

    console.log(`Instance ${index + 1}:`);
    console.log(`  ID:       ${result.instance_id}`);
    console.log(`  PID:      ${result.pid}`);
    console.log(`  Project:  ${result.project}`);
    console.log(`  Workflow: ${result.workflow_file}`);
    console.log(`  Result:   ${summary}`);

    if (index < results.length - 1) {
      console.log("");
    }
  }

  console.log("");
  console.log("Summary:");
  console.log(`  Total:   ${results.length}`);
  console.log(`  Stopped: ${stoppedCount}`);
  console.log(`  Stale:   ${staleCount}`);
}

function buildServiceStatus(
  lockInfo: Pick<LockInfo, "pid" | "started_at"> | null,
): ServiceStatusSummary {
  if (!lockInfo) {
    return {
      running: false,
      pid: null,
      started_at: null,
      stale_lock: false,
    };
  }

  const running = isPidAlive(lockInfo.pid);

  return {
    running,
    pid: lockInfo.pid,
    started_at: lockInfo.started_at,
    stale_lock: !running,
  };
}

async function readServiceStatus(projectPath: string): Promise<ServiceStatusSummary> {
  const lockInfo = await readProjectLock(projectPath);
  return buildServiceStatus(lockInfo);
}

async function stopProcess(info: { pid: number }): Promise<StopResult> {
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
