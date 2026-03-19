// ---------------------------------------------------------------------------
// TUI Kanban Board — issue management view using OpenTUI React
//
// Five-column kanban layout (Open, In Progress, Review, Closed, Deferred).
// Arrow keys or vim keys (h/j/k/l) navigate cards, Enter for details,
// mouse click selects columns/cards, / searches/filter cards,
// m/M moves status, b sends to backlog (deferred),
// B promotes from backlog to open, s sorts current column,
// n opens issue-creation guidance, d closes/deletes,
// o opens PR and y copies PR link for review/closed issues when available.
//
// ---------------------------------------------------------------------------

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { copyTextToClipboard, openExternalUrl } from "./external-actions.ts";
import { fetchIssueDetail } from "./issue-data.ts";
import { IssueDetailOverlay } from "./issue-detail-overlay.ts";
import { Footer, Header, KanbanColumn } from "./kanban-components.tsx";
import {
  bucketIssues,
  COLORS,
  COLUMNS,
  type ColumnSortMode,
  type CursorPos,
  clampCursor,
  closeIssue,
  fetchAllIssues,
  filterIssues,
  type Issue,
  makeColumnScrollboxId,
  makeIssueCardId,
  moveIssueStatus,
  POLL_INTERVAL_MS,
  type ScrollBoxRenderableAPI,
  STATUS_ORDER,
} from "./kanban-core.ts";
import { handleKanbanKey } from "./kanban-keymap.ts";
import { NewIssueDialog } from "./new-issue-dialog.ts";
import { canOpenPr } from "./pr-link-resolver.ts";

// -- Main App ----------------------------------------------------------------

function KanbanApp({ renderer }: { renderer: Awaited<ReturnType<typeof createCliRenderer>> }) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [cursor, setCursor] = useState<CursorPos>({ col: 0, row: 0 });
  const [statusMsg, setStatusMsg] = useState("loading…");
  const [columnSortModes, setColumnSortModes] = useState<Record<string, ColumnSortMode>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const overlayRef = useRef(false);

  const filteredIssues = filterIssues(issues, searchQuery);
  const buckets = bucketIssues(filteredIssues, columnSortModes);

  // -- Data refresh ----------------------------------------------------------

  const refresh = useCallback(async () => {
    const allIssues = await fetchAllIssues();
    setIssues(allIssues);
    setStatusMsg("");
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  // Clamp cursor when issues change
  useEffect(() => {
    setCursor((prev) => clampCursor(prev, buckets));
  }, [buckets]);

  // Keep selected card in view when navigating with keyboard/mouse.
  useEffect(() => {
    const col = COLUMNS[cursor.col];
    if (!col) return;

    const items = buckets.get(col.key) ?? [];
    const selectedIssue = items[cursor.row];
    if (!selectedIssue) return;

    const scrollbox = renderer.root.getRenderable(makeColumnScrollboxId(col.key));
    if (!scrollbox) return;

    const maybeScrollbox = scrollbox as unknown as {
      scrollChildIntoView?: (childId: string) => void;
    };
    maybeScrollbox.scrollChildIntoView?.(makeIssueCardId(selectedIssue.id));
  }, [buckets, cursor, renderer]);

  // -- Helpers ---------------------------------------------------------------

  const getSelectedIssue = useCallback((): Issue | null => {
    const colKey = COLUMNS[cursor.col]?.key;
    if (!colKey) return null;
    const items = buckets.get(colKey) ?? [];
    return items[cursor.row] ?? null;
  }, [cursor, buckets]);

  const handleSelectColumn = useCallback(
    (colIdx: number) => {
      setCursor((prev) => {
        const colKey = COLUMNS[colIdx]?.key;
        if (!colKey) return prev;
        const items = buckets.get(colKey) ?? [];
        const row = items.length > 0 ? Math.min(prev.row, items.length - 1) : 0;
        return { col: colIdx, row };
      });
    },
    [buckets],
  );

  const handleSelectCard = useCallback(
    (colIdx: number, rowIdx: number) => {
      setCursor((prev) => {
        const colKey = COLUMNS[colIdx]?.key;
        if (!colKey) return prev;
        const items = buckets.get(colKey) ?? [];
        const row = items.length > 0 ? Math.max(0, Math.min(rowIdx, items.length - 1)) : 0;
        return { col: colIdx, row };
      });
    },
    [buckets],
  );

  // -- Actions ---------------------------------------------------------------

  const handleMoveForward = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    const currentIdx = STATUS_ORDER.indexOf(issue.status);
    if (currentIdx < 0 || currentIdx >= STATUS_ORDER.length - 1) {
      setStatusMsg("already at last status");
      return;
    }
    const nextStatus = STATUS_ORDER[currentIdx + 1]!;
    setStatusMsg(`moving ${issue.id} to ${nextStatus}…`);
    const ok = await moveIssueStatus(issue.id, nextStatus);
    if (ok) {
      setStatusMsg(`moved ${issue.id} to ${nextStatus}`);
      await refresh();
    } else {
      setStatusMsg(`failed to move ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handleMoveBackward = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    const currentIdx = STATUS_ORDER.indexOf(issue.status);
    if (currentIdx <= 0) {
      setStatusMsg("already at first status");
      return;
    }
    const prevStatus = STATUS_ORDER[currentIdx - 1]!;
    setStatusMsg(`moving ${issue.id} to ${prevStatus}…`);
    const ok = await moveIssueStatus(issue.id, prevStatus);
    if (ok) {
      setStatusMsg(`moved ${issue.id} to ${prevStatus}`);
      await refresh();
    } else {
      setStatusMsg(`failed to move ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handleClose = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    setStatusMsg(`closing ${issue.id}…`);
    const ok = await closeIssue(issue.id);
    if (ok) {
      setStatusMsg(`closed ${issue.id}`);
      await refresh();
    } else {
      setStatusMsg(`failed to close ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handleSendToBacklog = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    if (issue.status === "deferred") {
      setStatusMsg(`${issue.id} is already deferred`);
      return;
    }
    setStatusMsg(`deferring ${issue.id}…`);
    const ok = await moveIssueStatus(issue.id, "deferred");
    if (ok) {
      setStatusMsg(`deferred ${issue.id}`);
      await refresh();
    } else {
      setStatusMsg(`failed to defer ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handlePromoteFromBacklog = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    if (issue.status !== "deferred") {
      setStatusMsg(`${issue.id} is not deferred`);
      return;
    }
    setStatusMsg(`promoting ${issue.id} to open…`);
    const ok = await moveIssueStatus(issue.id, "open");
    if (ok) {
      setStatusMsg(`promoted ${issue.id} to open`);
      await refresh();
    } else {
      setStatusMsg(`failed to promote ${issue.id}`);
    }
  }, [getSelectedIssue, refresh]);

  const handleShowDetail = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;
    overlayRef.current = true;
    const overlay = new IssueDetailOverlay(renderer);
    overlay.onClose(() => {
      overlayRef.current = false;
    });
    await overlay.show(issue.id);
  }, [getSelectedIssue, renderer]);

  const handleOpenPr = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;

    if (!canOpenPr(issue.status)) {
      setStatusMsg("PR open is available in review/closed");
      return;
    }

    setStatusMsg(`loading PR for ${issue.id}…`);
    const detail = await fetchIssueDetail(issue.id);
    const prUrl = detail?.pr_url;

    if (!prUrl) {
      setStatusMsg(`no PR found for ${issue.id}`);
      return;
    }

    setStatusMsg(`opening PR for ${issue.id}…`);
    const opened = await openExternalUrl(prUrl);

    if (opened) {
      setStatusMsg(`opened PR for ${issue.id}`);
    } else {
      setStatusMsg(`failed to open PR for ${issue.id}`);
    }
  }, [getSelectedIssue]);

  const handleCopyPrLink = useCallback(async () => {
    const issue = getSelectedIssue();
    if (!issue) return;

    if (!canOpenPr(issue.status)) {
      setStatusMsg("PR copy is available in review/closed");
      return;
    }

    setStatusMsg(`loading PR for ${issue.id}…`);
    const detail = await fetchIssueDetail(issue.id);
    const prUrl = detail?.pr_url;

    if (!prUrl) {
      setStatusMsg(`no PR found for ${issue.id}`);
      return;
    }

    setStatusMsg(`copying PR for ${issue.id}…`);
    const copied = await copyTextToClipboard(prUrl);

    if (copied) {
      setStatusMsg(`copied PR for ${issue.id}`);
    } else {
      setStatusMsg(`failed to copy PR for ${issue.id}`);
    }
  }, [getSelectedIssue]);

  const handleShowCreateGuidance = useCallback(() => {
    overlayRef.current = true;
    const dialog = new NewIssueDialog(renderer);
    dialog.onClose(() => {
      overlayRef.current = false;
    });
    dialog.show();
  }, [renderer]);

  const getActiveColumnScrollbox = useCallback((): ScrollBoxRenderableAPI | null => {
    const col = COLUMNS[cursor.col];
    if (!col) return null;
    return (
      (renderer.root.getRenderable(makeColumnScrollboxId(col.key)) as
        | ScrollBoxRenderableAPI
        | null
        | undefined) ?? null
    );
  }, [cursor.col, renderer]);

  const moveActiveColumnRows = useCallback(
    (rowDelta: number): void => {
      setCursor((prev) => {
        const colKey = COLUMNS[prev.col]?.key;
        if (!colKey) return prev;

        const items = buckets.get(colKey) ?? [];
        if (items.length === 0) {
          return { ...prev, row: 0 };
        }

        const scrollbox = getActiveColumnScrollbox();
        const viewportHeight = scrollbox?.viewport?.height ?? items.length;
        const halfPage = Math.max(1, Math.floor(viewportHeight / 2));
        const nextRow = Math.max(0, Math.min(prev.row + rowDelta * halfPage, items.length - 1));

        return { ...prev, row: nextRow };
      });
    },
    [buckets, getActiveColumnScrollbox],
  );

  const moveActiveColumnToRow = useCallback(
    (row: number): void => {
      setCursor((prev) => {
        const colKey = COLUMNS[prev.col]?.key;
        if (!colKey) return prev;

        const items = buckets.get(colKey) ?? [];
        if (items.length === 0) {
          return { ...prev, row: 0 };
        }

        const clamped = Math.max(0, Math.min(row, items.length - 1));
        return { ...prev, row: clamped };
      });
    },
    [buckets],
  );

  const handleToggleSort = useCallback((): void => {
    const col = COLUMNS[cursor.col];
    if (!col) return;

    const currentMode = columnSortModes[col.key] ?? "default";
    const nextMode: ColumnSortMode = currentMode === "default" ? "priority" : "default";

    setColumnSortModes((prev) => ({ ...prev, [col.key]: nextMode }));

    if (nextMode === "priority") {
      setStatusMsg(`${col.label} sorted by priority (P0 to P4)`);
    } else if (col.key === "closed") {
      setStatusMsg("Closed sorted by newest to oldest");
    } else {
      setStatusMsg(`${col.label} using default order`);
    }
  }, [columnSortModes, cursor.col]);

  const handleMoveLeft = useCallback((): void => {
    setCursor((prev) => {
      const newCol = Math.max(0, prev.col - 1);
      const colKey = COLUMNS[newCol]!.key;
      const items = buckets.get(colKey) ?? [];
      const row = items.length > 0 ? Math.min(prev.row, items.length - 1) : 0;
      return { col: newCol, row };
    });
  }, [buckets]);

  const handleMoveRight = useCallback((): void => {
    setCursor((prev) => {
      const newCol = Math.min(COLUMNS.length - 1, prev.col + 1);
      const colKey = COLUMNS[newCol]!.key;
      const items = buckets.get(colKey) ?? [];
      const row = items.length > 0 ? Math.min(prev.row, items.length - 1) : 0;
      return { col: newCol, row };
    });
  }, [buckets]);

  const handleMoveUp = useCallback((): void => {
    setCursor((prev) => ({
      ...prev,
      row: Math.max(0, prev.row - 1),
    }));
  }, []);

  const handleMoveDown = useCallback((): void => {
    setCursor((prev) => {
      const colKey = COLUMNS[prev.col]!.key;
      const items = buckets.get(colKey) ?? [];
      return {
        ...prev,
        row: Math.min(items.length - 1, prev.row + 1),
      };
    });
  }, [buckets]);

  const handleQuit = useCallback((): void => {
    renderer.destroy();
    process.exit(0);
  }, [renderer]);

  // -- Keyboard --------------------------------------------------------------

  useKeyboard((key) => {
    // Don't handle keys when an overlay is active
    if (overlayRef.current) return;

    handleKanbanKey(
      key,
      { searchMode, searchQuery },
      {
        quit: handleQuit,
        refresh: () => {
          setStatusMsg("refreshing…");
          void refresh();
        },
        enterSearchMode: () => {
          setSearchMode(true);
          setSearchQuery("");
          setStatusMsg("");
        },
        exitSearchMode: () => {
          setSearchMode(false);
        },
        clearSearch: () => {
          setSearchQuery("");
          setStatusMsg("search cleared");
        },
        searchBackspace: () => {
          setSearchQuery((prev) => prev.slice(0, -1));
        },
        searchAppend: (text) => {
          setSearchQuery((prev) => `${prev}${text}`);
        },
        toggleSort: handleToggleSort,
        moveLeft: handleMoveLeft,
        moveRight: handleMoveRight,
        moveUp: handleMoveUp,
        moveDown: handleMoveDown,
        jumpToTop: () => {
          moveActiveColumnToRow(0);
        },
        jumpToBottom: () => {
          moveActiveColumnToRow(Number.POSITIVE_INFINITY);
        },
        halfPageUp: () => {
          moveActiveColumnRows(-1);
        },
        halfPageDown: () => {
          moveActiveColumnRows(1);
        },
        closeIssue: handleClose,
        showDetail: handleShowDetail,
        moveForward: handleMoveForward,
        moveBackward: handleMoveBackward,
        sendToBacklog: handleSendToBacklog,
        promoteFromBacklog: handlePromoteFromBacklog,
        openPr: handleOpenPr,
        copyPr: handleCopyPrLink,
        showCreateGuidance: handleShowCreateGuidance,
      },
    );
  });

  const headerStatus = searchMode
    ? `search: ${searchQuery}`
    : statusMsg ||
      (searchQuery.trim()
        ? `filter: ${searchQuery} (${filteredIssues.length}/${issues.length})`
        : "");

  // -- Render ----------------------------------------------------------------

  return (
    <box
      style={{
        flexDirection: "column",
        flexGrow: 1,
        backgroundColor: COLORS.bg,
      }}
    >
      <Header issueCount={filteredIssues.length} status={headerStatus} />

      {/* Kanban columns */}
      <box
        style={{
          flexDirection: "row",
          flexGrow: 1,
          gap: 0,
        }}
      >
        {COLUMNS.map((col, colIdx) => {
          const items = buckets.get(col.key) ?? [];
          return (
            <KanbanColumn
              key={col.key}
              label={col.label}
              color={col.color}
              issues={items}
              selectedRow={cursor.row}
              isActiveColumn={cursor.col === colIdx}
              columnKey={col.key}
              onSelectColumn={() => handleSelectColumn(colIdx)}
              onSelectCard={(row) => handleSelectCard(colIdx, row)}
            />
          );
        })}
      </box>

      <Footer />
    </box>
  );
}

// -- Entry point -------------------------------------------------------------

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
