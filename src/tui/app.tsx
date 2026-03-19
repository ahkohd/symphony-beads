// ---------------------------------------------------------------------------
// TUI Kanban Board — issue management view using OpenTUI React
// ---------------------------------------------------------------------------

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createKanbanIssueActions } from "./kanban/actions.ts";
import { COLORS, COLUMNS, POLL_INTERVAL_MS } from "./kanban/constants.ts";
import { fetchAllIssues } from "./kanban/data.ts";
import { handleKanbanKeyEvent } from "./kanban/keymap.ts";
import { Footer, Header, KanbanColumn } from "./kanban/render.tsx";
import {
  bucketIssues,
  clampCursor,
  filterIssues,
  getColumnIssues,
  makeColumnScrollboxId,
  makeIssueCardId,
  moveCursorHorizontal,
  moveCursorToRow,
  moveCursorVertical,
  selectCard,
  selectColumn,
} from "./kanban/state.ts";
import type { ColumnSortMode, CursorPos, Issue, ScrollBoxRenderableAPI } from "./kanban/types.ts";

function KanbanApp({ renderer }: { renderer: Awaited<ReturnType<typeof createCliRenderer>> }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [cursor, setCursor] = useState<CursorPos>({ col: 0, row: 0 });
  const [statusMsg, setStatusMsg] = useState("loading…");
  const [columnSortModes, setColumnSortModes] = useState<Record<string, ColumnSortMode>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const overlayRef = useRef(false);

  const filteredIssues = useMemo(() => filterIssues(issues, searchQuery), [issues, searchQuery]);

  const buckets = useMemo(
    () => bucketIssues(filteredIssues, columnSortModes),
    [filteredIssues, columnSortModes],
  );

  const refresh = useCallback(async () => {
    const allIssues = await fetchAllIssues();
    setIssues(allIssues);
    setStatusMsg("");
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    setCursor((previous) => clampCursor(previous, buckets));
  }, [buckets]);

  useEffect(() => {
    const column = COLUMNS[cursor.col];
    if (!column) return;

    const items = buckets.get(column.key) ?? [];
    const selectedIssue = items[cursor.row];
    if (!selectedIssue) return;

    const scrollbox = renderer.root.getRenderable(makeColumnScrollboxId(column.key));
    if (!scrollbox) return;

    const maybeScrollbox = scrollbox as {
      scrollChildIntoView?: (childId: string) => void;
    };
    maybeScrollbox.scrollChildIntoView?.(makeIssueCardId(selectedIssue.id));
  }, [buckets, cursor, renderer]);

  const getSelectedIssue = useCallback((): Issue | null => {
    const items = getColumnIssues(cursor.col, buckets);
    return items[cursor.row] ?? null;
  }, [cursor, buckets]);

  const handleSelectColumn = useCallback(
    (colIndex: number) => {
      setCursor((previous) => selectColumn(previous, colIndex, buckets));
    },
    [buckets],
  );

  const handleSelectCard = useCallback(
    (colIndex: number, rowIndex: number) => {
      setCursor(() => selectCard(colIndex, rowIndex, buckets));
    },
    [buckets],
  );

  const getActiveColumnScrollbox = useCallback((): ScrollBoxRenderableAPI | null => {
    const column = COLUMNS[cursor.col];
    if (!column) return null;

    const renderable = renderer.root.getRenderable(makeColumnScrollboxId(column.key));
    return (renderable as ScrollBoxRenderableAPI | null | undefined) ?? null;
  }, [cursor.col, renderer]);

  const moveActiveColumnRows = useCallback(
    (rowDelta: number): void => {
      setCursor((previous) => {
        const items = getColumnIssues(previous.col, buckets);
        if (items.length === 0) {
          return { ...previous, row: 0 };
        }

        const scrollbox = getActiveColumnScrollbox();
        const viewportHeight = scrollbox?.viewport?.height ?? items.length;
        const halfPage = Math.max(1, Math.floor(viewportHeight / 2));
        const nextRow = Math.max(0, Math.min(previous.row + rowDelta * halfPage, items.length - 1));
        return { ...previous, row: nextRow };
      });
    },
    [buckets, getActiveColumnScrollbox],
  );

  const moveActiveColumnToRow = useCallback(
    (row: number): void => {
      setCursor((previous) => moveCursorToRow(previous, row, buckets));
    },
    [buckets],
  );

  const issueActions = useMemo(
    () =>
      createKanbanIssueActions({
        renderer,
        overlayRef,
        getSelectedIssue,
        refresh,
        setStatusMsg,
      }),
    [renderer, getSelectedIssue, refresh],
  );

  const keyActions = useMemo(
    () => ({
      quit: () => {
        renderer.destroy();
        process.exit(0);
      },
      refresh: () => {
        void refresh();
      },
      setSearchMode,
      updateSearchQuery: setSearchQuery,
      clearSearch: () => setSearchQuery(""),
      setStatusMsg,
      toggleSort: () => {
        const column = COLUMNS[cursor.col];
        if (!column) return;

        const currentMode = columnSortModes[column.key] ?? "default";
        const nextMode: ColumnSortMode = currentMode === "default" ? "priority" : "default";

        setColumnSortModes((previous) => ({ ...previous, [column.key]: nextMode }));

        if (nextMode === "priority") {
          setStatusMsg(`${column.label} sorted by priority (P0 to P4)`);
        } else if (column.key === "closed") {
          setStatusMsg("Closed sorted by newest to oldest");
        } else {
          setStatusMsg(`${column.label} using default order`);
        }
      },
      moveColumnLeft: () => {
        setCursor((previous) => moveCursorHorizontal(previous, -1, buckets));
      },
      moveColumnRight: () => {
        setCursor((previous) => moveCursorHorizontal(previous, 1, buckets));
      },
      moveRowUp: () => {
        setCursor((previous) => moveCursorVertical(previous, -1, buckets));
      },
      moveRowDown: () => {
        setCursor((previous) => moveCursorVertical(previous, 1, buckets));
      },
      jumpToTop: () => {
        moveActiveColumnToRow(0);
      },
      jumpToBottom: () => {
        moveActiveColumnToRow(Number.POSITIVE_INFINITY);
      },
      moveHalfPageUp: () => {
        moveActiveColumnRows(-1);
      },
      moveHalfPageDown: () => {
        moveActiveColumnRows(1);
      },
      closeIssue: () => {
        void issueActions.closeSelectedIssue();
      },
      showDetail: () => {
        void issueActions.showDetail();
      },
      moveForward: () => {
        void issueActions.moveForward();
      },
      moveBackward: () => {
        void issueActions.moveBackward();
      },
      deferIssue: () => {
        void issueActions.sendToBacklog();
      },
      promoteIssue: () => {
        void issueActions.promoteFromBacklog();
      },
      openPr: () => {
        void issueActions.openPr();
      },
      copyPrLink: () => {
        void issueActions.copyPrLink();
      },
      showCreateGuidance: issueActions.showCreateGuidance,
    }),
    [
      renderer,
      refresh,
      cursor.col,
      columnSortModes,
      buckets,
      moveActiveColumnRows,
      moveActiveColumnToRow,
      issueActions,
    ],
  );

  useKeyboard((key) => {
    handleKanbanKeyEvent(
      key,
      {
        overlayActive: overlayRef.current,
        searchMode,
        searchQuery,
      },
      keyActions,
    );
  });

  const headerStatus = searchMode
    ? `search: ${searchQuery}`
    : statusMsg ||
      (searchQuery.trim()
        ? `filter: ${searchQuery} (${filteredIssues.length}/${issues.length})`
        : "");

  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        backgroundColor: COLORS.bg,
      }}
    >
      <Header issueCount={filteredIssues.length} status={headerStatus} />

      <box
        style={{
          flexDirection: "row",
          flexGrow: 1,
          gap: 0,
        }}
      >
        {COLUMNS.map((column, colIndex) => {
          const items = buckets.get(column.key) ?? [];
          return (
            <KanbanColumn
              key={column.key}
              label={column.label}
              color={column.color}
              issues={items}
              selectedRow={cursor.row}
              isActiveColumn={cursor.col === colIndex}
              columnKey={column.key}
              onSelectColumn={() => handleSelectColumn(colIndex)}
              onSelectCard={(row) => handleSelectCard(colIndex, row)}
            />
          );
        })}
      </box>

      <Footer />
    </box>
  );
}

export async function launchKanban(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
  });

  const cleanup = () => {
    renderer.destroy();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  createRoot(renderer).render(<KanbanApp renderer={renderer} />);
}
