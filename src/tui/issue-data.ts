// ---------------------------------------------------------------------------
// Issue data fetching — bd show <id> --json + bd comments <id> --json
// ---------------------------------------------------------------------------

import { exec } from "../exec.ts";

/** Full issue detail from `bd show <id> --json`. */
export interface IssueDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number | null;
  issue_type: string;
  owner: string | null;
  created_at: string | null;
  created_by: string | null;
  updated_at: string | null;
  dependencies: IssueDependency[];
  pr_url: string | null;
}

export interface IssueDependency {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  issue_type: string;
  dependency_type: string;
}

export interface IssueComment {
  id?: string;
  author: string;
  body: string;
  created_at: string;
}

/** Optional agent session info from orchestrator API. */
export interface AgentSessionInfo {
  session_id: string | null;
  elapsed_ms: number;
  last_event: string | null;
  last_message: string;
  attempt: number;
  tokens: { input: number; output: number; total: number };
}

/**
 * Fetch issue details via `bd show <id> --json`.
 * Returns null if the command fails or the issue is not found.
 */
export async function fetchIssueDetail(issueId: string): Promise<IssueDetail | null> {
  try {
    const result = await exec(["bd", "show", issueId, "--json"], {
      cwd: process.cwd(),
    });
    if (result.code !== 0 || !result.stdout.trim()) return null;

    const parsed = JSON.parse(result.stdout);
    // bd show --json returns an array with one item
    const issue = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!issue) return null;

    // Try to extract PR URL from description or any field
    let prUrl: string | null = null;
    if (issue.pr_url) {
      prUrl = issue.pr_url;
    } else if (issue.description) {
      const prMatch = issue.description.match(
        /https?:\/\/github\.com\/[^\s]+\/pull\/\d+/,
      );
      if (prMatch) prUrl = prMatch[0];
    }

    return {
      id: issue.id ?? issueId,
      title: issue.title ?? "(untitled)",
      description: issue.description ?? null,
      status: issue.status ?? "unknown",
      priority: issue.priority ?? null,
      issue_type: issue.issue_type ?? "task",
      owner: issue.owner ?? null,
      created_at: issue.created_at ?? null,
      created_by: issue.created_by ?? null,
      updated_at: issue.updated_at ?? null,
      dependencies: Array.isArray(issue.dependencies) ? issue.dependencies : [],
      pr_url: prUrl,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch comments for an issue via `bd comments <id> --json`.
 * Returns an empty array if the command fails.
 */
export async function fetchIssueComments(issueId: string): Promise<IssueComment[]> {
  try {
    const result = await exec(["bd", "comments", issueId, "--json"], {
      cwd: process.cwd(),
    });
    if (result.code !== 0 || !result.stdout.trim()) return [];

    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((c: Record<string, unknown>) => ({
      id: (c.id as string | undefined) ?? undefined,
      author: (c.author as string | undefined) ?? (c.created_by as string | undefined) ?? "unknown",
      body: (c.body as string | undefined) ?? (c.content as string | undefined) ?? "",
      created_at: (c.created_at as string | undefined) ?? "",
    }));
  } catch {
    return [];
  }
}

/**
 * Attempt to fetch agent session info from the orchestrator HTTP API.
 * Returns null if the orchestrator is not running or the issue is not active.
 */
export async function fetchAgentSession(
  issueId: string,
  apiBase = "http://127.0.0.1:4500",
): Promise<AgentSessionInfo | null> {
  try {
    const resp = await fetch(
      `${apiBase}/api/v1/${encodeURIComponent(issueId)}`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!resp.ok) return null;

    const data = (await resp.json()) as Record<string, unknown>;
    const running = data.running as Record<string, unknown> | null;
    if (!running) return null;

    const tokens = running.tokens as
      | { input: number; output: number; total: number }
      | undefined;
    return {
      session_id: (running.session_id as string | null) ?? null,
      elapsed_ms: (running.elapsed_ms as number) ?? 0,
      last_event: (running.last_event as string | null) ?? null,
      last_message: (running.last_message as string) ?? "",
      attempt: (running.attempt as number) ?? 0,
      tokens: tokens ?? { input: 0, output: 0, total: 0 },
    };
  } catch {
    return null;
  }
}
