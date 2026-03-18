// ---------------------------------------------------------------------------
// Live Orchestrator Client — connects TUI to a running symphony instance
//
// Discovery order:
//   1. Read .symphony.lock for http_port + http_hostname
//   2. Fall back to WORKFLOW.md server.port config
//   3. If no API available, fall back to `bd list --json` (static view)
//
// Provides:
//   - fetchLiveState(): OrchestratorSnapshot | null
//   - fetchStaticState(): StaticDashboardState (bd list fallback)
//   - triggerRefresh(): POST /api/v1/refresh
//   - discoverApi(): resolve the API base URL or null
// ---------------------------------------------------------------------------

import { resolve } from "path";
import type { OrchestratorSnapshot } from "../orchestrator.ts";
import { readProjectLock, type LockInfo } from "../lock.ts";
import { exec } from "../exec.ts";

/** Timeout for HTTP requests to the orchestrator API (ms). */
const API_TIMEOUT_MS = 3000;

/** Static issue info from `bd list --json` when the API is not available. */
export interface StaticIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  priority: number | null;
  issue_type: string;
  owner: string | null;
  created_at: string | null;
}

/** Static dashboard state when no live orchestrator is available. */
export interface StaticDashboardState {
  source: "static";
  generated_at: string;
  issues: StaticIssue[];
}

/** Live dashboard state from the orchestrator API. */
export interface LiveDashboardState {
  source: "live";
  snapshot: OrchestratorSnapshot;
}

/** Union type for dashboard data — either live or static. */
export type DashboardState = LiveDashboardState | StaticDashboardState;

/**
 * Client that connects the TUI to a running symphony orchestrator's HTTP API.
 * Falls back to static `bd list` data when the orchestrator isn't available.
 */
export class OrchestratorClient {
  private projectDir: string;
  private cachedApiBase: string | null = null;
  private discoveryAttempted = false;

  /**
   * @param projectDir — The project directory containing .symphony.lock and WORKFLOW.md
   */
  constructor(projectDir: string = process.cwd()) {
    this.projectDir = resolve(projectDir);
  }

  /**
   * Discover the orchestrator API base URL.
   *
   * Reads the http_port from .symphony.lock (written by the orchestrator on
   * startup). Returns null if no running instance is found or the API is
   * unreachable.
   */
  async discoverApi(): Promise<string | null> {
    // Try lock file first — it has the definitive port
    const lock = await readProjectLock(this.projectDir);
    if (lock?.http_port) {
      const hostname = lock.http_hostname || "127.0.0.1";
      const base = `http://${hostname}:${lock.http_port}`;
      if (await this.probeApi(base)) {
        this.cachedApiBase = base;
        return base;
      }
    }

    // Try reading port from WORKFLOW.md config as fallback
    const configPort = await this.readConfigPort();
    if (configPort) {
      const base = `http://127.0.0.1:${configPort}`;
      if (await this.probeApi(base)) {
        this.cachedApiBase = base;
        return base;
      }
    }

    this.cachedApiBase = null;
    return null;
  }

  /**
   * Fetch the current dashboard state. Tries the live API first, falls
   * back to static `bd list --json` data.
   */
  async fetchDashboard(): Promise<DashboardState> {
    // Try live API
    const live = await this.fetchLiveState();
    if (live) {
      return { source: "live", snapshot: live };
    }

    // Fall back to static bd data
    return this.fetchStaticState();
  }

  /**
   * Fetch the orchestrator snapshot from /api/v1/state.
   * Returns null if the API is unavailable.
   */
  async fetchLiveState(): Promise<OrchestratorSnapshot | null> {
    const base = this.cachedApiBase ?? (await this.discoverApi());
    if (!base) return null;

    try {
      const resp = await fetch(`${base}/api/v1/state`, {
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!resp.ok) {
        this.cachedApiBase = null;
        return null;
      }
      return (await resp.json()) as OrchestratorSnapshot;
    } catch {
      // API went away — clear cache so next call re-discovers
      this.cachedApiBase = null;
      return null;
    }
  }

  /**
   * Trigger an immediate poll+reconcile cycle via POST /api/v1/refresh.
   * Returns the updated snapshot, or null if the API is unavailable.
   */
  async triggerRefresh(): Promise<OrchestratorSnapshot | null> {
    const base = this.cachedApiBase ?? (await this.discoverApi());
    if (!base) return null;

    try {
      const resp = await fetch(`${base}/api/v1/refresh`, {
        method: "POST",
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { ok: boolean; snapshot: OrchestratorSnapshot };
      return data.snapshot ?? null;
    } catch {
      this.cachedApiBase = null;
      return null;
    }
  }

  /**
   * Fetch issue detail from the orchestrator API for a specific issue.
   * Returns the running/retrying status, or null if not found or API unavailable.
   */
  async fetchIssueStatus(issueId: string): Promise<{
    status: string;
    running: OrchestratorSnapshot["running"][number] | null;
    retrying: OrchestratorSnapshot["retrying"][number] | null;
  } | null> {
    const base = this.cachedApiBase ?? (await this.discoverApi());
    if (!base) return null;

    try {
      const resp = await fetch(
        `${base}/api/v1/${encodeURIComponent(issueId)}`,
        { signal: AbortSignal.timeout(API_TIMEOUT_MS) },
      );
      if (!resp.ok) return null;
      return (await resp.json()) as {
        status: string;
        running: OrchestratorSnapshot["running"][number] | null;
        retrying: OrchestratorSnapshot["retrying"][number] | null;
      };
    } catch {
      return null;
    }
  }

  /**
   * Check whether the orchestrator API is currently reachable.
   */
  async isLive(): Promise<boolean> {
    const base = this.cachedApiBase ?? (await this.discoverApi());
    return base !== null;
  }

  /**
   * Get the cached API base URL (or null if not yet discovered / unavailable).
   */
  getApiBase(): string | null {
    return this.cachedApiBase;
  }

  /**
   * Force re-discovery of the API on the next call.
   */
  invalidateCache(): void {
    this.cachedApiBase = null;
    this.discoveryAttempted = false;
  }

  // -- Private helpers -------------------------------------------------------

  /**
   * Probe the API by hitting /api/v1/state with a short timeout.
   * Returns true if the endpoint responds with 200.
   */
  private async probeApi(base: string): Promise<boolean> {
    try {
      const resp = await fetch(`${base}/api/v1/state`, {
        signal: AbortSignal.timeout(1500),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Read the server.port from WORKFLOW.md config.
   * Returns null if no port is configured or the file doesn't exist.
   */
  private async readConfigPort(): Promise<number | null> {
    try {
      const workflowPath = resolve(this.projectDir, "WORKFLOW.md");
      const file = Bun.file(workflowPath);
      if (!(await file.exists())) return null;

      const content = await file.text();
      const { parseWorkflow } = await import("../config.ts");
      const workflow = parseWorkflow(content);
      return workflow.config.server?.port ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch static issue data from `bd list --json`.
   * This is the fallback when the orchestrator API is not available.
   */
  private async fetchStaticState(): Promise<StaticDashboardState> {
    try {
      const result = await exec(["bd", "list", "--json"], {
        cwd: this.projectDir,
        timeout: 5000,
      });

      if (result.code !== 0 || !result.stdout.trim()) {
        return {
          source: "static",
          generated_at: new Date().toISOString(),
          issues: [],
        };
      }

      const parsed = JSON.parse(result.stdout);
      const issues: StaticIssue[] = (Array.isArray(parsed) ? parsed : []).map(
        (raw: Record<string, unknown>) => ({
          id: (raw.id as string) ?? "",
          identifier: (raw.identifier as string) ?? (raw.id as string) ?? "",
          title: (raw.title as string) ?? "(untitled)",
          status: (raw.status as string) ?? "unknown",
          priority: typeof raw.priority === "number" ? raw.priority : null,
          issue_type: (raw.issue_type as string) ?? "task",
          owner: (raw.owner as string) ?? null,
          created_at: (raw.created_at as string) ?? null,
        }),
      );

      return {
        source: "static",
        generated_at: new Date().toISOString(),
        issues,
      };
    } catch {
      return {
        source: "static",
        generated_at: new Date().toISOString(),
        issues: [],
      };
    }
  }
}
