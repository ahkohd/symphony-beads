// ---------------------------------------------------------------------------
// HTTP dashboard & JSON API — spec section 13.7
//
// Optional HTTP server started when --port flag or server.port config is set.
// Uses Bun.serve() for zero-dependency HTTP. Binds to loopback by default.
// ---------------------------------------------------------------------------

import type { Orchestrator, OrchestratorSnapshot } from "./orchestrator.ts";
import type { BeadsTracker } from "./tracker.ts";
import { log } from "./log.ts";

export interface HttpServerOptions {
  port: number;
  hostname?: string; // default: "127.0.0.1"
}

export class HttpDashboard {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private orchestrator: Orchestrator;
  private tracker: BeadsTracker;
  private opts: Required<HttpServerOptions>;

  constructor(
    orchestrator: Orchestrator,
    tracker: BeadsTracker,
    opts: HttpServerOptions,
  ) {
    this.orchestrator = orchestrator;
    this.tracker = tracker;
    this.opts = {
      port: opts.port,
      hostname: opts.hostname ?? "127.0.0.1",
    };
  }

  start(): void {
    this.server = Bun.serve({
      port: this.opts.port,
      hostname: this.opts.hostname,
      fetch: (req) => this.handleRequest(req),
    });

    log.info("HTTP dashboard started", {
      url: `http://${this.opts.hostname}:${this.server.port}`,
    });
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      log.info("HTTP dashboard stopped");
      this.server = null;
    }
  }

  // -- Request routing -------------------------------------------------------

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // GET / — HTML dashboard
      if (method === "GET" && path === "/") {
        return this.serveDashboard();
      }

      // GET /api/v1/state — JSON snapshot
      if (method === "GET" && path === "/api/v1/state") {
        return this.serveState();
      }

      // POST /api/v1/refresh — trigger immediate poll+reconcile
      if (method === "POST" && path === "/api/v1/refresh") {
        return await this.handleRefresh();
      }

      // GET /api/v1/:identifier — per-issue debug details
      if (method === "GET" && path.startsWith("/api/v1/")) {
        const identifier = decodeURIComponent(path.slice("/api/v1/".length));
        if (identifier && identifier !== "state" && identifier !== "refresh") {
          return await this.serveIssueDetail(identifier);
        }
      }

      return jsonResponse({ error: "not found" }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("HTTP handler error", { path, error: msg });
      return jsonResponse({ error: "internal server error", detail: msg }, 500);
    }
  }

  // -- Handlers --------------------------------------------------------------

  private serveDashboard(): Response {
    const snapshot = this.orchestrator.snapshot();
    return new Response(renderDashboard(snapshot), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  private serveState(): Response {
    const snapshot = this.orchestrator.snapshot();
    return jsonResponse(snapshot);
  }

  private async handleRefresh(): Promise<Response> {
    await this.orchestrator.triggerTick();
    const snapshot = this.orchestrator.snapshot();
    return jsonResponse({ ok: true, snapshot });
  }

  private async serveIssueDetail(identifier: string): Promise<Response> {
    const snapshot = this.orchestrator.snapshot();

    // Search running sessions
    const running = snapshot.running.find(
      (r) => r.issue_id === identifier || r.issue_identifier === identifier,
    );

    // Search retry queue
    const retrying = snapshot.retrying.find(
      (r) => r.issue_id === identifier || r.identifier === identifier,
    );

    if (!running && !retrying) {
      // Try fetching from tracker directly
      const issues = await this.tracker.fetchStatesById([identifier]);
      if (issues.length > 0) {
        return jsonResponse({
          issue: issues[0],
          status: "known",
          running: null,
          retrying: null,
        });
      }
      return jsonResponse({ error: "issue not found", identifier }, 404);
    }

    return jsonResponse({
      identifier,
      status: running ? "running" : "retrying",
      running: running ?? null,
      retrying: retrying ?? null,
    });
  }
}

// -- Helpers -----------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// -- Dashboard HTML ----------------------------------------------------------

function renderDashboard(snap: OrchestratorSnapshot): string {
  const runningRows = snap.running
    .map(
      (r) => `
      <tr>
        <td><a href="/api/v1/${encodeURIComponent(r.issue_identifier)}">${esc(r.issue_identifier)}</a></td>
        <td>${esc(r.title)}</td>
        <td><span class="badge state">${esc(r.state)}</span></td>
        <td>${r.attempt}</td>
        <td>${formatDuration(r.elapsed_ms)}</td>
        <td><span class="badge event">${esc(r.last_event ?? "—")}</span></td>
        <td class="msg">${esc(truncate(r.last_message, 120))}</td>
        <td class="num">${fmtNum(r.tokens.total)}</td>
        <td class="num">$${((r.tokens as any).cost ?? 0).toFixed(4)}</td>
      </tr>`,
    )
    .join("\n");

  const retryRows = snap.retrying
    .map(
      (r) => `
      <tr>
        <td><a href="/api/v1/${encodeURIComponent(r.identifier)}">${esc(r.identifier)}</a></td>
        <td>${r.attempt}</td>
        <td>${esc(r.due_at)}</td>
        <td class="msg">${esc(r.error ?? "continuation")}</td>
      </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Symphony Dashboard</title>
  <style>
    :root {
      --bg: #0d1117;
      --surface: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --text2: #8b949e;
      --accent: #58a6ff;
      --green: #3fb950;
      --yellow: #d29922;
      --red: #f85149;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 1.5rem;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
    h2 { font-size: 1.1rem; color: var(--text2); margin: 1.5rem 0 0.5rem; }
    .meta { color: var(--text2); font-size: 0.85rem; margin-bottom: 1rem; }
    .stats {
      display: flex; gap: 1rem; flex-wrap: wrap; margin-bottom: 1.5rem;
    }
    .stat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem 1.25rem;
      min-width: 140px;
    }
    .stat .label { color: var(--text2); font-size: 0.8rem; text-transform: uppercase; }
    .stat .value { font-size: 1.5rem; font-weight: 600; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 1rem;
    }
    th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
    th { color: var(--text2); font-size: 0.8rem; text-transform: uppercase; font-weight: 500; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(88,166,255,0.04); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge {
      display: inline-block;
      padding: 0.1rem 0.5rem;
      border-radius: 12px;
      font-size: 0.75rem;
      font-weight: 500;
    }
    .badge.state { background: rgba(63,185,80,0.15); color: var(--green); }
    .badge.event { background: rgba(88,166,255,0.15); color: var(--accent); }
    .num { font-variant-numeric: tabular-nums; font-family: monospace; font-size: 0.85rem; }
    .msg { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85rem; color: var(--text2); }
    .empty { color: var(--text2); padding: 1rem; text-align: center; }
    .actions { margin-top: 1rem; }
    .actions button {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 0.5rem 1rem;
      cursor: pointer;
      font-size: 0.9rem;
    }
    .actions button:hover { opacity: 0.85; }
    .actions button:disabled { opacity: 0.5; cursor: not-allowed; }
    #refresh-status { color: var(--text2); font-size: 0.85rem; margin-left: 0.75rem; }
    footer { margin-top: 2rem; color: var(--text2); font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>Symphony Dashboard</h1>
  <p class="meta">Generated at ${esc(snap.generated_at)} · Auto-refreshes every 10s</p>

  <div class="stats">
    <div class="stat">
      <div class="label">Running</div>
      <div class="value">${snap.counts.running}</div>
    </div>
    <div class="stat">
      <div class="label">Retrying</div>
      <div class="value">${snap.counts.retrying}</div>
    </div>
    <div class="stat">
      <div class="label">Completed</div>
      <div class="value">${snap.counts.completed}</div>
    </div>
    <div class="stat">
      <div class="label">Claimed</div>
      <div class="value">${snap.counts.claimed}</div>
    </div>
    <div class="stat">
      <div class="label">Total Tokens</div>
      <div class="value">${fmtNum(snap.totals.total_tokens)}</div>
    </div>
    <div class="stat">
      <div class="label">Total Cost</div>
      <div class="value">$${(snap.totals.total_cost ?? 0).toFixed(4)}</div>
    </div>
    <div class="stat">
      <div class="label">Uptime</div>
      <div class="value">${formatDuration(snap.totals.seconds_running * 1000)}</div>
    </div>
  </div>

  <h2>Running Sessions (${snap.counts.running})</h2>
  ${
    snap.running.length > 0
      ? `<table>
    <thead>
      <tr>
        <th>Issue</th>
        <th>Title</th>
        <th>State</th>
        <th>Attempt</th>
        <th>Elapsed</th>
        <th>Last Event</th>
        <th>Message</th>
        <th>Tokens</th>
        <th>Cost</th>
      </tr>
    </thead>
    <tbody>${runningRows}</tbody>
  </table>`
      : `<p class="empty">No sessions running</p>`
  }

  <h2>Retry Queue (${snap.counts.retrying})</h2>
  ${
    snap.retrying.length > 0
      ? `<table>
    <thead>
      <tr>
        <th>Issue</th>
        <th>Attempt</th>
        <th>Due At</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>${retryRows}</tbody>
  </table>`
      : `<p class="empty">Retry queue empty</p>`
  }

  <div class="actions">
    <button id="refresh-btn" onclick="triggerRefresh()">↻ Refresh Now</button>
    <span id="refresh-status"></span>
  </div>

  <footer>
    <p>Symphony-Beads · <a href="/api/v1/state">JSON API</a></p>
  </footer>

  <script>
    // Auto-refresh the page every 10 seconds
    setTimeout(() => location.reload(), 10000);

    async function triggerRefresh() {
      const btn = document.getElementById('refresh-btn');
      const status = document.getElementById('refresh-status');
      btn.disabled = true;
      status.textContent = 'Triggering poll…';
      try {
        const res = await fetch('/api/v1/refresh', { method: 'POST' });
        if (res.ok) {
          status.textContent = 'Done! Reloading…';
          setTimeout(() => location.reload(), 500);
        } else {
          status.textContent = 'Error: ' + res.status;
          btn.disabled = false;
        }
      } catch (e) {
        status.textContent = 'Failed: ' + e.message;
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
}

// -- Utilities ---------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
