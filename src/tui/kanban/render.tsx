import { COLORS, PRIORITY_BADGE } from "./constants.ts";
import { makeColumnScrollboxId, makeIssueCardId } from "./state.ts";
import type { Issue } from "./types.ts";

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function Header({ issueCount, status }: { issueCount: number; status: string }) {
  const statsStr = "";

  return (
    <box
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
        backgroundColor: COLORS.headerBg,
      }}
    >
      <text>
        <strong fg={COLORS.accent}>Symphony</strong>
        <span fg={COLORS.textDim}> Kanban</span>
        <span fg={COLORS.textDim}> — {issueCount} issues</span>
        <span fg={COLORS.textDim}>{statsStr}</span>
      </text>
      <text>{status ? <span fg={COLORS.yellow}> {status}</span> : null}</text>
    </box>
  );
}

function PriorityBadge({ priority }: { priority: number | null }) {
  if (priority === null) return <span fg={COLORS.textDim}>--</span>;

  const badge = PRIORITY_BADGE[priority] ?? {
    label: `P${priority}`,
    color: COLORS.textDim,
  };

  return <span fg={badge.color}>{badge.label}</span>;
}

function IssueCard({
  issue,
  isSelected,
  onSelect,
  cardId,
}: {
  issue: Issue;
  isSelected: boolean;
  onSelect: () => void;
  cardId: string;
}) {
  const borderColor = isSelected ? COLORS.borderHighlight : COLORS.border;
  const backgroundColor = isSelected ? COLORS.surface : COLORS.bg;
  const assignee = issue.owner ? truncate(issue.owner.replace(/^agent@/, "@"), 16) : "";

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI box supports mouse handlers.
    <box
      id={cardId}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect();
      }}
      style={{
        flexDirection: "column",
        borderStyle: "rounded",
        border: true,
        borderColor,
        backgroundColor,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
    >
      <box
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          height: 1,
        }}
      >
        <text>
          <span fg={COLORS.cyan}>{issue.id}</span>
        </text>
        <text>
          <PriorityBadge priority={issue.priority} />
        </text>
      </box>
      <text fg={COLORS.text}>{issue.title}</text>

      {assignee ? <text fg={COLORS.textDim}>{assignee}</text> : <text fg={COLORS.textDim}>—</text>}
    </box>
  );
}

export function KanbanColumn({
  label,
  color,
  issues,
  selectedRow,
  isActiveColumn,
  columnKey,
  onSelectColumn,
  onSelectCard,
}: {
  label: string;
  color: string;
  issues: Issue[];
  selectedRow: number;
  isActiveColumn: boolean;
  columnKey: string;
  onSelectColumn: () => void;
  onSelectCard: (row: number) => void;
}) {
  const headerBorderColor = isActiveColumn ? color : COLORS.border;
  const scrollboxId = makeColumnScrollboxId(columnKey);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI box supports mouse handlers.
    <box
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        onSelectColumn();
      }}
      style={{
        flexDirection: "column",
        flexGrow: 1,
        flexBasis: 0,
        borderStyle: "single",
        border: true,
        borderColor: headerBorderColor,
        backgroundColor: COLORS.bg,
      }}
    >
      <box
        style={{
          height: 1,
          paddingLeft: 1,
          backgroundColor: isActiveColumn ? COLORS.surface : COLORS.bg,
        }}
      >
        <text>
          <span fg={color}>
            <strong>{label}</strong>
          </span>
          <span fg={COLORS.textDim}> ({issues.length})</span>
        </text>
      </box>

      <scrollbox
        id={scrollboxId}
        style={{
          rootOptions: { flexGrow: 1, backgroundColor: COLORS.bg },
          contentOptions: {
            flexDirection: "column",
            gap: 0,
            backgroundColor: COLORS.bg,
          },
        }}
      >
        {issues.length === 0 ? (
          <box style={{ paddingLeft: 1, height: 1 }}>
            <text fg={COLORS.textDim}>empty</text>
          </box>
        ) : (
          issues.map((issue, idx) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              isSelected={isActiveColumn && idx === selectedRow}
              onSelect={() => onSelectCard(idx)}
              cardId={makeIssueCardId(issue.id)}
            />
          ))
        )}
      </scrollbox>
    </box>
  );
}

export function Footer() {
  return (
    <box
      style={{
        flexDirection: "row",
        justifyContent: "space-between",
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
        backgroundColor: COLORS.headerBg,
      }}
    >
      <text>
        <span fg={COLORS.textDim}>←→ / h l</span>
        <span fg={COLORS.text}> col </span>
        <span fg={COLORS.textDim}>↑↓ / j k</span>
        <span fg={COLORS.text}> card </span>
        <span fg={COLORS.textDim}>g / G</span>
        <span fg={COLORS.text}> jump </span>
        <span fg={COLORS.textDim}>Ctrl-u/d</span>
        <span fg={COLORS.text}> half page </span>
        <span fg={COLORS.textDim}>click</span>
        <span fg={COLORS.text}> select </span>
        <span fg={COLORS.textDim}>Enter</span>
        <span fg={COLORS.text}> detail </span>
        <span fg={COLORS.textDim}>m/M</span>
        <span fg={COLORS.text}> move </span>
        <span fg={COLORS.textDim}>b/B</span>
        <span fg={COLORS.text}> defer/promote </span>
        <span fg={COLORS.textDim}>/</span>
        <span fg={COLORS.text}> search </span>
        <span fg={COLORS.textDim}>n</span>
        <span fg={COLORS.text}> create via agent </span>
        <span fg={COLORS.textDim}>s</span>
        <span fg={COLORS.text}> sort col </span>
        <span fg={COLORS.textDim}>d</span>
        <span fg={COLORS.text}> close </span>
        <span fg={COLORS.textDim}>o</span>
        <span fg={COLORS.text}> open PR (review/closed) </span>
        <span fg={COLORS.textDim}>y</span>
        <span fg={COLORS.text}> copy PR link </span>
        <span fg={COLORS.textDim}>r</span>
        <span fg={COLORS.text}> refresh </span>
        <span fg={COLORS.textDim}>q</span>
        <span fg={COLORS.text}> quit</span>
      </text>
    </box>
  );
}
