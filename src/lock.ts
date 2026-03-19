// ---------------------------------------------------------------------------
// Lock file & instance registry — prevents duplicate instances and detects
// workspace root collisions across projects.
//
// Per-project: .symphony.lock in the project directory (next to WORKFLOW.md)
// Global:      ~/.symphony/instances/<hash>.json for cross-project checks
// ---------------------------------------------------------------------------

import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { log } from "./log.ts";

/** Stored in .symphony.lock and in the global instance registry. */
export interface LockInfo {
  pid: number;
  project_path: string;
  workspace_root: string;
  workflow_file: string;
  started_at: string;
}

const LOCK_FILENAME = ".symphony.lock";

// -- Public API --------------------------------------------------------------

/**
 * Acquire a project-level lock file. Throws if another instance is already
 * running for this project.
 */
export async function acquireLock(
  projectDir: string,
  workspaceRoot: string,
  workflowFile: string,
): Promise<string> {
  const absProject = resolve(projectDir);
  const lockPath = resolve(absProject, LOCK_FILENAME);

  // Check for stale or active lock
  const existing = await readLock(lockPath);
  if (existing) {
    if (isPidAlive(existing.pid)) {
      throw new Error(
        `symphony is already running (PID ${existing.pid}). Use symphony stop first.`,
      );
    }
    // Stale lock — remove it
    log.info("removing stale lock file", { pid: existing.pid, lock: lockPath });
    await rm(lockPath, { force: true });
  }

  const info: LockInfo = {
    pid: process.pid,
    project_path: absProject,
    workspace_root: resolve(workspaceRoot),
    workflow_file: workflowFile,
    started_at: new Date().toISOString(),
  };

  await Bun.write(lockPath, `${JSON.stringify(info, null, 2)}\n`);
  return lockPath;
}

/** Release the project lock file. Safe to call even if lock doesn't exist. */
export async function releaseLock(projectDir: string): Promise<void> {
  const lockPath = resolve(projectDir, LOCK_FILENAME);
  await rm(lockPath, { force: true }).catch(() => {});
}

// -- Global instance registry ------------------------------------------------

const REGISTRY_DIR_NAME = ".symphony/instances";

function registryDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return resolve(home, REGISTRY_DIR_NAME);
}

export function getInstanceId(projectPath: string): string {
  // Simple hash of the absolute project path
  return `${Bun.hash(resolve(projectPath))}`;
}

function registryKey(projectPath: string): string {
  return `${getInstanceId(projectPath)}.json`;
}

/**
 * Register this instance in the global registry so other instances can
 * detect workspace root collisions.
 */
export async function registerInstance(info: LockInfo): Promise<void> {
  const dir = registryDir();
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, registryKey(info.project_path));
  await Bun.write(file, `${JSON.stringify(info, null, 2)}\n`);
}

/** Remove this instance from the global registry. */
export async function unregisterInstance(projectPath: string): Promise<void> {
  const dir = registryDir();
  const file = resolve(dir, registryKey(resolve(projectPath)));
  await rm(file, { force: true }).catch(() => {});
}

/**
 * Check all registered instances for workspace root collisions.
 * Returns an array of conflicts (other projects with overlapping workspace roots).
 */
export async function checkWorkspaceCollisions(
  myProjectPath: string,
  myWorkspaceRoot: string,
): Promise<LockInfo[]> {
  const dir = registryDir();
  const absProject = resolve(myProjectPath);
  const normalizedWorkspace = await normalizeWorkspacePath(myWorkspaceRoot);
  const conflicts: LockInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // Registry dir doesn't exist yet — no conflicts
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = resolve(dir, entry);
    const info = await readLockFile(file);
    if (!info) continue;

    // Skip ourselves
    if (info.project_path === absProject) continue;

    // Skip dead instances (clean up their registry entries)
    if (!isPidAlive(info.pid)) {
      await rm(file, { force: true }).catch(() => {});
      continue;
    }

    // Check for exact match or nested overlap
    const otherWorkspace = await normalizeWorkspacePath(info.workspace_root);
    if (pathsOverlap(otherWorkspace, normalizedWorkspace)) {
      conflicts.push(info);
    }
  }

  return conflicts;
}

/**
 * List all registered instances, pruning dead ones along the way.
 * Returns live instances sorted by started_at.
 */
export async function listInstances(): Promise<LockInfo[]> {
  const dir = registryDir();
  const live: LockInfo[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const file = resolve(dir, entry);
    const info = await readLockFile(file);
    if (!info) continue;

    if (!isPidAlive(info.pid)) {
      // Prune dead entries
      await rm(file, { force: true }).catch(() => {});
      continue;
    }

    live.push(info);
  }

  return live.sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
}

export interface PruneStaleRegistryOptions {
  dryRun?: boolean;
}

export interface PruneStaleRegistryResult {
  scanned: number;
  removed: number;
}

/**
 * Remove stale or invalid files from the global instance registry.
 * Stale = dead PID. Invalid = unreadable/invalid JSON lock file.
 */
export async function pruneStaleRegistryEntries(
  options: PruneStaleRegistryOptions = {},
): Promise<PruneStaleRegistryResult> {
  const dir = registryDir();
  const dryRun = options.dryRun === true;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { scanned: 0, removed: 0 };
  }

  const jsonEntries = entries.filter((entry) => entry.endsWith(".json"));
  let removed = 0;

  for (const entry of jsonEntries) {
    const file = resolve(dir, entry);
    const info = await readLockFile(file);

    if (info && isPidAlive(info.pid)) {
      continue;
    }

    removed += 1;
    if (!dryRun) {
      await rm(file, { force: true }).catch(() => {});
    }
  }

  return { scanned: jsonEntries.length, removed };
}

// -- Helpers -----------------------------------------------------------------

async function normalizeWorkspacePath(path: string): Promise<string> {
  const absolutePath = resolve(path);

  try {
    return normalizePathCase(resolve(await realpath(absolutePath)));
  } catch {
    return normalizePathCase(absolutePath);
  }
}

function normalizePathCase(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isPathWithin(path: string, base: string): boolean {
  const rel = relative(base, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function pathsOverlap(pathA: string, pathB: string): boolean {
  return pathA === pathB || isPathWithin(pathA, pathB) || isPathWithin(pathB, pathA);
}

async function readLock(lockPath: string): Promise<LockInfo | null> {
  return readLockFile(lockPath);
}

async function readLockFile(path: string): Promise<LockInfo | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const text = await file.text();
    const info = JSON.parse(text) as LockInfo;
    if (!info.pid || !info.project_path) return null;
    return info;
  } catch {
    return null;
  }
}

/** Read the project lock file. Returns null if it doesn't exist or is invalid. */
export async function readProjectLock(projectDir: string): Promise<LockInfo | null> {
  const lockPath = resolve(projectDir, LOCK_FILENAME);
  return readLockFile(lockPath);
}

/** Check whether a process with the given PID is currently running. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 — just checks existence
    return true;
  } catch {
    return false;
  }
}
