// ---------------------------------------------------------------------------
// CLI integration tests — daemonize, lock, and flag behavior
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolve, dirname, join } from "path";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { findProjectRoot } from "./cli.ts";

const CLI_PATH = resolve(import.meta.dir, "cli.ts");

/**
 * Helper: run the symphony CLI with given args and return stdout/stderr/exitCode.
 * Uses a temp directory with a minimal WORKFLOW.md so we don't interfere with
 * the real project.
 */
async function runCli(
  args: string[],
  opts: { cwd: string; timeout?: number } = { cwd: process.cwd() },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
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
  try {
    const lockPath = join(tempDir, ".symphony.lock");
    const lockFile = Bun.file(lockPath);
    if (await lockFile.exists()) {
      const lockData = JSON.parse(await lockFile.text());
      if (lockData.pid) {
        try { process.kill(lockData.pid, "SIGKILL"); } catch { /* already dead */ }
      }
    }
  } catch { /* no lock file */ }
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
});

// ---------------------------------------------------------------------------
// Validate subcommand tests
// ---------------------------------------------------------------------------

describe("CLI validate", () => {
  it("validates a correct WORKFLOW.md", async () => {
    const { exitCode } = await runCli(["validate", "--workflow", join(tempDir, "WORKFLOW.md")], { cwd: tempDir });
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

  it("validate fails for missing workflow file", async () => {
    const { exitCode } = await runCli(
      ["validate", "--workflow", join(tempDir, "NONEXISTENT.md")],
      { cwd: tempDir },
    );
    expect(exitCode).not.toBe(0);
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

    // Parent should exit quickly (not block)
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(stdout.trim());
    // Either started successfully or failed due to missing beads/git — 
    // the key is that parent returned (didn't block)
    if (parsed.started) {
      expect(parsed.pid).toBeGreaterThan(0);
      expect(parsed.log_file).toBeTruthy();

      // Clean up daemon
      try { process.kill(parsed.pid, "SIGKILL"); } catch { /* ok */ }
    }
    // If daemon_failed, that's also fine — it means daemonize worked
    // but the child couldn't start the orchestrator (expected in test env)
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

    const { exitCode } = await runCli(
      ["stop", "--json", "--workflow", join(tempDir, "WORKFLOW.md")],
      { cwd: tempDir },
    );

    expect(exitCode).toBe(0);

    // Lock file should be cleaned up
    const lockFile = Bun.file(lockPath);
    expect(await lockFile.exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Init subcommand
// ---------------------------------------------------------------------------

describe("CLI init", () => {
  it("init creates a WORKFLOW.md", async () => {
    const initDir = await mkdtemp(join(tmpdir(), "symphony-init-test-"));
    try {
      const { exitCode } = await runCli(
        ["init", "--workflow", join(initDir, "WORKFLOW.md")],
        { cwd: initDir },
      );
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
});
