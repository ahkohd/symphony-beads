import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServiceConfig } from "./types.ts";

const execMock = mock(() => Promise.resolve({ code: 0, stdout: "", stderr: "" }));

mock.module("./exec.ts", () => ({
  exec: execMock,
}));

import { WorkspaceManager } from "./workspace.ts";

let tempRoot: string;

function makeConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    tracker: {
      kind: "beads",
      project_path: "/test/project",
      active_states: ["open", "in_progress"],
      terminal_states: ["closed", "cancelled", "duplicate"],
    },
    polling: { interval_ms: 30000 },
    workspace: { root: tempRoot },
    hooks: {
      after_create: null,
      before_run: null,
      after_run: null,
      before_remove: null,
      timeout_ms: 60000,
    },
    agent: { max_concurrent: 5, max_turns: 20, max_retry_backoff_ms: 300000 },
    runner: { command: "pi -p", model: null, turn_timeout_ms: 3600000, stall_timeout_ms: 300000 },
    log: { file: null },
    ...overrides,
  };
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "symphony-ws-test-"));
  execMock.mockClear();
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
});

describe("WorkspaceManager sanitization", () => {
  it("sanitizes identifier with special characters", () => {
    const wm = new WorkspaceManager(makeConfig());
    const path = wm.pathFor("bd-42");
    expect(path).toBe(join(tempRoot, "bd-42"));
  });

  it("replaces slashes with underscores", () => {
    const wm = new WorkspaceManager(makeConfig());
    const path = wm.pathFor("issue/bd-42");
    expect(path).toBe(join(tempRoot, "issue_bd-42"));
  });

  it("replaces spaces and special chars", () => {
    const wm = new WorkspaceManager(makeConfig());
    const path = wm.pathFor("my issue (1)");
    expect(path).toBe(join(tempRoot, "my_issue__1_"));
  });

  it("preserves dots, dashes, and underscores", () => {
    const wm = new WorkspaceManager(makeConfig());
    const path = wm.pathFor("bd-42_v1.0");
    expect(path).toBe(join(tempRoot, "bd-42_v1.0"));
  });

  it("handles empty identifier", () => {
    const wm = new WorkspaceManager(makeConfig());
    const path = wm.pathFor("");
    expect(path).toBe(join(tempRoot, ""));
  });
});

describe("WorkspaceManager path containment", () => {
  it("sanitization prevents path traversal", () => {
    const wm = new WorkspaceManager(makeConfig());
    const path = wm.pathFor("../../../etc/passwd");
    expect(path.startsWith(tempRoot)).toBe(true);
  });

  it("ensure creates directory inside root", async () => {
    const wm = new WorkspaceManager(makeConfig());
    const ws = await wm.ensure("bd-100");
    expect(ws.path).toBe(join(tempRoot, "bd-100"));
    expect(resolve(ws.path).startsWith(tempRoot)).toBe(true);
  });

  it("ensure creates .symphony-init marker", async () => {
    const wm = new WorkspaceManager(makeConfig());
    const ws = await wm.ensure("bd-101");
    const marker = Bun.file(join(ws.path, ".symphony-init"));
    expect(await marker.exists()).toBe(true);
    expect(ws.created).toBe(true);
  });

  it("ensure returns created=false for existing workspace", async () => {
    const wm = new WorkspaceManager(makeConfig());
    const ws1 = await wm.ensure("bd-102");
    expect(ws1.created).toBe(true);
    const ws2 = await wm.ensure("bd-102");
    expect(ws2.created).toBe(false);
    expect(ws2.path).toBe(ws1.path);
  });

  it("ensure sets key correctly", async () => {
    const wm = new WorkspaceManager(makeConfig());
    const ws = await wm.ensure("bd-103");
    expect(ws.key).toBe("bd-103");
  });
});

describe("WorkspaceManager hook execution", () => {
  it("runs after_create hook on first ensure", async () => {
    execMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const config = makeConfig({
      hooks: {
        after_create: "git clone $REPO .",
        before_run: null,
        after_run: null,
        before_remove: null,
        timeout_ms: 60000,
      },
    });
    const wm = new WorkspaceManager(config);
    await wm.ensure("bd-200");
    expect(execMock).toHaveBeenCalledTimes(1);
    const call = execMock.mock.calls[0]!;
    expect(call[0]).toEqual(["sh", "-lc", "git clone $REPO ."]);
  });

  it("does not run after_create hook on subsequent ensure", async () => {
    execMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const config = makeConfig({
      hooks: {
        after_create: "echo hello",
        before_run: null,
        after_run: null,
        before_remove: null,
        timeout_ms: 60000,
      },
    });
    const wm = new WorkspaceManager(config);
    await wm.ensure("bd-201");
    execMock.mockClear();
    await wm.ensure("bd-201");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("cleans up workspace when after_create hook fails", async () => {
    execMock.mockResolvedValue({ code: 1, stdout: "", stderr: "hook error" });
    const config = makeConfig({
      hooks: {
        after_create: "exit 1",
        before_run: null,
        after_run: null,
        before_remove: null,
        timeout_ms: 60000,
      },
    });
    const wm = new WorkspaceManager(config);
    await expect(wm.ensure("bd-202")).rejects.toThrow("after_create hook failed");
    const dir = Bun.file(join(tempRoot, "bd-202", ".symphony-init"));
    expect(await dir.exists()).toBe(false);
  });

  it("runs before_run hook and returns true on success", async () => {
    execMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const config = makeConfig({
      hooks: {
        after_create: null,
        before_run: "git pull",
        after_run: null,
        before_remove: null,
        timeout_ms: 60000,
      },
    });
    const wm = new WorkspaceManager(config);
    const result = await wm.beforeRun("/some/path", "bd-300");
    expect(result).toBe(true);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("returns false when before_run hook fails", async () => {
    execMock.mockResolvedValue({ code: 1, stdout: "", stderr: "error" });
    const config = makeConfig({
      hooks: {
        after_create: null,
        before_run: "false",
        after_run: null,
        before_remove: null,
        timeout_ms: 60000,
      },
    });
    const wm = new WorkspaceManager(config);
    const result = await wm.beforeRun("/some/path");
    expect(result).toBe(false);
  });

  it("returns true when no before_run hook configured", async () => {
    const wm = new WorkspaceManager(makeConfig());
    const result = await wm.beforeRun("/some/path");
    expect(result).toBe(true);
    expect(execMock).not.toHaveBeenCalled();
  });

  it("runs after_run hook", async () => {
    execMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const config = makeConfig({
      hooks: {
        after_create: null,
        before_run: null,
        after_run: "echo done",
        before_remove: null,
        timeout_ms: 60000,
      },
    });
    const wm = new WorkspaceManager(config);
    await wm.afterRun("/some/path", "bd-400");
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when no after_run hook configured", async () => {
    const wm = new WorkspaceManager(makeConfig());
    await wm.afterRun("/some/path");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("runs before_remove hook during remove", async () => {
    execMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const config = makeConfig({
      hooks: {
        after_create: null,
        before_run: null,
        after_run: null,
        before_remove: "echo cleaning",
        timeout_ms: 60000,
      },
    });
    const wm = new WorkspaceManager(config);
    await wm.ensure("bd-500");
    execMock.mockClear();
    await wm.remove("bd-500");
    expect(execMock).toHaveBeenCalledTimes(1);
    const marker = Bun.file(join(tempRoot, "bd-500", ".symphony-init"));
    expect(await marker.exists()).toBe(false);
  });

  it("remove is no-op for non-existent workspace", async () => {
    const wm = new WorkspaceManager(makeConfig());
    await wm.remove("bd-nonexistent");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("passes env variables to hooks", async () => {
    execMock.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const config = makeConfig({
      hooks: {
        after_create: null,
        before_run: "echo test",
        after_run: null,
        before_remove: null,
        timeout_ms: 60000,
      },
    });
    const wm = new WorkspaceManager(config);
    await wm.beforeRun("/some/path", "bd-600");
    const call = execMock.mock.calls[0]!;
    const opts = call[1] as { env?: Record<string, string> };
    expect(opts.env?.SYMPHONY_ISSUE_ID).toBe("bd-600");
    expect(opts.env?.SYMPHONY_PROJECT_PATH).toBe(resolve("/test/project"));
  });
});
