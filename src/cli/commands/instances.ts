import { getInstanceId, type LockInfo, listInstances } from "../../lock.ts";
import { printJson } from "../output.ts";
import type { Args } from "../types.ts";

interface InstanceSummary extends LockInfo {
  id: string;
  uptime_seconds: number;
  uptime_human: string;
}

interface InstancesOutput {
  generated_at: string;
  total: number;
  instances: InstanceSummary[];
}

export async function runInstancesCommand(args: Args): Promise<void> {
  const instances = (await listInstances())
    .map(toInstanceSummary)
    .sort((a, b) => b.started_at.localeCompare(a.started_at));

  const output: InstancesOutput = {
    generated_at: new Date().toISOString(),
    total: instances.length,
    instances,
  };

  if (args.json) {
    printJson(output, true);
    return;
  }

  if (output.total === 0) {
    console.log("No running symphony instances.");
    return;
  }

  console.log(`Running symphony instances (${output.total}):\n`);

  for (const [index, instance] of output.instances.entries()) {
    console.log(`Instance ${index + 1}:`);
    console.log(`  ID:        ${instance.id}`);
    console.log(`  PID:       ${instance.pid}`);
    console.log(`  Uptime:    ${instance.uptime_human}`);
    console.log(`  Started:   ${instance.started_at}`);
    console.log(`  Project:   ${instance.project_path}`);
    console.log(`  Workspace: ${instance.workspace_root}`);
    console.log(`  Workflow:  ${instance.workflow_file}`);

    if (index < output.instances.length - 1) {
      console.log("");
    }
  }
}

function toInstanceSummary(instance: LockInfo): InstanceSummary {
  const uptimeSeconds = calculateUptimeSeconds(instance.started_at);

  return {
    ...instance,
    id: getInstanceId(instance.project_path),
    uptime_seconds: uptimeSeconds,
    uptime_human: formatUptime(uptimeSeconds),
  };
}

function calculateUptimeSeconds(startedAt: string): number {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) {
    return 0;
  }

  return Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}
