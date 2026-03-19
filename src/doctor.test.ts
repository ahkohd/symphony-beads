import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkWorkspaceOverlapRisk } from "./doctor.ts";
import type { LockInfo } from "./lock.ts";

let homeDir = "";
const originalHome = process.env.HOME;

async function writeRegistryEntry(name: string, info: LockInfo): Promise<void> {
  const registryDir = join(homeDir, ".symphony", "instances");
  await mkdir(registryDir, { recursive: true });
  await writeFile(join(registryDir, `${name}.json`), JSON.stringify(info, null, 2));
}

function makeEntry(projectPath: string, workspaceRoot: string): LockInfo {
  return {
    pid: process.pid,
    project_path: resolve(projectPath),
    workspace_root: resolve(workspaceRoot),
    workflow_file: resolve(projectPath, "WORKFLOW.md"),
    started_at: new Date().toISOString(),
  };
}

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "symphony-doctor-test-"));
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

describe("checkWorkspaceOverlapRisk", () => {
  it("returns ok when fewer than two instances are running", async () => {
    const result = await checkWorkspaceOverlapRisk();

    expect(result.ok).toBe(true);
    expect(result.name).toBe("workspace-overlap");
    expect(result.detail).toContain("not enough running instances");
  });

  it("returns ok when workspace roots do not overlap", async () => {
    await writeRegistryEntry("instance-1", makeEntry("/tmp/project-a", "/tmp/workspaces-a"));
    await writeRegistryEntry("instance-2", makeEntry("/tmp/project-b", "/tmp/workspaces-b"));

    const result = await checkWorkspaceOverlapRisk();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("no overlapping workspace roots");
  });

  it("returns failure when workspace roots overlap", async () => {
    await writeRegistryEntry("instance-1", makeEntry("/tmp/project-a", "/tmp/workspaces"));
    await writeRegistryEntry(
      "instance-2",
      makeEntry("/tmp/project-b", "/tmp/workspaces/project-b"),
    );

    const result = await checkWorkspaceOverlapRisk();

    expect(result.ok).toBe(false);
    expect(result.detail).toContain(resolve("/tmp/workspaces"));
    expect(result.detail).toContain(resolve("/tmp/workspaces/project-b"));
  });
});
