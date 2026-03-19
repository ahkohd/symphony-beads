// ---------------------------------------------------------------------------
// Issue data fetching — bd show <id> --json + bd comments <id> --json
// ---------------------------------------------------------------------------

import { exec } from "../exec.ts";
import { parsePrListUrl, parsePrViewUrl, resolvePrUrlForIssue } from "./pr-link-resolver.ts";

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

async function lookupPrUrlByNumber(prNumber: number): Promise<string | null> {
  const prView = await exec(["gh", "pr", "view", String(prNumber), "--json", "url"], {
    cwd: process.cwd(),
    timeout: 10000,
  });

  if (prView.code !== 0 || !prView.stdout.trim()) return null;
  return parsePrViewUrl(prView.stdout);
}

async function lookupPrUrlViaGitHub(issueId: string): Promise<string | null> {
  const byHead = await exec(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      `issue/${issueId}`,
      "--json",
      "url",
      "--limit",
      "1",
    ],
    {
      cwd: process.cwd(),
      timeout: 10000,
    },
  );

  if (byHead.code === 0 && byHead.stdout.trim()) {
    const url = parsePrListUrl(byHead.stdout);
    if (url) return url;
  }

  const byTitle = await exec(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "all",
      "--search",
      `${issueId} in:title`,
      "--json",
      "url",
      "--limit",
      "1",
    ],
    {
      cwd: process.cwd(),
      timeout: 10000,
    },
  );

  if (byTitle.code === 0 && byTitle.stdout.trim()) {
    return parsePrListUrl(byTitle.stdout);
  }

  return null;
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

    const issueRecord = issue as Record<string, unknown>;

    const resolvedIssueId =
      typeof issueRecord.id === "string" && issueRecord.id.trim() ? issueRecord.id.trim() : issueId;
    const status = typeof issueRecord.status === "string" ? issueRecord.status : "unknown";

    const prUrl = await resolvePrUrlForIssue({
      issue: issueRecord,
      issueId: resolvedIssueId,
      status,
      lookupPrUrlByNumber,
      lookupPrUrlViaGitHub,
    });

    return {
      id: resolvedIssueId,
      title: issue.title ?? "(untitled)",
      description: issue.description ?? null,
      status,
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
      body:
        (c.text as string | undefined) ??
        (c.body as string | undefined) ??
        (c.content as string | undefined) ??
        "",
      created_at: (c.created_at as string | undefined) ?? "",
    }));
  } catch {
    return [];
  }
}
