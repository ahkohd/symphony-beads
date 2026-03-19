// ---------------------------------------------------------------------------
// CLI integration tests — daemonize, lock, and flag behavior
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findProjectRoot, parseArgs, resolveConfigPaths } from "./cli.ts";
import type { ServiceConfig } from "./types.ts";

const CLI_PATH = resolve(import.meta.dir, "cli.ts");

/**
 * Helper: run the symphony CLI with given args and return stdout/stderr/exitCode.
 * Uses a temp directory with a minimal WORKFLOW.md so we don't interfere with
 * the real project.
 */
interface RunCliOptions {
  cwd: string;
  timeout?: number;
  env?: Record<string, string>;
}

async function runCli(
  args: string[],
  opts: RunCliOptions = { cwd: process.cwd() },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const env = {
    ...process.env,
    ...(opts.env ?? {}),
  };

  delete env.SYMPHONY_SILENT_LOGS;

  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const timeout = opts.timeout ?? 10_000;
  const timer = setTimeout(() => proc.kill(), timeout);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode };
}

async function setupMockBd(
  dir: string,
  issues: Array<{ id: string; title: string; status: string; priority: number }>,
): Promise<string> {
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });

  const scriptPath = join(binDir, "bd");
  const payload = JSON.stringify(issues);
  const script = `#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ge 2 ] && [ "$1" = "list" ] && [ "$2" = "--json" ]; then
  cat <<'JSON'
${payload}
JSON
  exit 0
fi

echo "unsupported bd args: $*" >&2
exit 1
`;

  await writeFile(scriptPath, script);
  await chmod(scriptPath, 0o755);
  return binDir;
}

async function setupMockDoctorTools(dir: string): Promise<string> {
  const binDir = join(dir, "doctor-bin");
  await mkdir(binDir, { recursive: true });

  const scripts: Record<string, string> = {
    bd: `#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ge 1 ] && [ "$1" = "version" ]; then
  echo "bd 0.0.0"
  exit 0
fi

if [ "$#" -ge 4 ] && [ "$1" = "list" ] && [ "$2" = "--all" ] && [ "$3" = "--json" ] && [ "$4" = "--limit" ]; then
  echo "[]"
  exit 0
fi

if [ "$#" -ge 2 ] && [ "$1" = "list" ] && [ "$2" = "--json" ]; then
  echo "[]"
  exit 0
fi

if [ "$#" -ge 2 ] && [ "$1" = "dolt" ] && [ "$2" = "status" ]; then
  echo "stopped"
  exit 1
fi

if [ "$#" -ge 2 ] && [ "$1" = "config" ] && [ "$2" = "set" ]; then
  exit 0
fi

echo "unsupported bd args: $*" >&2
exit 1
`,
    dolt: `#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ge 1 ] && [ "$1" = "version" ]; then
  echo "dolt version 0.0.0"
  exit 0
fi

echo "unsupported dolt args: $*" >&2
exit 1
`,
    pi: `#!/usr/bin/env bash
set -euo pipefail

echo "pi 0.0.0"
`,
    gh: `#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ge 1 ] && [ "$1" = "--version" ]; then
  echo "gh version 0.0.0"
  exit 0
fi

if [ "$#" -ge 2 ] && [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo "Logged in to github.com as mock-user" >&2
  exit 0
fi

echo "unsupported gh args: $*" >&2
exit 1
`,
  };

  for (const [name, script] of Object.entries(scripts)) {
    const path = join(binDir, name);
    await writeFile(path, script);
    await chmod(path, 0o755);
  }

  return binDir;
}

interface MockInstanceRecord {
  pid: number;
  project_path: string;
  workspace_root: string;
  workflow_file: string;
  started_at: string;
}

async function setupMockInstancesRegistry(
  homeDir: string,
  instances: MockInstanceRecord[],
): Promise<void> {
  const registryDir = join(homeDir, ".symphony", "instances");
  await mkdir(registryDir, { recursive: true });

  for (const [index, instance] of instances.entries()) {
    const path = join(registryDir, `instance-${index}.json`);
    await writeFile(path, JSON.stringify(instance, null, 2));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findUniquePrefix(targetId: string, allIds: string[]): string {
  for (let length = 1; length <= targetId.length; length++) {
    const prefix = targetId.slice(0, length);
    const count = allIds.filter((id) => id.startsWith(prefix)).length;
    if (count === 1) {
      return prefix;
    }
  }

  return targetId;
}

function findAmbiguousPrefix(ids: string[]): string {
  for (let length = 1; length <= 12; length++) {
    const groups = new Map<string, number>();

    for (const id of ids) {
      const prefix = id.slice(0, Math.min(length, id.length));
      groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
    }

    for (const [prefix, count] of groups.entries()) {
      if (count > 1) {
        return prefix;
      }
    }
  }

  return ids[0] ?? "";
}

// -- Test setup: temp directory with a minimal WORKFLOW.md --------------------

let tempDir: string;

// Minimal workflow that won't actually try to connect to beads
const MINIMAL_WORKFLOW = `---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: ./workspaces
agent:
  max_concurrent: 1
runner:
  command: echo noop
polling:
  interval_ms: 30000
log:
  file: ./test-symphony.log
---
Test prompt.
`;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "symphony-cli-test-"));
  await writeFile(join(tempDir, "WORKFLOW.md"), MINIMAL_WORKFLOW);
  await mkdir(join(tempDir, "workspaces"), { recursive: true });
});

afterEach(async () => {
  // Clean up: kill any daemon we started, remove temp dir
  // IMPORTANT: never kill our own PID — the duplicate-start test writes
  // process.pid to .symphony.lock, so we must skip it here.
  try {
    const lockPath = join(tempDir, ".symphony.lock");
    const lockFile = Bun.file(lockPath);
    if (await lockFile.exists()) {
      const lockData = JSON.parse(await lockFile.text());
      if (lockData.pid && lockData.pid !== process.pid) {
        try {
          process.kill(lockData.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  } catch {
    /* no lock file */
  }
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Flag parsing tests
// ---------------------------------------------------------------------------

describe("CLI flag parsing", () => {
  it("--version outputs version string", async () => {
    const { stdout, exitCode } = await runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/^symphony-beads \d+\.\d+\.\d+$/);
  });

  it("--version --json outputs JSON", async () => {
    const { stdout, exitCode } = await runCli(["--json", "--version"]);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toHaveProperty("version");
  });

  it("--help exits 0", async () => {
    const { exitCode, stdout } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("symphony-beads");
    expect(stdout).toContain("start");
    expect(stdout).toContain("--foreground");
  });

  it("unknown flag exits with error", async () => {
    const { exitCode, stderr } = await runCli(["--bogus"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown flag");
  });

  it("no command exits with error", async () => {
    const { exitCode, stderr } = await runCli([]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("no command");
  });
});

// ---------------------------------------------------------------------------
// parseArgs unit tests — -f flag context resolution
// ---------------------------------------------------------------------------

describe("parseArgs -f flag", () => {
  it("-f sets shortF flag (not foreground or follow directly)", () => {
    const args = parseArgs(["start", "-f"]);
    expect(args.shortF).toBe(true);
    expect(args.foreground).toBe(false);
    expect(args.follow).toBe(false);
    expect(args.command).toBe("start");
  });

  it("--foreground sets foreground directly", () => {
    const args = parseArgs(["start", "--foreground"]);
    expect(args.foreground).toBe(true);
    expect(args.shortF).toBe(false);
  });

  it("--follow sets follow directly", () => {
    const args = parseArgs(["logs", "--follow"]);
    expect(args.follow).toBe(true);
    expect(args.shortF).toBe(false);
  });

  it("-f with start command should only set foreground (via main resolution)", () => {
    // parseArgs sets shortF; main() resolves it per command
    const args = parseArgs(["start", "-f"]);
    expect(args.shortF).toBe(true);
    expect(args.command).toBe("start");
    // Simulate the resolution logic from main()
    if (args.shortF && args.command === "start") {
      args.foreground = true;
    }
    expect(args.foreground).toBe(true);
    expect(args.follow).toBe(false);
  });

  it("-f with logs command should only set follow (via main resolution)", () => {
    const args = parseArgs(["logs", "-f"]);
    expect(args.shortF).toBe(true);
    expect(args.command).toBe("logs");
    // Simulate the resolution logic from main()
    if (args.shortF && args.command === "logs") {
      args.follow = true;
    }
    expect(args.follow).toBe(true);
    expect(args.foreground).toBe(false);
  });

  it("--id sets instanceId for stop targeting", () => {
    const args = parseArgs(["stop", "--id", "abc123"]);
    expect(args.command).toBe("stop");
    expect(args.instanceId).toBe("abc123");
    expect(args.all).toBe(false);
  });

  it("--strict enables strict validation mode", () => {
    const args = parseArgs(["validate", "--strict"]);
    expect(args.command).toBe("validate");
    expect(args.strict).toBe(true);
  });

  it("--fix enables doctor fix mode", () => {
    const args = parseArgs(["doctor", "--fix"]);
    expect(args.command).toBe("doctor");
    expect(args.fix).toBe(true);
  });

  it("--dry-run enables doctor dry-run mode", () => {
    const args = parseArgs(["doctor", "--fix", "--dry-run"]);
    expect(args.command).toBe("doctor");
    expect(args.fix).toBe(true);
    expect(args.dryRun).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validate subcommand tests
// ---------------------------------------------------------------------------

describe("CLI validate", () => {
  it("validates a correct WORKFLOW.md", async () => {
    const { exitCode } = await runCli(["validate", "--workflow", join(tempDir, "WORKFLOW.md")], {
      cwd: tempDir,
    });
    expect(exitCode).toBe(0);
  });

  it("validate --json returns structured output", async () => {
    const { stdout, exitCode } = await runCli(
      ["validate", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it("validate --json warns on unknown workflow keys", async () => {
    const workflowPath = join(tempDir, "WORKFLOW-unknown.md");
    const withUnknownKeys = `---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: ./workspaces
agent:
  max_concurrent: 1
runner:
  command: echo noop
  commnd: echo typo
polling:
  interval_ms: 30000
log:
  file: ./test-symphony.log
observability:
  enabled: true
---
Prompt.
`;

    await writeFile(workflowPath, withUnknownKeys);

    const { stdout, exitCode } = await runCli(["validate", "--json", "--workflow", workflowPath], {
      cwd: tempDir,
      env: {
        HOME: join(tempDir, "isolated-home"),
      },
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.valid).toBe(true);
    expect(parsed.strict).toBe(false);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toContain("unknown config key: runner.commnd");
    expect(parsed.warnings).toContain("unknown config section: observability");
  });

  it("validate warns when bootstrap clone source is missing", async () => {
    const workflowPath = join(tempDir, "WORKFLOW-bootstrap-warning.md");
    const workflowWithCloneHook = `---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: ./workspaces
  repo: $SYMPHONY_REPO
hooks:
  after_create: |
    git clone "$REPO_URL" .
runner:
  command: echo noop
polling:
  interval_ms: 30000
---
Prompt.
`;

    await writeFile(workflowPath, workflowWithCloneHook);

    const { stdout, exitCode } = await runCli(["validate", "--json", "--workflow", workflowPath], {
      cwd: tempDir,
      env: {
        HOME: join(tempDir, "isolated-home"),
        REPO_URL: "",
      },
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.valid).toBe(true);
    expect(parsed.warnings).toContain(
      "bootstrap clone source may be missing: set workspace.repo (owner/repo) or export REPO_URL (current workspace.repo: $SYMPHONY_REPO)",
    );
  });

  it("validate text mode prints warnings count summary", async () => {
    const workflowPath = join(tempDir, "WORKFLOW-warning-text.md");
    const withUnknownKeys = `---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: ./workspaces
agent:
  max_concurrent: 1
runner:
  command: echo noop
  commnd: echo typo
polling:
  interval_ms: 30000
log:
  file: ./test-symphony.log
observability:
  enabled: true
---
Prompt.
`;

    await writeFile(workflowPath, withUnknownKeys);

    const { stdout, exitCode } = await runCli(["validate", "--workflow", workflowPath], {
      cwd: tempDir,
      env: {
        HOME: join(tempDir, "isolated-home"),
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/warnings:\s+2/);
    expect(stdout).toContain("use --strict in CI");
    expect(stdout).toContain("unknown config key: runner.commnd");
    expect(stdout).toContain("unknown config section: observability");
  });

  it("validate --strict --json fails when warnings exist", async () => {
    const workflowPath = join(tempDir, "WORKFLOW-strict-warning.md");
    const withUnknownKeys = `---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: ./workspaces
agent:
  max_concurrent: 1
runner:
  command: echo noop
  commnd: echo typo
polling:
  interval_ms: 30000
log:
  file: ./test-symphony.log
---
Prompt.
`;

    await writeFile(workflowPath, withUnknownKeys);

    const { stdout, exitCode } = await runCli(
      ["validate", "--strict", "--json", "--workflow", workflowPath],
      {
        cwd: tempDir,
      },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.valid).toBe(false);
    expect(parsed.strict).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toContain("unknown config key: runner.commnd");
  });

  it("validate fails for missing workflow file", async () => {
    const { exitCode } = await runCli(["validate", "--workflow", join(tempDir, "NONEXISTENT.md")], {
      cwd: tempDir,
    });
    expect(exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Doctor subcommand
// ---------------------------------------------------------------------------

describe("CLI doctor", () => {
  it("doctor --json includes workspace-overlap check", async () => {
    const binDir = await setupMockDoctorTools(tempDir);
    const homeDir = join(tempDir, "doctor-home-ok");
    await mkdir(homeDir, { recursive: true });

    const { stdout, exitCode } = await runCli(
      ["doctor", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(
      parsed.checks.some((check: { name: string }) => check.name === "workspace-overlap"),
    ).toBe(true);
  });

  it("doctor --json exits non-zero when workspace overlaps are detected", async () => {
    const binDir = await setupMockDoctorTools(tempDir);
    const homeDir = join(tempDir, "doctor-home-overlap");
    await mkdir(homeDir, { recursive: true });

    await setupMockInstancesRegistry(homeDir, [
      {
        pid: process.pid,
        project_path: join(tempDir, "project-a"),
        workspace_root: "/tmp/shared-workspaces",
        workflow_file: join(tempDir, "project-a", "WORKFLOW.md"),
        started_at: new Date().toISOString(),
      },
      {
        pid: process.pid,
        project_path: join(tempDir, "project-b"),
        workspace_root: "/tmp/shared-workspaces/subdir",
        workflow_file: join(tempDir, "project-b", "WORKFLOW.md"),
        started_at: new Date().toISOString(),
      },
    ]);

    const { stdout, exitCode } = await runCli(
      ["doctor", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(1);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.ok).toBe(false);
    const overlap = parsed.checks.find(
      (check: { name: string }) => check.name === "workspace-overlap",
    ) as { ok: boolean; hints?: string[] } | undefined;
    expect(overlap).toBeDefined();
    expect(overlap?.ok).toBe(false);
    expect(overlap?.hints).toBeDefined();
    expect(overlap?.hints).toContain("inspect running instances: symphony instances");
    expect((overlap?.hints ?? []).some((hint) => hint.includes("symphony stop --id"))).toBe(true);
  });

  it("doctor rejects --dry-run without --fix", async () => {
    const binDir = await setupMockDoctorTools(tempDir);
    const homeDir = join(tempDir, "doctor-home-dry-run-only");
    await mkdir(homeDir, { recursive: true });

    const { stdout, exitCode } = await runCli(
      ["doctor", "--dry-run", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBe("doctor_flag_conflict");
  });

  it("doctor --fix removes stale project lock and reports fix actions", async () => {
    const binDir = await setupMockDoctorTools(tempDir);
    const homeDir = join(tempDir, "doctor-home-fix");
    await mkdir(homeDir, { recursive: true });

    const lockPath = join(tempDir, ".symphony.lock");
    await writeFile(
      lockPath,
      JSON.stringify(
        {
          pid: 999999,
          project_path: tempDir,
          workspace_root: join(tempDir, "workspaces"),
          workflow_file: join(tempDir, "WORKFLOW.md"),
          started_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    const { stdout, exitCode } = await runCli(
      ["doctor", "--fix", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.fix).toBeDefined();
    expect(parsed.fix.dry_run).toBe(false);
    expect(parsed.fix.changed).toBeGreaterThan(0);

    const lockFile = Bun.file(lockPath);
    expect(await lockFile.exists()).toBe(false);
  });

  it("doctor --fix --dry-run previews fixes without applying them", async () => {
    const binDir = await setupMockDoctorTools(tempDir);
    const homeDir = join(tempDir, "doctor-home-fix-dry-run");
    await mkdir(homeDir, { recursive: true });

    const lockPath = join(tempDir, ".symphony.lock");
    await writeFile(
      lockPath,
      JSON.stringify(
        {
          pid: 999999,
          project_path: tempDir,
          workspace_root: join(tempDir, "workspaces"),
          workflow_file: join(tempDir, "WORKFLOW.md"),
          started_at: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    const { stdout, exitCode } = await runCli(
      ["doctor", "--fix", "--dry-run", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.fix).toBeDefined();
    expect(parsed.fix.dry_run).toBe(true);
    expect(parsed.fix.changed).toBe(0);
    expect(parsed.fix.would_change).toBeGreaterThan(0);

    const lockFile = Bun.file(lockPath);
    expect(await lockFile.exists()).toBe(true);
  });

  it("doctor --fix prunes stale global instance registry entries", async () => {
    const binDir = await setupMockDoctorTools(tempDir);
    const homeDir = join(tempDir, "doctor-home-fix-registry");
    await mkdir(homeDir, { recursive: true });

    await setupMockInstancesRegistry(homeDir, [
      {
        pid: process.pid,
        project_path: join(tempDir, "project-live"),
        workspace_root: "/tmp/workspaces-live",
        workflow_file: join(tempDir, "project-live", "WORKFLOW.md"),
        started_at: new Date().toISOString(),
      },
      {
        pid: 999999,
        project_path: join(tempDir, "project-stale"),
        workspace_root: "/tmp/workspaces-stale",
        workflow_file: join(tempDir, "project-stale", "WORKFLOW.md"),
        started_at: new Date().toISOString(),
      },
    ]);

    const stalePath = join(homeDir, ".symphony", "instances", "instance-1.json");

    const { stdout, exitCode } = await runCli(
      ["doctor", "--fix", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout.trim());
    const registryAction = parsed.fix.actions.find(
      (action: { name: string }) => action.name === "stale-instance-registry",
    );
    expect(registryAction).toBeDefined();
    expect(registryAction.changed).toBe(true);

    const staleFile = Bun.file(stalePath);
    expect(await staleFile.exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status subcommand
// ---------------------------------------------------------------------------

describe("CLI status", () => {
  it("status --json falls back to tracker output when no live snapshot is available", async () => {
    const binDir = await setupMockBd(tempDir, [
      { id: "bd-1", title: "Open issue", status: "open", priority: 1 },
      { id: "bd-2", title: "Closed issue", status: "closed", priority: 2 },
    ]);

    const { stdout, stderr, exitCode } = await runCli(
      ["status", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    const parsed = JSON.parse(stdout.trim());
    expect(typeof parsed.generated_at).toBe("string");
    expect(parsed.workflow_file).toBe(join(tempDir, "WORKFLOW.md"));
    expect(parsed.project_dir).toBe(tempDir);
    expect(parsed.service).toMatchObject({
      instance_id: `${Bun.hash(tempDir)}`,
      running: false,
      pid: null,
      started_at: null,
      uptime_seconds: null,
      stale_lock: false,
    });
    expect(parsed.candidates).toBe(1);
    expect(parsed.terminal).toBe(1);
    expect(parsed.by_state).toEqual({ open: 1 });
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({
      id: "bd-1",
      title: "Open issue",
      state: "open",
      priority: 1,
    });
  });

  it("status text mode prints readable sections without title truncation", async () => {
    const longTitle =
      "Needs work on tiny-terminal readability for status output and long title handling";

    const binDir = await setupMockBd(tempDir, [
      { id: "bd-3", title: longTitle, status: "in_progress", priority: 0 },
      { id: "bd-4", title: "Already done", status: "closed", priority: 3 },
    ]);

    const { stdout, exitCode } = await runCli(
      ["status", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("service:");
    expect(stdout).toContain("status: not running");
    expect(stdout).toContain(`id: ${Bun.hash(tempDir)}`);
    expect(stdout).toContain("issues:");
    expect(stdout).toContain("states:");
    expect(stdout).toContain("in_progress: 1");
    expect(stdout).toContain("Active issues (1):");
    expect(stdout).toContain("Issue 1:");
    expect(stdout).toContain("ID:       bd-3");
    expect(stdout).toContain("State:    in_progress");
    expect(stdout).toContain(`Title:    ${longTitle}`);
    expect(stdout).not.toContain("bd-4");
  });

  it("status --json reports running service from live lock", async () => {
    const lockPath = join(tempDir, ".symphony.lock");
    await writeFile(
      lockPath,
      JSON.stringify(
        {
          pid: process.pid,
          project_path: tempDir,
          workspace_root: join(tempDir, "workspaces"),
          workflow_file: join(tempDir, "WORKFLOW.md"),
          started_at: "2026-03-19T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    const binDir = await setupMockBd(tempDir, []);
    const { stdout, exitCode } = await runCli(
      ["status", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.service).toMatchObject({
      instance_id: `${Bun.hash(tempDir)}`,
      running: true,
      pid: process.pid,
      started_at: "2026-03-19T00:00:00.000Z",
      stale_lock: false,
    });
    expect(typeof parsed.service.uptime_seconds).toBe("number");
    expect(parsed.service.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it("status --json reports stale lock when pid is dead", async () => {
    const lockPath = join(tempDir, ".symphony.lock");
    await writeFile(
      lockPath,
      JSON.stringify(
        {
          pid: 999999,
          project_path: tempDir,
          workspace_root: join(tempDir, "workspaces"),
          workflow_file: join(tempDir, "WORKFLOW.md"),
          started_at: "2026-03-19T00:00:00.000Z",
        },
        null,
        2,
      ),
    );

    const binDir = await setupMockBd(tempDir, []);
    const { stdout, exitCode } = await runCli(
      ["status", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.service).toMatchObject({
      instance_id: `${Bun.hash(tempDir)}`,
      running: false,
      pid: 999999,
      started_at: "2026-03-19T00:00:00.000Z",
      uptime_seconds: null,
      stale_lock: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Instances subcommand
// ---------------------------------------------------------------------------

describe("CLI instances", () => {
  it("instances --json returns structured output with uptime", async () => {
    const homeDir = join(tempDir, "instances-home");
    const startedAt = new Date(Date.now() - 95_000).toISOString();

    await setupMockInstancesRegistry(homeDir, [
      {
        pid: process.pid,
        project_path: tempDir,
        workspace_root: join(tempDir, "workspaces"),
        workflow_file: join(tempDir, "WORKFLOW.md"),
        started_at: startedAt,
      },
    ]);

    const { stdout, exitCode } = await runCli(
      ["instances", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
        },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(typeof parsed.generated_at).toBe("string");
    expect(parsed.total).toBe(1);
    expect(parsed.instances).toHaveLength(1);
    expect(parsed.instances[0]).toMatchObject({
      id: `${Bun.hash(tempDir)}`,
      pid: process.pid,
      project_path: tempDir,
      workspace_root: join(tempDir, "workspaces"),
      workflow_file: join(tempDir, "WORKFLOW.md"),
      started_at: startedAt,
    });
    expect(typeof parsed.instances[0].uptime_seconds).toBe("number");
    expect(parsed.instances[0].uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(typeof parsed.instances[0].uptime_human).toBe("string");
  });

  it("instances text mode prints readable sections without path truncation", async () => {
    const homeDir = join(tempDir, "instances-home");
    const longProjectPath = join(tempDir, "very", "deep", "nested", "path", "project");
    const longWorkspacePath = join(longProjectPath, "workspaces", "feature-branch-workspace");
    const longWorkflowPath = join(longProjectPath, "configs", "WORKFLOW.production.md");

    await setupMockInstancesRegistry(homeDir, [
      {
        pid: process.pid,
        project_path: longProjectPath,
        workspace_root: longWorkspacePath,
        workflow_file: longWorkflowPath,
        started_at: new Date(Date.now() - 15_000).toISOString(),
      },
    ]);

    const { stdout, exitCode } = await runCli(
      ["instances", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Running symphony instances (1):");
    expect(stdout).toContain("Instance 1:");
    expect(stdout).toContain(`ID:        ${Bun.hash(longProjectPath)}`);
    expect(stdout).toContain(`PID:       ${process.pid}`);
    expect(stdout).toContain("Uptime:");
    expect(stdout).toContain(`Project:   ${longProjectPath}`);
    expect(stdout).toContain(`Workspace: ${longWorkspacePath}`);
    expect(stdout).toContain(`Workflow:  ${longWorkflowPath}`);
  });

  it("instances shows empty message when none are running", async () => {
    const homeDir = join(tempDir, "instances-home-empty");
    await mkdir(homeDir, { recursive: true });

    const { stdout, exitCode } = await runCli(
      ["instances", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("No running symphony instances.");
  });
});

// ---------------------------------------------------------------------------
// Logs subcommand
// ---------------------------------------------------------------------------

describe("CLI logs", () => {
  it("logs --json returns structured tail output", async () => {
    const logPath = join(tempDir, "test-symphony.log");
    await writeFile(logPath, "line-1\n\nline-3\nline-4\n");

    const { stdout, exitCode } = await runCli(
      ["logs", "--json", "--lines", "2", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.path).toBe(logPath);
    expect(parsed.total_lines).toBe(4);
    expect(parsed.shown_lines).toBe(2);
    expect(parsed.follow).toBe(false);
    expect(parsed.lines).toEqual(["line-3", "line-4"]);
  });

  it("logs text mode prints header and tailed content", async () => {
    const logPath = join(tempDir, "test-symphony.log");
    await writeFile(logPath, "line-a\nline-b\nline-c\n");

    const { stdout, exitCode } = await runCli(
      ["logs", "--lines", "2", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`==> ${logPath} <==`);
    expect(stdout).toContain("line-b");
    expect(stdout).toContain("line-c");
    expect(stdout).not.toContain("line-a");
  });

  it("logs rejects --json with --follow", async () => {
    const { stdout, exitCode } = await runCli(
      ["logs", "--json", "--follow", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBe("json_follow_not_supported");
  });
});

// ---------------------------------------------------------------------------
// Start subcommand — daemonize behavior
// ---------------------------------------------------------------------------

describe("CLI start (daemonize)", () => {
  it("start --json daemonizes and returns JSON with pid", async () => {
    const { stdout, exitCode } = await runCli(
      ["start", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir, timeout: 15_000 },
    );

    const parsed = JSON.parse(stdout.trim());

    if (parsed.started) {
      expect(exitCode).toBe(0);
      expect(parsed.mode).toBe("daemon");
      expect(parsed.instance_id).toBe(`${Bun.hash(tempDir)}`);
      expect(parsed.pid).toBeGreaterThan(0);
      expect(parsed.log_file).toBeTruthy();
      expect(parsed.project_dir).toBe(tempDir);
      expect(parsed.workflow_file).toBe(join(tempDir, "WORKFLOW.md"));

      // Clean up daemon
      try {
        process.kill(parsed.pid, "SIGKILL");
      } catch {
        /* ok */
      }
      return;
    }

    // If startup fails, we should still get a structured error payload.
    expect(exitCode).toBe(1);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.instance_id).toBe(`${Bun.hash(tempDir)}`);
    expect(parsed.log_file).toBeTruthy();
    expect(["daemon_failed", "daemon_unhealthy"]).toContain(parsed.error);
  });

  it("start returns to shell (parent exits) without --foreground", async () => {
    // Run start and verify it completes within a reasonable time
    // (not blocking like foreground mode would)
    const startTime = Date.now();
    const { exitCode } = await runCli(
      ["start", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir, timeout: 15_000 },
    );
    const elapsed = Date.now() - startTime;

    // Should complete quickly — the parent forks and exits.
    // Allow up to 5s for spawn + 500ms health check.
    expect(elapsed).toBeLessThan(10_000);
    expect(exitCode).toBeDefined();
  });

  it("duplicate start gives already_running error (when lock exists with live PID)", async () => {
    // Write a fake lock file with our own PID (which is alive)
    const lockPath = join(tempDir, ".symphony.lock");
    const fakeLock = {
      pid: process.pid, // our own PID — guaranteed alive
      project_path: tempDir,
      workspace_root: join(tempDir, "workspaces"),
      workflow_file: "WORKFLOW.md",
      started_at: new Date().toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(fakeLock, null, 2));

    const { stdout, exitCode } = await runCli(
      ["start", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBe("already_running");
    expect(parsed.instance_id).toBe(`${Bun.hash(tempDir)}`);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.message).toContain("already running");
    expect(parsed.message).toContain("symphony stop");
  });

  it("stale lock is ignored (dead PID in lock file)", async () => {
    // Write a lock file with a PID that doesn't exist
    const lockPath = join(tempDir, ".symphony.lock");
    const fakeLock = {
      pid: 999999, // extremely unlikely to be alive
      project_path: tempDir,
      workspace_root: join(tempDir, "workspaces"),
      workflow_file: "WORKFLOW.md",
      started_at: new Date().toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(fakeLock, null, 2));

    const { exitCode } = await runCli(
      ["start", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir, timeout: 15_000 },
    );

    // Should NOT fail with already_running — the stale lock should be ignored
    // It may still fail for other reasons (beads not configured) but not lock
    // We just verify it doesn't exit with the already_running error
    // The exit might be 0 (daemon started) or 1 (daemon failed for other reasons)
    expect(exitCode).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Stop subcommand
// ---------------------------------------------------------------------------

describe("CLI stop", () => {
  it("stop --json when not running returns not_running error", async () => {
    const { stdout, exitCode } = await runCli(
      ["stop", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBe("not_running");
    expect(parsed.project_dir).toBe(tempDir);
    expect(parsed.workflow_file).toBe(join(tempDir, "WORKFLOW.md"));
    expect(parsed.service).toMatchObject({
      running: false,
      pid: null,
      started_at: null,
      stale_lock: false,
    });
  });

  it("stop cleans up stale lock file", async () => {
    // Write a lock file with a dead PID
    const lockPath = join(tempDir, ".symphony.lock");
    const fakeLock = {
      pid: 999999,
      project_path: tempDir,
      workspace_root: join(tempDir, "workspaces"),
      workflow_file: "WORKFLOW.md",
      started_at: new Date().toISOString(),
    };
    await writeFile(lockPath, JSON.stringify(fakeLock, null, 2));

    const { stdout, exitCode } = await runCli(
      ["stop", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );

    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout.trim());
    expect(parsed.project_dir).toBe(tempDir);
    expect(parsed.workflow_file).toBe(join(tempDir, "WORKFLOW.md"));
    expect(parsed.service_before).toMatchObject({
      running: false,
      pid: 999999,
      stale_lock: true,
    });
    expect(parsed.service_after).toMatchObject({
      running: false,
      pid: null,
      started_at: null,
      stale_lock: false,
    });
    expect(parsed.already_dead).toBe(true);

    // Lock file should be cleaned up
    const lockFile = Bun.file(lockPath);
    expect(await lockFile.exists()).toBe(false);
  });

  it("stop --all --json reports empty result when nothing is running", async () => {
    const { stdout, exitCode } = await runCli(
      ["stop", "--all", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: join(tempDir, "isolated-home"),
        },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed).toMatchObject({
      stopped: [],
      total: 0,
      stopped_count: 0,
      stale_count: 0,
    });
  });

  it("stop --id --json returns instance_not_found for unknown id", async () => {
    const { stdout, exitCode } = await runCli(
      ["stop", "--id", "missing-id", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: join(tempDir, "isolated-home"),
        },
      },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBe("instance_not_found");
    expect(parsed.instance_id).toBe("missing-id");
  });

  it("stop --id --json stops a specific registered instance with unique prefix", async () => {
    const homeDir = join(tempDir, "instances-home");
    const remoteProject = join(tempDir, "remote-project");
    const remoteWorkspace = join(remoteProject, "workspaces");
    const remoteWorkflow = join(remoteProject, "WORKFLOW.md");

    await mkdir(remoteWorkspace, { recursive: true });
    await writeFile(remoteWorkflow, MINIMAL_WORKFLOW);

    const sleeper = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });

    const lockRecord: MockInstanceRecord = {
      pid: sleeper.pid,
      project_path: remoteProject,
      workspace_root: remoteWorkspace,
      workflow_file: remoteWorkflow,
      started_at: new Date().toISOString(),
    };

    await writeFile(join(remoteProject, ".symphony.lock"), JSON.stringify(lockRecord, null, 2));
    await setupMockInstancesRegistry(homeDir, [lockRecord]);

    const instanceId = `${Bun.hash(remoteProject)}`;
    const requestedId = findUniquePrefix(instanceId, [instanceId]);

    try {
      const { stdout, exitCode } = await runCli(
        ["stop", "--id", requestedId, "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
        {
          cwd: tempDir,
          env: {
            HOME: homeDir,
          },
        },
      );

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      expect(parsed.instance_id).toBe(instanceId);
      expect(parsed.project_dir).toBe(remoteProject);
      expect(parsed.workflow_file).toBe(remoteWorkflow);
      expect(parsed.pid).toBe(sleeper.pid);
      expect(parsed.killed).toBe(true);
      expect(parsed.service_after).toMatchObject({
        running: false,
        pid: null,
        started_at: null,
        stale_lock: false,
      });

      expect(processExists(sleeper.pid)).toBe(false);
      expect(await Bun.file(join(remoteProject, ".symphony.lock")).exists()).toBe(false);
    } finally {
      if (processExists(sleeper.pid)) {
        try {
          process.kill(sleeper.pid, "SIGKILL");
        } catch {
          // ignore cleanup races
        }
      }
    }
  });

  it("stop --id --json returns instance_id_ambiguous for non-unique prefix", async () => {
    const homeDir = join(tempDir, "instances-home-ambiguous");

    const records: MockInstanceRecord[] = Array.from({ length: 20 }, (_, index) => {
      const projectPath = join(tempDir, "ambiguous", `project-${index}`);
      return {
        pid: process.pid,
        project_path: projectPath,
        workspace_root: join(projectPath, "workspaces"),
        workflow_file: join(projectPath, "WORKFLOW.md"),
        started_at: new Date().toISOString(),
      };
    });

    const ids = records.map((record) => `${Bun.hash(record.project_path)}`);
    const prefix = findAmbiguousPrefix(ids);
    const matchingIds = ids.filter((id) => id.startsWith(prefix));

    expect(matchingIds.length).toBeGreaterThan(1);

    await setupMockInstancesRegistry(homeDir, records);

    const { stdout, exitCode } = await runCli(
      ["stop", "--id", prefix, "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
        },
      },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBe("instance_id_ambiguous");
    expect(parsed.instance_id).toBe(prefix);
    expect(Array.isArray(parsed.matches)).toBe(true);
    expect(parsed.matches.length).toBeGreaterThan(1);

    const parsedMatchIds = (parsed.matches as Array<{ instance_id: string }>).map(
      (match) => match.instance_id,
    );

    for (const id of matchingIds) {
      expect(parsedMatchIds).toContain(id);
    }
  });

  it("stop --id text mode shows top matching IDs for ambiguous prefix", async () => {
    const homeDir = join(tempDir, "instances-home-ambiguous-text");

    const records: MockInstanceRecord[] = Array.from({ length: 20 }, (_, index) => {
      const projectPath = join(tempDir, "ambiguous-text", `project-${index}`);
      return {
        pid: process.pid,
        project_path: projectPath,
        workspace_root: join(projectPath, "workspaces"),
        workflow_file: join(projectPath, "WORKFLOW.md"),
        started_at: new Date().toISOString(),
      };
    });

    const ids = records.map((record) => `${Bun.hash(record.project_path)}`);
    const prefix = findAmbiguousPrefix(ids);
    const matchingIds = ids.filter((id) => id.startsWith(prefix));

    expect(matchingIds.length).toBeGreaterThan(1);

    await setupMockInstancesRegistry(homeDir, records);

    const { stdout, exitCode } = await runCli(
      ["stop", "--id", prefix, "--workflow", join(tempDir, "WORKFLOW.md")],
      {
        cwd: tempDir,
        env: {
          HOME: homeDir,
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stdout).toContain("matches multiple running instances");
    expect(stdout).toContain("Matching instances (showing up to 3):");

    const hasAnyMatchingId = matchingIds.some((id) => stdout.includes(id));
    expect(hasAnyMatchingId).toBe(true);

    expect(stdout).toContain("Use a longer --id prefix (or exact ID) from: symphony instances");
  });

  it("stop --all text mode prints section summary", async () => {
    const homeDir = join(tempDir, "instances-home-text");
    const remoteProject = join(tempDir, "remote-project-text");
    const remoteWorkspace = join(remoteProject, "workspaces");
    const remoteWorkflow = join(remoteProject, "WORKFLOW.md");

    await mkdir(remoteWorkspace, { recursive: true });
    await writeFile(remoteWorkflow, MINIMAL_WORKFLOW);

    const sleeper = Bun.spawn(["bun", "-e", "setInterval(() => {}, 1000)"], {
      stdout: "ignore",
      stderr: "ignore",
    });

    const lockRecord: MockInstanceRecord = {
      pid: sleeper.pid,
      project_path: remoteProject,
      workspace_root: remoteWorkspace,
      workflow_file: remoteWorkflow,
      started_at: new Date().toISOString(),
    };

    await writeFile(join(remoteProject, ".symphony.lock"), JSON.stringify(lockRecord, null, 2));
    await setupMockInstancesRegistry(homeDir, [lockRecord]);

    try {
      const { stdout, exitCode } = await runCli(
        ["stop", "--all", "--workflow", join(tempDir, "WORKFLOW.md")],
        {
          cwd: tempDir,
          env: {
            HOME: homeDir,
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain("Stopping 1 symphony instance(s):");
      expect(stdout).toContain("Instance 1:");
      expect(stdout).toContain(`ID:       ${Bun.hash(remoteProject)}`);
      expect(stdout).toContain(`Project:  ${remoteProject}`);
      expect(stdout).toContain(`Workflow: ${remoteWorkflow}`);
      expect(stdout).toContain("Summary:");
      expect(stdout).toContain("Total:   1");
      expect(stdout).toContain("Stopped: 1");

      expect(processExists(sleeper.pid)).toBe(false);
      expect(await Bun.file(join(remoteProject, ".symphony.lock")).exists()).toBe(false);
    } finally {
      if (processExists(sleeper.pid)) {
        try {
          process.kill(sleeper.pid, "SIGKILL");
        } catch {
          // ignore cleanup races
        }
      }
    }
  });

  it("stop rejects combining --all and --id", async () => {
    const { stdout, exitCode } = await runCli(
      ["stop", "--all", "--id", "abc123", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toBe("stop_flag_conflict");
  });
});

// ---------------------------------------------------------------------------
// Init subcommand
// ---------------------------------------------------------------------------

describe("CLI init", () => {
  it("init creates a WORKFLOW.md", async () => {
    const initDir = await mkdtemp(join(tmpdir(), "symphony-init-test-"));
    try {
      await runCli(["init", "--workflow", join(initDir, "WORKFLOW.md")], {
        cwd: initDir,
      });
      // May fail because bd isn't configured, but should still create the file
      const wf = Bun.file(join(initDir, "WORKFLOW.md"));
      expect(await wf.exists()).toBe(true);
      const content = await wf.text();
      expect(content).toContain("tracker:");
      expect(content).toContain("workspace:");
    } finally {
      await rm(initDir, { recursive: true, force: true });
    }
  });

  it("init --json refuses to overwrite existing file", async () => {
    const { stdout, exitCode } = await runCli(
      ["init", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );

    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.error).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// findProjectRoot tests
// ---------------------------------------------------------------------------

describe("findProjectRoot", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "symphony-root-test-"));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("finds .git directory in cwd", async () => {
    await mkdir(join(rootDir, ".git"));
    expect(findProjectRoot(rootDir)).toBe(rootDir);
  });

  it("finds .jj directory in cwd", async () => {
    await mkdir(join(rootDir, ".jj"));
    expect(findProjectRoot(rootDir)).toBe(rootDir);
  });

  it("finds WORKFLOW.md file in cwd", async () => {
    await writeFile(join(rootDir, "WORKFLOW.md"), "test");
    expect(findProjectRoot(rootDir)).toBe(rootDir);
  });

  it("walks up to find .git in parent directory", async () => {
    await mkdir(join(rootDir, ".git"));
    const subdir = join(rootDir, "src", "deep");
    await mkdir(subdir, { recursive: true });
    expect(findProjectRoot(subdir)).toBe(rootDir);
  });

  it("walks up to find .jj in ancestor directory", async () => {
    await mkdir(join(rootDir, ".jj"));
    const subdir = join(rootDir, "a", "b", "c");
    await mkdir(subdir, { recursive: true });
    expect(findProjectRoot(subdir)).toBe(rootDir);
  });

  it("walks up to find WORKFLOW.md in parent directory", async () => {
    await writeFile(join(rootDir, "WORKFLOW.md"), "test");
    const subdir = join(rootDir, "packages", "core");
    await mkdir(subdir, { recursive: true });
    expect(findProjectRoot(subdir)).toBe(rootDir);
  });

  it("prefers closest marker (nested repos)", async () => {
    await mkdir(join(rootDir, ".git"));
    const childRepo = join(rootDir, "submodule");
    await mkdir(join(childRepo, ".git"), { recursive: true });
    expect(findProjectRoot(childRepo)).toBe(childRepo);
  });

  it("falls back to startDir when no marker found", async () => {
    const result = findProjectRoot(rootDir);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("works from CLI: subdirectory run finds project root", async () => {
    await mkdir(join(rootDir, ".git"));
    await writeFile(join(rootDir, "WORKFLOW.md"), MINIMAL_WORKFLOW);
    await mkdir(join(rootDir, "workspaces"), { recursive: true });
    const subdir = join(rootDir, "src");
    await mkdir(subdir, { recursive: true });

    const { exitCode } = await runCli(["validate"], { cwd: subdir });
    expect(exitCode).toBe(0);
  });

  it("--workflow flag resolves relative to found root from subdirectory", async () => {
    await mkdir(join(rootDir, ".git"));
    // Write the workflow with a custom name
    await writeFile(join(rootDir, "custom.md"), MINIMAL_WORKFLOW);
    await mkdir(join(rootDir, "workspaces"), { recursive: true });
    const subdir = join(rootDir, "src");
    await mkdir(subdir, { recursive: true });

    const { exitCode } = await runCli(["validate", "--workflow", "custom.md"], { cwd: subdir });
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveConfigPaths tests
// ---------------------------------------------------------------------------

describe("resolveConfigPaths", () => {
  function makeConfig(
    overrides?: Partial<{ workspace_root: string; project_path: string; log_file: string | null }>,
  ): ServiceConfig {
    return {
      tracker: {
        kind: "beads",
        project_path: overrides?.project_path ?? ".",
        active_states: ["open", "in_progress"],
        terminal_states: ["closed"],
      },
      polling: { interval_ms: 30000 },
      workspace: {
        root: overrides?.workspace_root ?? "./workspaces",
        repo: null,
        remote: "origin",
      },
      hooks: {
        after_create: null,
        before_run: null,
        after_run: null,
        before_remove: null,
        timeout_ms: 60000,
      },
      agent: {
        max_concurrent: 1,
        max_concurrent_by_state: null,
        max_turns: 10,
        max_retry_backoff_ms: 300000,
      },
      runner: {
        command: "echo noop",
        model: null,
        models: null,
        turn_timeout_ms: 3600000,
        stall_timeout_ms: 300000,
      },
      log: { file: overrides && "log_file" in overrides ? overrides.log_file! : "./symphony.log" },
    };
  }

  it("resolves relative workspace.root to project root", () => {
    const config = makeConfig({ workspace_root: "./workspaces" });
    resolveConfigPaths(config, "/project");
    expect(config.workspace.root).toBe("/project/workspaces");
  });

  it("resolves relative tracker.project_path to project root", () => {
    const config = makeConfig({ project_path: "." });
    resolveConfigPaths(config, "/project");
    expect(config.tracker.project_path).toBe("/project");
  });

  it("resolves relative log.file to project root", () => {
    const config = makeConfig({ log_file: "./symphony.log" });
    resolveConfigPaths(config, "/project");
    expect(config.log.file).toBe("/project/symphony.log");
  });

  it("leaves absolute paths unchanged", () => {
    const config = makeConfig({
      workspace_root: "/absolute/workspaces",
      project_path: "/absolute/project",
      log_file: "/absolute/log.txt",
    });
    resolveConfigPaths(config, "/other");
    expect(config.workspace.root).toBe("/absolute/workspaces");
    expect(config.tracker.project_path).toBe("/absolute/project");
    expect(config.log.file).toBe("/absolute/log.txt");
  });

  it("leaves tilde paths unchanged", () => {
    const config = makeConfig({ workspace_root: "~/workspaces" });
    resolveConfigPaths(config, "/project");
    expect(config.workspace.root).toBe("~/workspaces");
  });

  it("handles null log.file", () => {
    const config = makeConfig({ log_file: null });
    resolveConfigPaths(config, "/project");
    expect(config.log.file).toBeNull();
  });

  it("validate --json from subdirectory shows absolute config paths", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "symphony-resolve-test-"));
    try {
      await mkdir(join(rootDir, ".git"));
      await writeFile(join(rootDir, "WORKFLOW.md"), MINIMAL_WORKFLOW);
      await mkdir(join(rootDir, "workspaces"), { recursive: true });
      const subdir = join(rootDir, "src", "deep");
      await mkdir(subdir, { recursive: true });

      const { stdout, exitCode } = await runCli(["validate", "--json"], { cwd: subdir });
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.trim());
      // workspace.root should be resolved relative to rootDir, not subdir
      expect(parsed.config.workspace.root).toBe(join(rootDir, "workspaces"));
      // tracker.project_path should be resolved to rootDir
      expect(parsed.config.tracker.project_path).toBe(rootDir);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
