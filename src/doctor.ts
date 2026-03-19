// ---------------------------------------------------------------------------
// Doctor — verify all dependencies, config, and runtime state
// ---------------------------------------------------------------------------

import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseWorkflow, validateConfig } from "./config.ts";
import { exec } from "./exec.ts";
import {
  checkWorkspaceCollisions,
  isPidAlive,
  type LockInfo,
  listInstances,
  readProjectLock,
  releaseLock,
} from "./lock.ts";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  version?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: CheckResult[];
}

export interface DoctorFixAction {
  name: string;
  ok: boolean;
  changed: boolean;
  detail: string;
}

export interface DoctorFixReport {
  ok: boolean;
  changed: number;
  actions: DoctorFixAction[];
}

export async function runDoctor(workflowPath: string): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  // 1. bun
  checks.push(await checkBinary("bun", ["--version"], "bun"));

  // 2. bd (beads)
  checks.push(await checkBinary("bd", ["version"], "bd"));

  // 3. dolt
  checks.push(await checkDolt());

  // 4. pi
  checks.push(await checkBinary("pi", ["--version"], "pi"));

  // 5. gh
  checks.push(await checkGh());

  // 6. git
  checks.push(await checkBinary("git", ["--version"], "git"));

  // 7. WORKFLOW.md
  checks.push(await checkWorkflow(workflowPath));

  // 8. .beads
  checks.push(await checkBeads());

  // 9. workspaces
  checks.push(await checkWorkspaces(workflowPath));

  // 10. lock
  checks.push(await checkLock());

  // 11. workspace overlap risk
  checks.push(await checkWorkspaceOverlapRisk());

  const ok = checks.every((c) => c.ok);
  return { ok, checks };
}

export async function runDoctorFix(workflowPath: string): Promise<DoctorFixReport> {
  const actions: DoctorFixAction[] = [];

  actions.push(await fixStaleProjectLock(workflowPath));
  actions.push(await ensureWorkspaceRootExists(workflowPath));

  const ok = actions.every((action) => action.ok);
  const changed = actions.filter((action) => action.changed).length;

  return { ok, changed, actions };
}

async function fixStaleProjectLock(workflowPath: string): Promise<DoctorFixAction> {
  const projectDir = resolve(dirname(workflowPath));

  try {
    const lock = await readProjectLock(projectDir);
    if (!lock) {
      return {
        name: "stale-project-lock",
        ok: true,
        changed: false,
        detail: "no project lock file",
      };
    }

    if (isPidAlive(lock.pid)) {
      return {
        name: "stale-project-lock",
        ok: true,
        changed: false,
        detail: `project lock is active (PID ${lock.pid})`,
      };
    }

    await releaseLock(projectDir);
    return {
      name: "stale-project-lock",
      ok: true,
      changed: true,
      detail: `removed stale project lock for dead PID ${lock.pid}`,
    };
  } catch (error) {
    return {
      name: "stale-project-lock",
      ok: false,
      changed: false,
      detail: String(error),
    };
  }
}

async function ensureWorkspaceRootExists(workflowPath: string): Promise<DoctorFixAction> {
  try {
    const file = Bun.file(workflowPath);
    if (!(await file.exists())) {
      return {
        name: "workspace-root",
        ok: false,
        changed: false,
        detail: `workflow file not found: ${workflowPath}`,
      };
    }

    const content = await file.text();
    const workflow = parseWorkflow(content);
    const workflowDir = resolve(dirname(workflowPath));
    const workspaceRoot = resolve(workflowDir, workflow.config.workspace.root);

    const existed = await pathExists(workspaceRoot);
    await mkdir(workspaceRoot, { recursive: true });

    return {
      name: "workspace-root",
      ok: true,
      changed: !existed,
      detail: existed ? `already exists: ${workspaceRoot}` : `created: ${workspaceRoot}`,
    };
  } catch (error) {
    return {
      name: "workspace-root",
      ok: false,
      changed: false,
      detail: String(error),
    };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function checkBinary(name: string, args: string[], label: string): Promise<CheckResult> {
  const result = await exec([name, ...args]);
  if (result.code === 0) {
    const version = result.stdout.trim().split("\n")[0] ?? "";
    return { name: label, ok: true, detail: version, version };
  }
  if (result.code === 127) {
    return { name: label, ok: false, detail: "not found in PATH" };
  }
  return {
    name: label,
    ok: false,
    detail: `exit ${result.code}: ${result.stderr.trim().slice(0, 100)}`,
  };
}

async function checkDolt(): Promise<CheckResult> {
  const ver = await exec(["dolt", "version"]);
  if (ver.code !== 0) {
    return { name: "dolt", ok: false, detail: "not found in PATH" };
  }
  const version = ver.stdout.trim().split("\n")[0] ?? "";

  // Check if dolt server is running for the current project
  const status = await exec(["bd", "dolt", "status"]);
  if (status.code === 0 && status.stdout.includes("running")) {
    const portMatch = status.stdout.match(/Port:\s*(\d+)/);
    const port = portMatch?.[1] ?? "?";
    return { name: "dolt", ok: true, detail: `${version} (server running, port ${port})`, version };
  }

  return { name: "dolt", ok: true, detail: `${version} (server not running)`, version };
}

async function checkGh(): Promise<CheckResult> {
  const ver = await exec(["gh", "--version"]);
  if (ver.code !== 0) {
    return { name: "gh", ok: false, detail: "not found in PATH" };
  }
  const version = ver.stdout.trim().split("\n")[0] ?? "";

  // Check auth status
  const auth = await exec(["gh", "auth", "status"]);
  if (auth.code === 0) {
    const userMatch = (auth.stdout + auth.stderr).match(/Logged in to .* as (\S+)/);
    const user = userMatch?.[1] ?? "authenticated";
    return { name: "gh", ok: true, detail: `${version} (${user})`, version };
  }

  return {
    name: "gh",
    ok: false,
    detail: `${version} (not authenticated — run: gh auth login)`,
    version,
  };
}

async function checkWorkflow(path: string): Promise<CheckResult> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { name: "WORKFLOW.md", ok: false, detail: `not found: ${path}` };
    }
    const content = await file.text();
    const workflow = parseWorkflow(content);
    const errors = validateConfig(workflow.config);
    if (errors.length > 0) {
      return { name: "WORKFLOW.md", ok: false, detail: `invalid: ${errors.join(", ")}` };
    }
    return {
      name: "WORKFLOW.md",
      ok: true,
      detail: `valid config, ${workflow.prompt_template.length} char prompt`,
    };
  } catch (err) {
    return { name: "WORKFLOW.md", ok: false, detail: String(err) };
  }
}

async function checkBeads(): Promise<CheckResult> {
  const result = await exec(["bd", "list", "--all", "--json", "--limit", "0"]);
  if (result.code !== 0) {
    if (result.stderr.includes("no beads database")) {
      return { name: ".beads", ok: false, detail: "not initialized (run: bd init)" };
    }
    return { name: ".beads", ok: false, detail: result.stderr.trim().slice(0, 100) };
  }

  try {
    const issues = JSON.parse(result.stdout);
    if (!Array.isArray(issues)) {
      return { name: ".beads", ok: true, detail: "connected" };
    }
    const total = issues.length;
    const open = issues.filter(
      (i: { status: string }) => i.status === "open" || i.status === "in_progress",
    ).length;
    const closed = issues.filter((i: { status: string }) => i.status === "closed").length;
    const other = total - open - closed;
    let detail = `${total} issues (${open} open, ${closed} closed`;
    if (other > 0) detail += `, ${other} other`;
    detail += ")";
    return { name: ".beads", ok: true, detail };
  } catch {
    return { name: ".beads", ok: true, detail: "connected" };
  }
}

async function checkWorkspaces(workflowPath: string): Promise<CheckResult> {
  try {
    const file = Bun.file(workflowPath);
    if (!(await file.exists())) {
      return { name: "workspaces", ok: true, detail: "no workflow file" };
    }
    const content = await file.text();
    const workflow = parseWorkflow(content);
    const root = resolve(dirname(workflowPath), workflow.config.workspace.root);

    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return { name: "workspaces", ok: true, detail: `${root} (empty or not created yet)` };
    }

    // Count active workspaces (have .symphony-init marker)
    let active = 0;
    for (const entry of entries) {
      const marker = Bun.file(resolve(root, entry, ".symphony-init"));
      if (await marker.exists()) active++;
    }

    return { name: "workspaces", ok: true, detail: `${root} (${active} active)` };
  } catch (err) {
    return { name: "workspaces", ok: false, detail: String(err) };
  }
}

async function checkLock(): Promise<CheckResult> {
  const instances = await listInstances();
  if (instances.length === 0) {
    return { name: "lock", ok: true, detail: "no running instances" };
  }
  const pids = instances.map((i) => `PID ${i.pid} (${i.project_path})`).join(", ");
  return { name: "lock", ok: true, detail: `${instances.length} running: ${pids}` };
}

interface WorkspaceOverlapPair {
  left: LockInfo;
  right: LockInfo;
}

export async function checkWorkspaceOverlapRisk(): Promise<CheckResult> {
  const instances = await listInstances();

  if (instances.length < 2) {
    return {
      name: "workspace-overlap",
      ok: true,
      detail: "no overlap risk (<2 running instances)",
    };
  }

  const overlaps = await findWorkspaceOverlapPairs(instances);

  if (overlaps.length === 0) {
    return {
      name: "workspace-overlap",
      ok: true,
      detail: `${instances.length} running instances, no overlapping workspace roots`,
    };
  }

  const samples = overlaps
    .slice(0, 2)
    .map((pair) => `${pair.left.workspace_root} ↔ ${pair.right.workspace_root}`)
    .join("; ");
  const more = overlaps.length > 2 ? ` (+${overlaps.length - 2} more)` : "";

  return {
    name: "workspace-overlap",
    ok: false,
    detail: `${overlaps.length} overlapping workspace root pair(s): ${samples}${more}`,
  };
}

async function findWorkspaceOverlapPairs(instances: LockInfo[]): Promise<WorkspaceOverlapPair[]> {
  const pairs = new Map<string, WorkspaceOverlapPair>();

  for (const instance of instances) {
    const conflicts = await checkWorkspaceCollisions(
      instance.project_path,
      instance.workspace_root,
    );

    for (const conflict of conflicts) {
      const key = pairKey(instance.project_path, conflict.project_path);
      if (pairs.has(key)) continue;

      const [left, right] = orderedPair(instance, conflict);
      pairs.set(key, { left, right });
    }
  }

  return Array.from(pairs.values());
}

function pairKey(pathA: string, pathB: string): string {
  return pathA < pathB ? `${pathA}::${pathB}` : `${pathB}::${pathA}`;
}

function orderedPair(instanceA: LockInfo, instanceB: LockInfo): [LockInfo, LockInfo] {
  return instanceA.project_path < instanceB.project_path
    ? [instanceA, instanceB]
    : [instanceB, instanceA];
}
