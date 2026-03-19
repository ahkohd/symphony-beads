// ---------------------------------------------------------------------------
// Issue data fetching — bd show <id> --json + bd comments <id> --json
// ---------------------------------------------------------------------------

import { exec } from "../exec.ts";
import { resolvePrLink } from "./pr-link-resolver.ts";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function parseDependencies(raw: unknown): IssueDependency[] {
  if (!Array.isArray(raw)) return [];

  const dependencies: IssueDependency[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;

    dependencies.push({
      id: asNullableString(item.id) ?? "",
      title: asNullableString(item.title) ?? "",
      status: asNullableString(item.status) ?? "unknown",
      priority: asNullableNumber(item.priority),
      issue_type: asNullableString(item.issue_type) ?? "task",
      dependency_type: asNullableString(item.dependency_type) ?? "",
    });
  }

  return dependencies;
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

    const parsed = JSON.parse(result.stdout) as unknown;
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!isRecord(candidate)) return null;

    const resolvedIssueId =
      typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : issueId;
    const status = typeof candidate.status === "string" ? candidate.status : "unknown";

    const prResolution = await resolvePrLink({
      issueId: resolvedIssueId,
      status,
      prUrl: asNullableString(candidate.pr_url),
      description: asNullableString(candidate.description),
      comments: candidate.comments,
    });

    return {
      id: resolvedIssueId,
      title: asNullableString(candidate.title) ?? "(untitled)",
      description: asNullableString(candidate.description),
      status,
      priority: asNullableNumber(candidate.priority),
      issue_type: asNullableString(candidate.issue_type) ?? "task",
      owner: asNullableString(candidate.owner),
      created_at: asNullableString(candidate.created_at),
      created_by: asNullableString(candidate.created_by),
      updated_at: asNullableString(candidate.updated_at),
      dependencies: parseDependencies(candidate.dependencies),
      pr_url: prResolution.url,
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

    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];

    const comments: IssueComment[] = [];
    for (const item of parsed) {
      if (!isRecord(item)) continue;

      comments.push({
        id: typeof item.id === "string" ? item.id : undefined,
        author: asNullableString(item.author) ?? asNullableString(item.created_by) ?? "unknown",
        body:
          asNullableString(item.text) ??
          asNullableString(item.body) ??
          asNullableString(item.content) ??
          "",
        created_at: asNullableString(item.created_at) ?? "",
      });
    }

    return comments;
  } catch {
    return [];
  }
}
