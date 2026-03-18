// ---------------------------------------------------------------------------
// Tests for OrchestratorClient — TUI live connection to orchestrator HTTP API
//
// Covers:
//   - API discovery from .symphony.lock (http_port + http_hostname)
//   - fetchLiveState() → GET /api/v1/state
//   - triggerRefresh() → POST /api/v1/refresh
//   - fetchIssueStatus() → GET /api/v1/:identifier
//   - fetchDashboard() → live vs static fallback
//   - isLive(), getApiBase(), invalidateCache()
//   - Error handling: connection refused, non-200, JSON parse errors
//   - Cache behavior: caching after discovery, clearing on failure
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import type { OrchestratorSnapshot } from "../orchestrator.ts";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

const readProjectLockMock = mock(() => Promise.resolve(null as any));

mock.module("../lock.ts", () => ({
  readProjectLock: readProjectLockMock,
}));

const execMock = mock(() =>
  Promise.resolve({ code: 0, stdout: "", stderr: "" }),
);

mock.module("../exec.ts", () => ({
  exec: execMock,
}));

// Save original fetch so we can restore after each test
const originalFetch = globalThis.fetch;

import {
  OrchestratorClient,
  type LiveDashboardState,
  type StaticDashboardState,
} from "./live-client.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
  return {
    generated_at: "2026-03-18T10:00:00.000Z",
    counts: {
      running: 1,
      retrying: 0,
      completed: 2,
      claimed: 1,
    },
    running: [
      {
        issue_id: "bd-42",
        issue_identifier: "symphony-beads-abc",
        title: "Fix the widget",
        state: "in_progress",
        session_id: "sess-1",
        attempt: 1,
        started_at: "2026-03-18T09:55:00.000Z",
        elapsed_ms: 300000,
        last_event: "tool_use",
        last_message: "Running tests...",
        tokens: { input: 5000, output: 2000, cache_read: 0, cache_write: 0, total: 7000, cost: 0 },
      },
    ],
    retrying: [],
    totals: {
      input_tokens: 50000,
      output_tokens: 20000,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 70000,
      total_cost: 0,
      seconds_running: 3600,
    },
    ...overrides,
  };
}

function makeLockInfo(overrides: Record<string, unknown> = {}) {
  return {
    pid: 12345,
    project_path: "/test/project",
    workspace_root: "/test/project/workspaces",
    workflow_file: "WORKFLOW.md",
    started_at: "2026-03-18T09:00:00.000Z",
    http_port: 4500,
    http_hostname: "127.0.0.1",
    ...overrides,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = mock(handler as any) as any;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  readProjectLockMock.mockClear();
  execMock.mockClear();
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// discoverApi
// ---------------------------------------------------------------------------

describe("OrchestratorClient discoverApi", () => {
  it("discovers API from .symphony.lock http_port", async () => {
    readProjectLockMock.mockResolvedValueOnce(makeLockInfo());
    mockFetch((url) => {
      if (url === "http://127.0.0.1:4500/api/v1/state") {
        return jsonResponse(makeSnapshot());
      }
      return new Response("not found", { status: 404 });
    });

    const client = new OrchestratorClient("/test/project");
    const base = await client.discoverApi();

    expect(base).toBe("http://127.0.0.1:4500");
    expect(client.getApiBase()).toBe("http://127.0.0.1:4500");
  });

  it("uses lock file hostname when present", async () => {
    readProjectLockMock.mockResolvedValueOnce(
      makeLockInfo({ http_hostname: "0.0.0.0", http_port: 9999 }),
    );

    mockFetch((url) => {
      if (url === "http://0.0.0.0:9999/api/v1/state") {
        return jsonResponse(makeSnapshot());
      }
      return new Response("not found", { status: 404 });
    });

    const client = new OrchestratorClient("/test/project");
    const base = await client.discoverApi();

    expect(base).toBe("http://0.0.0.0:9999");
  });

  it("defaults hostname to 127.0.0.1 when lock has no http_hostname", async () => {
    readProjectLockMock.mockResolvedValueOnce(
      makeLockInfo({ http_hostname: undefined, http_port: 4500 }),
    );

    mockFetch((url) => {
      if (url === "http://127.0.0.1:4500/api/v1/state") {
        return jsonResponse(makeSnapshot());
      }
      return new Response("not found", { status: 404 });
    });

    const client = new OrchestratorClient("/test/project");
    const base = await client.discoverApi();

    expect(base).toBe("http://127.0.0.1:4500");
  });

  it("returns null when lock has no http_port", async () => {
    readProjectLockMock.mockResolvedValueOnce(
      makeLockInfo({ http_port: undefined }),
    );

    const client = new OrchestratorClient("/test/project");
    const base = await client.discoverApi();

    expect(base).toBeNull();
    expect(client.getApiBase()).toBeNull();
  });

  it("returns null when lock file does not exist", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    const client = new OrchestratorClient("/test/project");
    const base = await client.discoverApi();

    expect(base).toBeNull();
  });

  it("returns null when API probe fails (connection refused)", async () => {
    readProjectLockMock.mockResolvedValueOnce(makeLockInfo());

    mockFetch(() => {
      throw new TypeError("fetch failed");
    });

    const client = new OrchestratorClient("/test/project");
    const base = await client.discoverApi();

    expect(base).toBeNull();
  });

  it("returns null when API probe returns non-200", async () => {
    readProjectLockMock.mockResolvedValueOnce(makeLockInfo());

    mockFetch(() => new Response("error", { status: 500 }));

    const client = new OrchestratorClient("/test/project");
    const base = await client.discoverApi();

    expect(base).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchLiveState
// ---------------------------------------------------------------------------

describe("OrchestratorClient fetchLiveState", () => {
  it("returns snapshot from /api/v1/state", async () => {
    const snapshot = makeSnapshot();
    readProjectLockMock.mockResolvedValueOnce(makeLockInfo());

    mockFetch(() => jsonResponse(snapshot));

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchLiveState();

    expect(result).not.toBeNull();
    expect(result!.generated_at).toBe("2026-03-18T10:00:00.000Z");
    expect(result!.counts.running).toBe(1);
    expect(result!.running).toHaveLength(1);
    expect(result!.running[0]!.issue_identifier).toBe("symphony-beads-abc");
  });

  it("returns null when API is unreachable", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchLiveState();

    expect(result).toBeNull();
  });

  it("clears cache when API returns non-200", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());

    // First: discover succeeds
    mockFetch(() => jsonResponse(makeSnapshot()));
    const client = new OrchestratorClient("/test/project");
    await client.discoverApi();
    expect(client.getApiBase()).toBe("http://127.0.0.1:4500");

    // Then: API returns 500
    mockFetch(() => new Response("error", { status: 500 }));
    const result = await client.fetchLiveState();

    expect(result).toBeNull();
    expect(client.getApiBase()).toBeNull();
  });

  it("clears cache when fetch throws (API went away)", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());

    // First: discover succeeds
    mockFetch(() => jsonResponse(makeSnapshot()));
    const client = new OrchestratorClient("/test/project");
    await client.discoverApi();
    expect(client.getApiBase()).not.toBeNull();

    // Then: API crashes
    mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const result = await client.fetchLiveState();

    expect(result).toBeNull();
    expect(client.getApiBase()).toBeNull();
  });

  it("uses cached API base for subsequent calls", async () => {
    const snapshot = makeSnapshot();
    readProjectLockMock.mockResolvedValue(makeLockInfo());

    mockFetch(() => jsonResponse(snapshot));

    const client = new OrchestratorClient("/test/project");

    // First call: discovery + fetch
    await client.fetchLiveState();

    // Second call should use cache (readProjectLock NOT called again)
    readProjectLockMock.mockClear();
    await client.fetchLiveState();

    expect(readProjectLockMock).not.toHaveBeenCalled();
  });

  it("includes running session tokens and elapsed time", async () => {
    const snapshot = makeSnapshot({
      running: [
        {
          issue_id: "bd-1",
          issue_identifier: "sym-abc",
          title: "Test",
          state: "in_progress",
          session_id: "sess-42",
          attempt: 2,
          started_at: "2026-03-18T09:00:00.000Z",
          elapsed_ms: 120000,
          last_event: "text",
          last_message: "Thinking...",
          tokens: { input: 1000, output: 500, cache_read: 0, cache_write: 0, total: 1500, cost: 0 },
        },
      ],
    });

    readProjectLockMock.mockResolvedValue(makeLockInfo());
    mockFetch(() => jsonResponse(snapshot));

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchLiveState();

    expect(result!.running[0]!.tokens.total).toBe(1500);
    expect(result!.running[0]!.elapsed_ms).toBe(120000);
    expect(result!.running[0]!.attempt).toBe(2);
  });

  it("includes retrying issues with error details", async () => {
    const snapshot = makeSnapshot({
      retrying: [
        {
          issue_id: "bd-2",
          identifier: "sym-def",
          attempt: 3,
          due_at: "2026-03-18T10:05:00.000Z",
          error: "agent crashed",
        },
      ],
      counts: { running: 0, retrying: 1, completed: 5, claimed: 2 },
    });

    readProjectLockMock.mockResolvedValue(makeLockInfo());
    mockFetch(() => jsonResponse(snapshot));

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchLiveState();

    expect(result!.retrying).toHaveLength(1);
    expect(result!.retrying[0]!.error).toBe("agent crashed");
    expect(result!.retrying[0]!.attempt).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// triggerRefresh
// ---------------------------------------------------------------------------

describe("OrchestratorClient triggerRefresh", () => {
  it("POSTs to /api/v1/refresh and returns updated snapshot", async () => {
    const snapshot = makeSnapshot();
    readProjectLockMock.mockResolvedValueOnce(makeLockInfo());

    mockFetch((url, init) => {
      if (url === "http://127.0.0.1:4500/api/v1/state") {
        return jsonResponse(snapshot);
      }
      if (url === "http://127.0.0.1:4500/api/v1/refresh" && init?.method === "POST") {
        return jsonResponse({ ok: true, snapshot });
      }
      return new Response("not found", { status: 404 });
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.triggerRefresh();

    expect(result).not.toBeNull();
    expect(result!.counts.running).toBe(1);
  });

  it("returns null when API is unavailable", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    const client = new OrchestratorClient("/test/project");
    const result = await client.triggerRefresh();

    expect(result).toBeNull();
  });

  it("returns null when refresh endpoint returns non-200", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());

    mockFetch((url) => {
      if (url.includes("/api/v1/state")) return jsonResponse(makeSnapshot());
      return new Response("error", { status: 500 });
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.triggerRefresh();

    expect(result).toBeNull();
  });

  it("clears cache when refresh throws network error", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());

    // Discover first
    mockFetch(() => jsonResponse(makeSnapshot()));
    const client = new OrchestratorClient("/test/project");
    await client.discoverApi();
    expect(client.getApiBase()).not.toBeNull();

    // Refresh fails with network error
    mockFetch(() => {
      throw new TypeError("connection reset");
    });
    await client.triggerRefresh();

    expect(client.getApiBase()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchIssueStatus
// ---------------------------------------------------------------------------

describe("OrchestratorClient fetchIssueStatus", () => {
  it("fetches running issue status from /api/v1/:identifier", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());
    const issueData = {
      status: "running",
      running: {
        issue_id: "bd-42",
        issue_identifier: "symphony-beads-abc",
        title: "Fix widget",
        state: "in_progress",
        session_id: "sess-1",
        attempt: 1,
        started_at: "2026-03-18T09:55:00.000Z",
        elapsed_ms: 300000,
        last_event: "tool_use",
        last_message: "Running tests...",
        tokens: { input: 5000, output: 2000, cache_read: 0, cache_write: 0, total: 7000, cost: 0 },
      },
      retrying: null,
    };

    mockFetch((url) => {
      if (url.includes("/api/v1/state")) return jsonResponse(makeSnapshot());
      if (url.includes("/api/v1/symphony-beads-abc")) return jsonResponse(issueData);
      return new Response("not found", { status: 404 });
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchIssueStatus("symphony-beads-abc");

    expect(result).not.toBeNull();
    expect(result!.status).toBe("running");
    expect(result!.running).not.toBeNull();
    expect(result!.retrying).toBeNull();
  });

  it("returns null when API is unavailable", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchIssueStatus("bd-42");

    expect(result).toBeNull();
  });

  it("returns null when issue not found (404)", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());

    mockFetch((url) => {
      if (url.includes("/api/v1/state")) return jsonResponse(makeSnapshot());
      return new Response("not found", { status: 404 });
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchIssueStatus("nonexistent");

    expect(result).toBeNull();
  });

  it("URL-encodes issue identifiers", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());

    let requestedUrl = "";
    mockFetch((url) => {
      requestedUrl = url as string;
      if (url.includes("/api/v1/state")) return jsonResponse(makeSnapshot());
      return jsonResponse({ status: "known", running: null, retrying: null });
    });

    const client = new OrchestratorClient("/test/project");
    await client.fetchIssueStatus("issue/with spaces");

    expect(requestedUrl).toContain("issue%2Fwith%20spaces");
  });

  it("returns null when fetch throws", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());

    // Discover first
    mockFetch(() => jsonResponse(makeSnapshot()));
    const client = new OrchestratorClient("/test/project");
    await client.discoverApi();

    // Issue status fetch throws
    mockFetch(() => {
      throw new TypeError("network error");
    });
    const result = await client.fetchIssueStatus("bd-42");

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchDashboard (live vs static fallback)
// ---------------------------------------------------------------------------

describe("OrchestratorClient fetchDashboard", () => {
  it("returns live data when API is available", async () => {
    const snapshot = makeSnapshot();
    readProjectLockMock.mockResolvedValue(makeLockInfo());

    mockFetch(() => jsonResponse(snapshot));

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchDashboard();

    expect(result.source).toBe("live");
    const liveResult = result as LiveDashboardState;
    expect(liveResult.snapshot.counts.running).toBe(1);
    expect(liveResult.snapshot.running[0]!.issue_identifier).toBe("symphony-beads-abc");
  });

  it("falls back to static bd list when API unavailable", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    const bdIssues = [
      {
        id: "bd-1",
        identifier: "symphony-beads-x1",
        title: "Test Issue",
        status: "open",
        priority: 2,
        issue_type: "feature",
        owner: "agent@symphony-beads",
        created_at: "2026-03-18T00:00:00Z",
      },
    ];

    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify(bdIssues),
      stderr: "",
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchDashboard();

    expect(result.source).toBe("static");
    const staticResult = result as StaticDashboardState;
    expect(staticResult.issues).toHaveLength(1);
    expect(staticResult.issues[0]!.id).toBe("bd-1");
    expect(staticResult.issues[0]!.identifier).toBe("symphony-beads-x1");
    expect(staticResult.issues[0]!.title).toBe("Test Issue");
    expect(staticResult.issues[0]!.status).toBe("open");
    expect(staticResult.issues[0]!.priority).toBe(2);
  });

  it("returns empty static state when bd list fails", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    execMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchDashboard();

    expect(result.source).toBe("static");
    const staticResult = result as StaticDashboardState;
    expect(staticResult.issues).toHaveLength(0);
    expect(staticResult.generated_at).toBeTruthy();
  });

  it("returns empty static state when bd list returns non-array JSON", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify({ error: "something" }),
      stderr: "",
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchDashboard();

    expect(result.source).toBe("static");
    const staticResult = result as StaticDashboardState;
    expect(staticResult.issues).toHaveLength(0);
  });

  it("returns empty static state when bd list output is empty", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: "",
      stderr: "",
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchDashboard();

    expect(result.source).toBe("static");
    const staticResult = result as StaticDashboardState;
    expect(staticResult.issues).toHaveLength(0);
  });

  it("static fallback normalizes missing fields with defaults", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([
        { id: "bd-99" },
        { id: "bd-100", title: null, status: null, priority: "not-a-number" },
      ]),
      stderr: "",
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchDashboard();

    expect(result.source).toBe("static");
    const staticResult = result as StaticDashboardState;
    expect(staticResult.issues).toHaveLength(2);

    // First issue — all defaults
    expect(staticResult.issues[0]!.title).toBe("(untitled)");
    expect(staticResult.issues[0]!.status).toBe("unknown");
    expect(staticResult.issues[0]!.priority).toBeNull();
    expect(staticResult.issues[0]!.issue_type).toBe("task");
    expect(staticResult.issues[0]!.owner).toBeNull();
    expect(staticResult.issues[0]!.created_at).toBeNull();

    // Second issue — null/invalid values
    expect(staticResult.issues[1]!.title).toBe("(untitled)");
    expect(staticResult.issues[1]!.priority).toBeNull(); // "not-a-number" → null
  });

  it("static fallback uses id as identifier when identifier missing", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([{ id: "bd-50", title: "No Identifier" }]),
      stderr: "",
    });

    const client = new OrchestratorClient("/test/project");
    const result = await client.fetchDashboard();

    const staticResult = result as StaticDashboardState;
    expect(staticResult.issues[0]!.identifier).toBe("bd-50");
  });

  it("static state has generated_at timestamp", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    execMock.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify([]),
      stderr: "",
    });

    const client = new OrchestratorClient("/test/project");
    const before = new Date().toISOString();
    const result = await client.fetchDashboard();
    const after = new Date().toISOString();

    const staticResult = result as StaticDashboardState;
    expect(staticResult.generated_at >= before).toBe(true);
    expect(staticResult.generated_at <= after).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isLive
// ---------------------------------------------------------------------------

describe("OrchestratorClient isLive", () => {
  it("returns true when API is reachable", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());
    mockFetch(() => jsonResponse(makeSnapshot()));

    const client = new OrchestratorClient("/test/project");
    const live = await client.isLive();

    expect(live).toBe(true);
  });

  it("returns false when API is unreachable", async () => {
    readProjectLockMock.mockResolvedValueOnce(null);

    const client = new OrchestratorClient("/test/project");
    const live = await client.isLive();

    expect(live).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// invalidateCache
// ---------------------------------------------------------------------------

describe("OrchestratorClient invalidateCache", () => {
  it("forces re-discovery on next call", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());
    mockFetch(() => jsonResponse(makeSnapshot()));

    const client = new OrchestratorClient("/test/project");

    // First call discovers and caches
    await client.discoverApi();
    expect(client.getApiBase()).toBe("http://127.0.0.1:4500");

    // Invalidate
    client.invalidateCache();
    expect(client.getApiBase()).toBeNull();

    // Next call should re-discover (readProjectLock called again)
    readProjectLockMock.mockClear();
    readProjectLockMock.mockResolvedValueOnce(
      makeLockInfo({ http_port: 5500 }),
    );
    mockFetch(() => jsonResponse(makeSnapshot()));

    await client.discoverApi();
    expect(readProjectLockMock).toHaveBeenCalled();
    expect(client.getApiBase()).toBe("http://127.0.0.1:5500");
  });
});

// ---------------------------------------------------------------------------
// getApiBase (synchronous)
// ---------------------------------------------------------------------------

describe("OrchestratorClient getApiBase", () => {
  it("returns null before discovery", () => {
    const client = new OrchestratorClient("/test/project");
    expect(client.getApiBase()).toBeNull();
  });

  it("returns cached base after successful discovery", async () => {
    readProjectLockMock.mockResolvedValue(makeLockInfo());
    mockFetch(() => jsonResponse(makeSnapshot()));

    const client = new OrchestratorClient("/test/project");
    await client.discoverApi();

    expect(client.getApiBase()).toBe("http://127.0.0.1:4500");
  });
});
