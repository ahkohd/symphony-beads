// ---------------------------------------------------------------------------
// TUI data layer — fetches issues from beads (bd) CLI
// ---------------------------------------------------------------------------

import { exec } from "../exec.ts";

/** Issue shape returned by `bd list --all --json` */
export interface BeadIssue {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  issue_type: string;
  owner: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  comment_count: number;
  dependency_count: number;
  dependent_count: number;
}

/** Detail shape returned by `bd show <id> --json` */
export interface BeadIssueDetail extends BeadIssue {
  dependencies?: Array<{
    id: string;
    title: string;
    status: string;
    dependency_type: string;
  }>;
  dependents?: Array<{
    id: string;
    title: string;
    status: string;
    dependency_type: string;
  }>;
}

/** Comment shape from `bd comments <id> --json` */
export interface BeadComment {
  id: string;
  issue_id: string;
  body: string;
  author: string;
  created_at: string;
}

/** Kanban column statuses in display order */
export const KANBAN_STATUSES = ["open", "in_progress", "review", "closed"] as const;
export type KanbanStatus = (typeof KANBAN_STATUSES)[number];

export const STATUS_LABELS: Record<KanbanStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  review: "Review",
  closed: "Closed",
};

/** Status flow for m/M key movement */
const STATUS_ORDER: readonly KanbanStatus[] = KANBAN_STATUSES;

export function nextStatus(current: string): KanbanStatus | null {
  const idx = STATUS_ORDER.indexOf(current as KanbanStatus);
  if (idx < 0 || idx >= STATUS_ORDER.length - 1) return null;
  return STATUS_ORDER[idx + 1] ?? null;
}

export function prevStatus(current: string): KanbanStatus | null {
  const idx = STATUS_ORDER.indexOf(current as KanbanStatus);
  if (idx <= 0) return null;
  return STATUS_ORDER[idx - 1] ?? null;
}

/** Fetch all issues from beads */
export async function fetchAllIssues(): Promise<BeadIssue[]> {
  const result = await exec(["bd", "list", "--all", "--json"], { cwd: process.cwd() });
  if (result.code !== 0) {
    throw new Error(`bd list failed: ${result.stderr}`);
  }
  try {
    return JSON.parse(result.stdout) as BeadIssue[];
  } catch {
    return [];
  }
}

/** Fetch issue detail */
export async function fetchIssueDetail(id: string): Promise<BeadIssueDetail | null> {
  const result = await exec(["bd", "show", id, "--json"], { cwd: process.cwd() });
  if (result.code !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (Array.isArray(parsed)) return (parsed[0] as BeadIssueDetail) ?? null;
    return parsed as BeadIssueDetail;
  } catch {
    return null;
  }
}

/** Fetch comments for an issue */
export async function fetchComments(id: string): Promise<BeadComment[]> {
  const result = await exec(["bd", "comments", id, "--json"], { cwd: process.cwd() });
  if (result.code !== 0) return [];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? (parsed as BeadComment[]) : [];
  } catch {
    return [];
  }
}

/** Move issue to a new status */
export async function moveIssue(id: string, newStatus: KanbanStatus): Promise<boolean> {
  if (newStatus === "closed") {
    const result = await exec(["bd", "close", id], { cwd: process.cwd() });
    return result.code === 0;
  }
  if (newStatus === "open") {
    const result = await exec(["bd", "reopen", id], { cwd: process.cwd() });
    if (result.code === 0) return true;
    const r2 = await exec(["bd", "update", id, "--status", newStatus], { cwd: process.cwd() });
    return r2.code === 0;
  }
  const result = await exec(["bd", "update", id, "--status", newStatus], { cwd: process.cwd() });
  return result.code === 0;
}

/** Close an issue */
export async function closeIssue(id: string): Promise<boolean> {
  const result = await exec(["bd", "close", id], { cwd: process.cwd() });
  return result.code === 0;
}

/** Create a new issue */
export async function createIssue(
  title: string,
  opts?: { description?: string; priority?: number; type?: string },
): Promise<string | null> {
  const args = ["bd", "create", title, "--json"];
  if (opts?.description) args.push("--description", opts.description);
  if (opts?.priority != null) args.push("-p", String(opts.priority));
  if (opts?.type) args.push("-t", opts.type);
  const result = await exec(args, { cwd: process.cwd() });
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    return (parsed.id as string) ?? null;
  } catch {
    return null;
  }
}

/** Group issues by kanban status */
export function groupByStatus(issues: BeadIssue[]): Record<KanbanStatus, BeadIssue[]> {
  const groups: Record<KanbanStatus, BeadIssue[]> = {
    open: [],
    in_progress: [],
    review: [],
    closed: [],
  };
  for (const issue of issues) {
    const status = issue.status as KanbanStatus;
    if (status in groups) {
      groups[status]!.push(issue);
    } else {
      groups.open.push(issue);
    }
  }
  for (const col of KANBAN_STATUSES) {
    groups[col].sort((a, b) => (a.priority ?? 4) - (b.priority ?? 4));
  }
  return groups;
}
