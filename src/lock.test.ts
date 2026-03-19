import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkWorkspaceCollisions, type LockInfo, pruneStaleRegistryEntries } from "./lock.ts";

let homeDir = "";
const originalHome = process.env.HOME;

async function writeRegistryEntry(name: string, info: LockInfo): Promise<void> {
  const registryDir = join(homeDir, ".symphony", "instances");
  await mkdir(registryDir, { recursive: true });
  await writeFile(join(registryDir, `${name}.json`), JSON.stringify(info, null, 2));
}

function makeEntry(projectPath: string, workspaceRoot: string, pid = process.pid): LockInfo {
  return {
    pid,
    project_path: resolve(projectPath),
    workspace_root: resolve(workspaceRoot),
    workflow_file: resolve(projectPath, "WORKFLOW.md"),
    started_at: new Date().toISOString(),
  };
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "symphony-lock-test-"));
  process.env.HOME = homeDir;
  await mkdir(join(homeDir, ".symphony", "instances"), { recursive: true });
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  await rm(homeDir, { recursive: true, force: true });
});

describe("checkWorkspaceCollisions", () => {
  it("detects exact workspace root collisions", async () => {
    await writeRegistryEntry(
      "instance-1",
      makeEntry("/tmp/project-other", "/tmp/shared-workspaces"),
    );

    const conflicts = await checkWorkspaceCollisions("/tmp/project-mine", "/tmp/shared-workspaces");

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.project_path).toBe(resolve("/tmp/project-other"));
  });

  it("detects collision when my workspace root is nested under another instance", async () => {
    await writeRegistryEntry("instance-1", makeEntry("/tmp/project-other", "/tmp/workspaces"));

    const conflicts = await checkWorkspaceCollisions(
      "/tmp/project-mine",
      "/tmp/workspaces/my-project",
    );

    expect(conflicts).toHaveLength(1);
  });

  it("detects collision when another instance is nested under my workspace root", async () => {
    await writeRegistryEntry(
      "instance-1",
      makeEntry("/tmp/project-other", "/tmp/workspaces/other-project"),
    );

    const conflicts = await checkWorkspaceCollisions("/tmp/project-mine", "/tmp/workspaces");

    expect(conflicts).toHaveLength(1);
  });

  it("does not report collisions for sibling workspace roots", async () => {
    await writeRegistryEntry(
      "instance-1",
      makeEntry("/tmp/project-other", "/tmp/workspaces-other"),
    );

    const conflicts = await checkWorkspaceCollisions("/tmp/project-mine", "/tmp/workspaces");

    expect(conflicts).toHaveLength(0);
  });

  it("skips entries from the same project", async () => {
    await writeRegistryEntry("instance-1", makeEntry("/tmp/project-mine", "/tmp/workspaces"));

    const conflicts = await checkWorkspaceCollisions("/tmp/project-mine", "/tmp/workspaces");

    expect(conflicts).toHaveLength(0);
  });
});

describe("pruneStaleRegistryEntries", () => {
  it("reports stale entries in dry-run mode without removing files", async () => {
    await writeRegistryEntry("live", makeEntry("/tmp/project-live", "/tmp/workspaces-live"));
    await writeRegistryEntry(
      "stale",
      makeEntry("/tmp/project-stale", "/tmp/workspaces-stale", 999_999),
    );

    const result = await pruneStaleRegistryEntries({ dryRun: true });

    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(1);

    const staleFile = Bun.file(join(homeDir, ".symphony", "instances", "stale.json"));
    expect(await staleFile.exists()).toBe(true);
  });

  it("removes stale entries in apply mode", async () => {
    await writeRegistryEntry("live", makeEntry("/tmp/project-live", "/tmp/workspaces-live"));
    await writeRegistryEntry(
      "stale",
      makeEntry("/tmp/project-stale", "/tmp/workspaces-stale", 999_999),
    );

    const result = await pruneStaleRegistryEntries();

    expect(result.scanned).toBe(2);
    expect(result.removed).toBe(1);

    const liveFile = Bun.file(join(homeDir, ".symphony", "instances", "live.json"));
    const staleFile = Bun.file(join(homeDir, ".symphony", "instances", "stale.json"));
    expect(await liveFile.exists()).toBe(true);
    expect(await staleFile.exists()).toBe(false);
  });
});
