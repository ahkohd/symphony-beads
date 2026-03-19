import { COLUMNS, STATUS_ORDER } from "./constants.ts";
import type { ColumnSortMode, CursorPos, Issue } from "./types.ts";

function parseIssueTimestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRecencyTimestamp(issue: Issue): number {
  return parseIssueTimestamp(issue.closed_at ?? issue.updated_at ?? issue.created_at);
}

function compareClosedNewestFirst(a: Issue, b: Issue): number {
  const diff = getRecencyTimestamp(b) - getRecencyTimestamp(a);
  if (diff !== 0) return diff;
  return b.id.localeCompare(a.id);
}

function compareByPriority(a: Issue, b: Issue): number {
  const priorityA = a.priority ?? Number.POSITIVE_INFINITY;
  const priorityB = b.priority ?? Number.POSITIVE_INFINITY;

  if (priorityA !== priorityB) {
    return priorityA - priorityB;
  }

  const recencyDiff = getRecencyTimestamp(b) - getRecencyTimestamp(a);
  if (recencyDiff !== 0) {
    return recencyDiff;
  }

  return a.id.localeCompare(b.id);
}

export function makeColumnScrollboxId(columnKey: string): string {
  return `kanban-col-scroll-${columnKey}`;
}

export function makeIssueCardId(issueId: string): string {
  const safeId = issueId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `kanban-card-${safeId}`;
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
  for (const column of COLUMNS) {
    buckets.set(column.key, []);
  }

  for (const issue of issues) {
    const key = STATUS_ORDER.includes(issue.status) ? issue.status : "open";
    buckets.get(key)?.push(issue);
  }

  for (const column of COLUMNS) {
    const items = buckets.get(column.key);
    if (!items || items.length <= 1) continue;

    const mode = sortModes[column.key] ?? "default";
    if (mode === "priority") {
      items.sort(compareByPriority);
      continue;
    }

    if (column.key === "closed") {
      items.sort(compareClosedNewestFirst);
    }
  }

  return buckets;
}

export function clampCursor(cursor: CursorPos, buckets: Map<string, Issue[]>): CursorPos {
  const col = Math.max(0, Math.min(cursor.col, COLUMNS.length - 1));
  const colKey = COLUMNS[col]?.key;
  const items = colKey ? (buckets.get(colKey) ?? []) : [];
  const row = items.length > 0 ? Math.max(0, Math.min(cursor.row, items.length - 1)) : 0;
  return { col, row };
}

export function getColumnKey(colIndex: number): string | null {
  return COLUMNS[colIndex]?.key ?? null;
}

export function getColumnIssues(colIndex: number, buckets: Map<string, Issue[]>): Issue[] {
  const colKey = getColumnKey(colIndex);
  if (!colKey) return [];
  return buckets.get(colKey) ?? [];
}

export function moveCursorHorizontal(
  cursor: CursorPos,
  delta: -1 | 1,
  buckets: Map<string, Issue[]>,
): CursorPos {
  const nextCol = Math.max(0, Math.min(COLUMNS.length - 1, cursor.col + delta));
  const items = getColumnIssues(nextCol, buckets);
  const row = items.length > 0 ? Math.min(cursor.row, items.length - 1) : 0;
  return { col: nextCol, row };
}

export function moveCursorVertical(
  cursor: CursorPos,
  delta: -1 | 1,
  buckets: Map<string, Issue[]>,
): CursorPos {
  const items = getColumnIssues(cursor.col, buckets);
  if (items.length === 0) return { ...cursor, row: 0 };

  const row = Math.max(0, Math.min(items.length - 1, cursor.row + delta));
  return { ...cursor, row };
}

export function moveCursorToRow(
  cursor: CursorPos,
  row: number,
  buckets: Map<string, Issue[]>,
): CursorPos {
  const items = getColumnIssues(cursor.col, buckets);
  if (items.length === 0) return { ...cursor, row: 0 };

  const clamped = Math.max(0, Math.min(row, items.length - 1));
  return { ...cursor, row: clamped };
}

export function selectColumn(
  cursor: CursorPos,
  colIndex: number,
  buckets: Map<string, Issue[]>,
): CursorPos {
  const items = getColumnIssues(colIndex, buckets);
  const row = items.length > 0 ? Math.min(cursor.row, items.length - 1) : 0;
  return { col: colIndex, row };
}

export function selectCard(
  colIndex: number,
  rowIndex: number,
  buckets: Map<string, Issue[]>,
): CursorPos {
  const items = getColumnIssues(colIndex, buckets);
  const row = items.length > 0 ? Math.max(0, Math.min(rowIndex, items.length - 1)) : 0;
  return { col: colIndex, row };
}
