import { exec } from "../exec.ts";

export interface Issue {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  issue_type: string;
  owner: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
}

/** Position of the selected card: column index + card index within column. */
export interface CursorPos {
  col: number;
  row: number;
}

export const COLUMNS = [
  { key: "open", label: "Open", color: "#9ece6a" },
  { key: "in_progress", label: "In Progress", color: "#7dcfff" },
  { key: "review", label: "Review", color: "#e0af68" },
  { key: "closed", label: "Closed", color: "#565f89" },
  { key: "deferred", label: "Deferred", color: "#bb9af7" },
] as const;

export const STATUS_ORDER: string[] = COLUMNS.map((c) => c.key);

export const COLORS = {
  bg: "#1a1b26",
  surface: "#24283b",
  border: "#414868",
  borderHighlight: "#7aa2f7",
  text: "#c0caf5",
  textDim: "#565f89",
  accent: "#7aa2f7",
  green: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
  headerBg: "#1f2335",
} as const;

export const PRIORITY_BADGE: Record<number, { label: string; color: string }> = {
  0: { label: "P0", color: COLORS.red },
  1: { label: "P1", color: COLORS.yellow },
  2: { label: "P2", color: COLORS.accent },
  3: { label: "P3", color: COLORS.textDim },
  4: { label: "P4", color: COLORS.textDim },
};

export const POLL_INTERVAL_MS = 5000;

export type ColumnSortMode = "default" | "priority";

export type ScrollBoxRenderableAPI = {
  scrollBy?: (
    delta: number | { x: number; y: number },
    unit?: "absolute" | "viewport" | "content" | "step",
  ) => void;
  scrollTo?: (position: number | { x: number; y: number }) => void;
  scrollChildIntoView?: (childId: string) => void;
  viewport?: {
    height: number;
  };
};

export async function fetchAllIssues(): Promise<Issue[]> {
  try {
    const result = await exec(["bd", "list", "--all", "--json"], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    if (result.code !== 0 || !result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((raw: Record<string, unknown>) => ({
      id: (raw.id as string) ?? "",
      title: (raw.title as string) ?? "(untitled)",
      status: (raw.status as string) ?? "open",
      priority: typeof raw.priority === "number" ? raw.priority : null,
      issue_type: (raw.issue_type as string) ?? "task",
      owner: (raw.owner as string) ?? null,
      created_at: typeof raw.created_at === "string" ? raw.created_at : null,
      updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
      closed_at: typeof raw.closed_at === "string" ? raw.closed_at : null,
    }));
  } catch {
    return [];
  }
}

export async function moveIssueStatus(issueId: string, newStatus: string): Promise<boolean> {
  try {
    const result = await exec(["bd", "update", issueId, "--status", newStatus], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function closeIssue(issueId: string): Promise<boolean> {
  try {
    const result = await exec(["bd", "close", issueId, "--reason", "Closed from TUI"], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

export function makeColumnScrollboxId(columnKey: string): string {
  return `kanban-col-scroll-${columnKey}`;
}

export function makeIssueCardId(issueId: string): string {
  const safeId = issueId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `kanban-card-${safeId}`;
}

export function truncStr(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function parseIssueTs(value: string | null): number {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

export function getRecencyTs(issue: Issue): number {
  return parseIssueTs(issue.closed_at ?? issue.updated_at ?? issue.created_at);
}

export function compareClosedNewestFirst(a: Issue, b: Issue): number {
  const diff = getRecencyTs(b) - getRecencyTs(a);
  if (diff !== 0) return diff;
  return b.id.localeCompare(a.id);
}

export function compareByPriority(a: Issue, b: Issue): number {
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;

  const recencyDiff = getRecencyTs(b) - getRecencyTs(a);
  if (recencyDiff !== 0) return recencyDiff;

  return a.id.localeCompare(b.id);
}

export function filterIssues(issues: Issue[], query: string): Issue[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return issues;

  return issues.filter((issue) => {
    const haystack = [issue.id, issue.title, issue.status, issue.issue_type, issue.owner ?? ""]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalized);
  });
}

export function bucketIssues(
  issues: Issue[],
  sortModes: Readonly<Record<string, ColumnSortMode>>,
): Map<string, Issue[]> {
  const buckets = new Map<string, Issue[]>();
  for (const col of COLUMNS) {
    buckets.set(col.key, []);
  }

  for (const issue of issues) {
    const key = STATUS_ORDER.includes(issue.status) ? issue.status : "open";
    buckets.get(key)!.push(issue);
  }

  for (const col of COLUMNS) {
    const items = buckets.get(col.key);
    if (!items || items.length <= 1) continue;

    const mode = sortModes[col.key] ?? "default";
    if (mode === "priority") {
      items.sort(compareByPriority);
      continue;
    }

    if (col.key === "closed") {
      items.sort(compareClosedNewestFirst);
    }
  }

  return buckets;
}

export function clampCursor(cursor: CursorPos, buckets: Map<string, Issue[]>): CursorPos {
  const col = Math.max(0, Math.min(cursor.col, COLUMNS.length - 1));
  const colKey = COLUMNS[col]!.key;
  const items = buckets.get(colKey) ?? [];
  const row = items.length > 0 ? Math.max(0, Math.min(cursor.row, items.length - 1)) : 0;
  return { col, row };
}
