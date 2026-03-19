import { dirname, resolve } from "node:path";
import {
  isPidAlive,
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

interface StopAllResult extends StopResult {
  project: string;
}

export async function runStopCommand(args: Args): Promise<void> {
  if (args.all) {
    await stopAllInstances(args);
    return;
  }

  const projectDir = resolve(dirname(args.workflow));
  const lockInfo = await readProjectLock(projectDir);

  if (!lockInfo) {
    exitCommandError({
      args,
      payload: {
        error: "not_running",
        message: "No symphony instance running for this project",
      },
      message: "no symphony instance running for this project",
      level: "info",
    });
  }

  const result = await stopProcess(lockInfo);

  await releaseLock(projectDir);
  await unregisterInstance(projectDir);

  if (args.json) {
    printJson(result);
    return;
  }

  if (result.killed) {
    log.info("stopped symphony instance", { pid: result.pid, signal: result.signal });
  } else if (result.already_dead) {
    log.info("instance was already stopped (stale lock cleaned up)", { pid: result.pid });
  }
}

async function stopAllInstances(args: Args): Promise<void> {
  const instances = await listInstances();

  if (instances.length === 0) {
    if (args.json) {
      printJson({ stopped: [], message: "No running instances" });
    } else {
      console.log("No running symphony instances.");
    }
    return;
  }

  const results: StopAllResult[] = [];

  for (const instance of instances) {
    const result = await stopProcess(instance);
    results.push({ ...result, project: instance.project_path });

    await releaseLock(instance.project_path);
    await unregisterInstance(instance.project_path);
  }

  if (args.json) {
    printJson({ stopped: results });
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
      log.info("cleaned up stale instance", {
        pid: result.pid,
        project: result.project,
      });
    }
  }

  const stoppedCount = results.filter((result) => result.killed).length;
  const staleCount = results.filter((result) => result.already_dead).length;

  console.log(`\nStopped ${stoppedCount} instance(s), cleaned ${staleCount} stale lock(s).`);
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
