import { dirname, resolve } from "node:path";
import { getInstanceId, isPidAlive, readProjectLock } from "../../lock.ts";
import { BeadsTracker } from "../../tracker.ts";
import type { Issue } from "../../types.ts";
import { printJson } from "../output.ts";
import type { Args } from "../types.ts";
import { loadWorkflow } from "../workflow.ts";

interface StatusIssueSummary {
  id: string;
  title: string;
  state: string;
  priority: number | null;
}

interface ServiceStatusSummary {
  instance_id: string;
  running: boolean;
  pid: number | null;
  started_at: string | null;
  uptime_seconds: number | null;
  stale_lock: boolean;
}

interface StatusOutput {
  generated_at: string;
  workflow_file: string;
  project_dir: string;
  service: ServiceStatusSummary;
  candidates: number;
  terminal: number;
  by_state: Record<string, number>;
  issues: StatusIssueSummary[];
}

export async function runStatusCommand(args: Args): Promise<void> {
  const workflowPath = resolve(args.workflow);
  const projectDir = resolve(dirname(workflowPath));

  const workflow = await loadWorkflow(workflowPath, args.json);
  const tracker = new BeadsTracker(workflow.config);

  const candidates = await tracker.fetchCandidates();
  const terminalIds = await tracker.fetchTerminalIds();

  const lock = await readProjectLock(projectDir);
  const running = Boolean(lock && isPidAlive(lock.pid));
  const startedAt = lock?.started_at ?? null;

  const service: ServiceStatusSummary = {
    instance_id: getInstanceId(projectDir),
    running,
    pid: lock?.pid ?? null,
    started_at: startedAt,
    uptime_seconds: running ? calculateUptimeSeconds(startedAt) : null,
    stale_lock: Boolean(lock && !running),
  };

  const issues = sortIssuesForStatus(candidates).map((issue) => ({
    id: issue.id,
    title: issue.title,
    state: issue.state,
    priority: issue.priority,
  }));

  const output: StatusOutput = {
    generated_at: new Date().toISOString(),
    workflow_file: workflowPath,
    project_dir: projectDir,
    service,
    candidates: issues.length,
    terminal: terminalIds.length,
    by_state: buildStateCounts(issues),
    issues,
  };

  if (args.json) {
    printJson(output, true);
    return;
  }

  printStatusText(output);
}

function printStatusText(output: StatusOutput): void {
  console.log(`workflow: ${output.workflow_file}`);
  console.log(`project:  ${output.project_dir}`);

  console.log("service:");
  for (const line of formatServiceStatusLines(output.service)) {
    console.log(`  ${line}`);
  }

  console.log("issues:");
  console.log(`  active:   ${output.candidates}`);
  console.log(`  terminal: ${output.terminal}`);

  const stateEntries = Object.entries(output.by_state).sort(([a], [b]) => a.localeCompare(b));
  console.log("states:");
  if (stateEntries.length === 0) {
    console.log("  (none)");
  } else {
    for (const [state, count] of stateEntries) {
      console.log(`  ${state}: ${count}`);
    }
  }

  console.log("");

  if (output.issues.length === 0) {
    console.log("Active issues: (none)");
    return;
  }

  console.log(`Active issues (${output.issues.length}):`);
  console.log("");

  for (const [index, issue] of output.issues.entries()) {
    console.log(`Issue ${index + 1}:`);
    console.log(`  ID:       ${issue.id}`);
    console.log(`  Priority: P${issue.priority ?? "-"}`);
    console.log(`  State:    ${issue.state}`);
    console.log(`  Title:    ${issue.title}`);

    if (index < output.issues.length - 1) {
      console.log("");
    }
  }
}

function formatServiceStatusLines(service: ServiceStatusSummary): string[] {
  if (service.running && service.pid !== null) {
    const uptimeLabel =
      service.uptime_seconds !== null ? formatUptime(service.uptime_seconds) : "unknown";
    const startedAt = service.started_at ?? "unknown";

    return [
      "status: running",
      `id: ${service.instance_id}`,
      `pid: ${service.pid}`,
      `uptime: ${uptimeLabel}`,
      `started: ${startedAt}`,
    ];
  }

  if (service.stale_lock && service.pid !== null) {
    return [
      "status: stale lock",
      `id: ${service.instance_id}`,
      `pid: ${service.pid}`,
      `started: ${service.started_at ?? "unknown"}`,
    ];
  }

  return ["status: not running", `id: ${service.instance_id}`];
}

function calculateUptimeSeconds(startedAt: string | null): number | null {
  if (!startedAt) return null;

  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return null;

  const diffMs = Date.now() - startedMs;
  return Math.max(0, Math.floor(diffMs / 1000));
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

function sortIssuesForStatus(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const pa = a.priority ?? Number.POSITIVE_INFINITY;
    const pb = b.priority ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;

    if (a.state !== b.state) return a.state.localeCompare(b.state);

    return a.id.localeCompare(b.id);
  });
}

function buildStateCounts(issues: StatusIssueSummary[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const issue of issues) {
    counts[issue.state] = (counts[issue.state] ?? 0) + 1;
  }

  return counts;
}
