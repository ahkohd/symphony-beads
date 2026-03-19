import { Box, Text } from "@opentui/core";

import type { IssueComment, IssueDetail } from "./issue-data.ts";

export type VChild = ReturnType<typeof Box> | ReturnType<typeof Text> | null;

interface DetailColors {
  accent: string;
  cyan: string;
  magenta: string;
  text: string;
  textDim: string;
  border: string;
}

export function buildHeader(issue: IssueDetail, colors: DetailColors): VChild {
  return Box(
    { flexDirection: "column", gap: 0 },
    Text({ content: ` ${issue.id}`, fg: colors.textDim }),
    Text({ content: ` ${issue.title}`, fg: colors.text, attributes: 1 }),
  );
}

export function buildMetadata(
  issue: IssueDetail,
  colors: DetailColors,
  statusColors: Readonly<Record<string, string>>,
  priorityColors: Readonly<Record<number, string>>,
  priorityLabels: Readonly<Record<number, string>>,
): VChild {
  const statusColor = statusColors[issue.status] ?? colors.text;
  const priorityColor =
    issue.priority !== null ? (priorityColors[issue.priority] ?? colors.text) : colors.textDim;
  const priorityLabel =
    issue.priority !== null ? (priorityLabels[issue.priority] ?? `P${issue.priority}`) : "—";

  return Box(
    { flexDirection: "row", gap: 2, paddingLeft: 1 },
    Box(
      { flexDirection: "row", gap: 1 },
      Text({ content: "●", fg: statusColor }),
      Text({ content: issue.status, fg: statusColor }),
    ),
    Text({ content: priorityLabel, fg: priorityColor }),
    Text({ content: issue.issue_type, fg: colors.magenta }),
    issue.owner ? Text({ content: issue.owner, fg: colors.textDim }) : Text({ content: "" }),
  );
}

export function buildDescription(description: string, colors: DetailColors): VChild {
  return Box(
    { paddingLeft: 1, paddingRight: 1, flexDirection: "column" },
    Text({ content: description, fg: colors.text, wrapMode: "word" }),
  );
}

export function buildDivider(colors: DetailColors): VChild {
  return Text({
    content: "─".repeat(300),
    fg: colors.border,
    wrapMode: "none",
  });
}

export function buildPrLink(url: string, colors: DetailColors): VChild {
  return Box(
    { flexDirection: "row", gap: 1, paddingLeft: 1 },
    Text({ content: " PR:", fg: colors.accent, attributes: 1 }),
    Text({ content: url, fg: colors.cyan }),
  );
}

export function buildComment(
  comment: IssueComment,
  colors: DetailColors,
  formatTimestamp: (iso: string) => string,
): VChild {
  const timestamp = comment.created_at ? formatTimestamp(comment.created_at) : "";

  return Box(
    { flexDirection: "column", gap: 0, paddingLeft: 1, paddingBottom: 1 },
    Box(
      { flexDirection: "row", gap: 1 },
      Text({ content: comment.author, fg: colors.cyan, attributes: 1 }),
      Text({ content: timestamp, fg: colors.textDim }),
    ),
    Box({ paddingLeft: 1 }, Text({ content: comment.body, fg: colors.text, wrapMode: "word" })),
  );
}

export function buildDependency(
  dep: {
    id: string;
    title: string;
    status: string;
    dependency_type: string;
  },
  colors: DetailColors,
  statusColors: Readonly<Record<string, string>>,
): VChild {
  const statusColor = statusColors[dep.status] ?? colors.textDim;
  const typeLabel = dep.dependency_type === "blocks" ? "⊘ blocks" : dep.dependency_type;

  return Box(
    {
      flexDirection: "column",
      gap: 0,
      paddingLeft: 1,
      paddingBottom: 1,
    },
    Box(
      { flexDirection: "row", gap: 1, paddingLeft: 1 },
      Text({ content: "●", fg: statusColor }),
      Text({ content: dep.status, fg: statusColor }),
      Text({ content: dep.id, fg: colors.accent }),
      Text({ content: `(${typeLabel})`, fg: colors.textDim }),
    ),
    Box(
      {
        flexDirection: "column",
        paddingLeft: 3,
        paddingRight: 1,
      },
      Text({ content: dep.title, fg: colors.text, wrapMode: "word" }),
    ),
  );
}
