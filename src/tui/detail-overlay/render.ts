import { Box, ScrollBox, Text } from "@opentui/core";
import { canOpenPr } from "../external-actions.ts";
import type { IssueComment, IssueDetail } from "../issue-data.ts";
import { COLORS, PRIORITY_COLORS, PRIORITY_LABELS, STATUS_COLORS } from "./constants.ts";

type VChild = ReturnType<typeof Box> | ReturnType<typeof Text> | null;

export function createIssueNotFoundOverlay(issueId: string): ReturnType<typeof Box> {
  return Box(
    {
      id: "issue-detail-overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: COLORS.bgOverlay,
      justifyContent: "center",
      alignItems: "center",
      zIndex: 100,
    },
    Box(
      {
        borderStyle: "rounded",
        borderColor: COLORS.red,
        backgroundColor: COLORS.surface,
        padding: 2,
        flexDirection: "column",
        gap: 1,
        width: "50%",
        maxHeight: "50%",
      },
      Text({ content: `Issue not found: ${issueId}`, fg: COLORS.red }),
      Text({ content: "Press Esc to close", fg: COLORS.textDim }),
    ),
  );
}

export function createIssueDetailOverlay(
  issue: IssueDetail,
  comments: IssueComment[],
): ReturnType<typeof Box> {
  const children: VChild[] = [];

  children.push(buildHeader(issue));
  children.push(buildMetadata(issue));
  children.push(buildDivider());

  if (issue.description) {
    children.push(Text({ content: " Description", fg: COLORS.accent, attributes: 1 }));
    children.push(buildDescription(issue.description));
  }

  if (issue.pr_url) {
    children.push(buildDivider());
    children.push(buildPrLink(issue.pr_url));
  }

  if (comments.length > 0) {
    children.push(buildDivider());
    children.push(
      Text({
        content: ` Comments (${comments.length})`,
        fg: COLORS.accent,
        attributes: 1,
      }),
    );

    for (const comment of comments) {
      children.push(buildComment(comment));
    }
  }

  if (issue.dependencies.length > 0) {
    children.push(buildDivider());
    children.push(
      Text({
        content: ` Dependencies (${issue.dependencies.length})`,
        fg: COLORS.accent,
        attributes: 1,
      }),
    );

    for (const dependency of issue.dependencies) {
      children.push(buildDependency(dependency));
    }
  }

  const hasPrLink = Boolean(issue.pr_url);
  const footerText = hasPrLink
    ? " Esc close  \u2191\u2193/jk scroll  Ctrl-u/d half-page  g/G top/bottom  o open PR  y copy PR"
    : canOpenPr(issue.status)
      ? " Esc close  \u2191\u2193/jk scroll  Ctrl-u/d half-page  g/G top/bottom  no PR link found"
      : " Esc close  \u2191\u2193/jk scroll  Ctrl-u/d half-page  g/G top/bottom";

  const validChildren = children.filter((child): child is NonNullable<VChild> => child !== null);

  return Box(
    {
      id: "issue-detail-overlay",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      backgroundColor: COLORS.bgOverlay,
      justifyContent: "center",
      alignItems: "center",
      zIndex: 100,
    },
    Box(
      {
        borderStyle: "rounded",
        border: true,
        borderColor: COLORS.border,
        backgroundColor: COLORS.bg,
        width: "80%",
        height: "85%",
        maxWidth: 100,
        flexDirection: "column",
      },
      ScrollBox(
        {
          id: "issue-detail-scrollbox",
          backgroundColor: COLORS.bg,
          padding: 1,
          paddingX: 2,
          flexGrow: 1,
          stickyStart: "top",
          focusable: true,
          contentOptions: {
            flexDirection: "column",
            gap: 1,
          },
        },
        ...validChildren,
      ),
      Box(
        {
          border: ["top"],
          borderColor: COLORS.bg,
          paddingTop: 1,
          paddingLeft: 2,
          paddingRight: 2,
          paddingBottom: 1,
        },
        Text({ content: footerText, fg: COLORS.textDim, wrapMode: "none" }),
      ),
    ),
  );
}

function buildHeader(issue: IssueDetail): VChild {
  return Box(
    { flexDirection: "column", gap: 0 },
    Text({ content: ` ${issue.id}`, fg: COLORS.textDim }),
    Text({ content: ` ${issue.title}`, fg: COLORS.text, attributes: 1 }),
  );
}

function buildMetadata(issue: IssueDetail): VChild {
  const statusColor = STATUS_COLORS[issue.status] ?? COLORS.text;
  const priorityColor =
    issue.priority !== null ? (PRIORITY_COLORS[issue.priority] ?? COLORS.text) : COLORS.textDim;
  const priorityLabel =
    issue.priority !== null ? (PRIORITY_LABELS[issue.priority] ?? `P${issue.priority}`) : "\u2014";

  return Box(
    { flexDirection: "row", gap: 2, paddingLeft: 1 },
    Box(
      { flexDirection: "row", gap: 1 },
      Text({ content: "\u25CF", fg: statusColor }),
      Text({ content: issue.status, fg: statusColor }),
    ),
    Text({ content: priorityLabel, fg: priorityColor }),
    Text({ content: issue.issue_type, fg: COLORS.magenta }),
    issue.owner ? Text({ content: issue.owner, fg: COLORS.textDim }) : Text({ content: "" }),
  );
}

function buildDescription(description: string): VChild {
  return Box(
    { paddingLeft: 1, paddingRight: 1, flexDirection: "column" },
    Text({ content: description, fg: COLORS.text, wrapMode: "word" }),
  );
}

function buildDivider(): VChild {
  return Text({
    content: "\u2500".repeat(300),
    fg: COLORS.border,
    wrapMode: "none",
  });
}

function buildPrLink(url: string): VChild {
  return Box(
    { flexDirection: "row", gap: 1, paddingLeft: 1 },
    Text({ content: " PR:", fg: COLORS.accent, attributes: 1 }),
    Text({ content: url, fg: COLORS.cyan }),
  );
}

function buildComment(comment: IssueComment): VChild {
  const timestamp = comment.created_at ? formatTimestamp(comment.created_at) : "";

  return Box(
    { flexDirection: "column", gap: 0, paddingLeft: 1, paddingBottom: 1 },
    Box(
      { flexDirection: "row", gap: 1 },
      Text({ content: comment.author, fg: COLORS.cyan, attributes: 1 }),
      Text({ content: timestamp, fg: COLORS.textDim }),
    ),
    Box({ paddingLeft: 1 }, Text({ content: comment.body, fg: COLORS.text, wrapMode: "word" })),
  );
}

function buildDependency(dep: {
  id: string;
  title: string;
  status: string;
  dependency_type: string;
}): VChild {
  const statusColor = STATUS_COLORS[dep.status] ?? COLORS.textDim;
  const typeLabel = dep.dependency_type === "blocks" ? "\u2298 blocks" : dep.dependency_type;

  return Box(
    {
      flexDirection: "column",
      gap: 0,
      paddingLeft: 1,
      paddingBottom: 1,
    },
    Box(
      { flexDirection: "row", gap: 1, paddingLeft: 1 },
      Text({ content: "\u25CF", fg: statusColor }),
      Text({ content: dep.status, fg: statusColor }),
      Text({ content: dep.id, fg: COLORS.accent }),
      Text({ content: `(${typeLabel})`, fg: COLORS.textDim }),
    ),
    Box(
      {
        flexDirection: "column",
        paddingLeft: 3,
        paddingRight: 1,
      },
      Text({ content: dep.title, fg: COLORS.text, wrapMode: "word" }),
    ),
  );
}

export function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;

    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}
