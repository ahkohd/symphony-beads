// ---------------------------------------------------------------------------
// Symphony TUI — Main entry point
//
// Scaffolds the terminal UI using @opentui/core:
//   - Header bar with title and timestamp
//   - Tab bar switching between Dashboard and Kanban views
//   - Main content area (placeholder per tab)
//   - Footer with keybinding hints
//   - q to quit, r to refresh, 1/2 to switch views
// ---------------------------------------------------------------------------

import {
  createCliRenderer,
  Box,
  Text,
  TabSelect,
  TabSelectRenderableEvents,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";

// -- Types -------------------------------------------------------------------

type ViewName = "dashboard" | "kanban";

interface TuiState {
  activeView: ViewName;
  lastRefresh: Date;
}

// -- Constants ---------------------------------------------------------------

const VERSION = "0.1.0";

const TABS = [
  { name: "Dashboard", description: "Issue overview and agent status", value: "dashboard" },
  { name: "Kanban", description: "Board view of issues by status", value: "kanban" },
];

const HEADER_BG = "#1a1a2e";
const HEADER_FG = "#e0e0e0";
const ACCENT = "#4fc3f7";
const FOOTER_BG = "#1a1a2e";
const FOOTER_FG = "#888888";
const CONTENT_BG = "#0f0f1a";

// -- Main entry --------------------------------------------------------------

export async function startTui(): Promise<void> {
  const state: TuiState = {
    activeView: "dashboard",
    lastRefresh: new Date(),
  };

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useAlternateScreen: true,
  });

  // -- Header ----------------------------------------------------------------
  const header = Box(
    {
      id: "header",
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: HEADER_BG,
      justifyContent: "space-between",
      paddingLeft: 1,
      paddingRight: 1,
    },
    Text({ id: "header-title", content: `♫ Symphony Beads v${VERSION}`, fg: ACCENT }),
    Text({ id: "header-time", content: formatTime(state.lastRefresh), fg: FOOTER_FG }),
  );

  // -- Tab bar ---------------------------------------------------------------
  const tabBar = TabSelect({
    id: "tab-bar",
    width: "100%",
    options: TABS,
    tabWidth: 20,
    showDescription: false,
    showUnderline: true,
    backgroundColor: HEADER_BG,
    textColor: FOOTER_FG,
    selectedBackgroundColor: CONTENT_BG,
    selectedTextColor: ACCENT,
    focusedBackgroundColor: CONTENT_BG,
    focusedTextColor: ACCENT,
    wrapSelection: true,
  });

  // -- Content area ----------------------------------------------------------
  const contentArea = Box(
    {
      id: "content-area",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      backgroundColor: CONTENT_BG,
      padding: 1,
    },
    Text({
      id: "content-text",
      content: getPlaceholderContent(state.activeView),
      fg: HEADER_FG,
    }),
  );

  // -- Footer ----------------------------------------------------------------
  const footer = Box(
    {
      id: "footer",
      width: "100%",
      height: 1,
      flexDirection: "row",
      backgroundColor: FOOTER_BG,
      paddingLeft: 1,
      paddingRight: 1,
      gap: 2,
    },
    Text({ id: "footer-quit", content: " q quit ", fg: FOOTER_BG, bg: "#555555" }),
    Text({ id: "footer-refresh", content: " r refresh ", fg: FOOTER_BG, bg: "#555555" }),
    Text({ id: "footer-tab", content: " 1/2 switch tab ", fg: FOOTER_BG, bg: "#555555" }),
    Text({ id: "footer-nav", content: " ←/→ navigate tabs ", fg: FOOTER_BG, bg: "#555555" }),
  );

  // -- Root layout -----------------------------------------------------------
  renderer.root.add(
    Box(
      {
        id: "root-layout",
        width: "100%",
        height: "100%",
        flexDirection: "column",
        backgroundColor: CONTENT_BG,
      },
      header,
      tabBar,
      contentArea,
      footer,
    ),
  );

  // -- Focus tab bar for keyboard nav ----------------------------------------
  tabBar.focus();

  // -- Tab change handler ----------------------------------------------------
  function switchView(view: ViewName): void {
    state.activeView = view;
    const contentText = renderer.root.findDescendantById("content-text");
    if (contentText) {
      (contentText as any).content = getPlaceholderContent(view);
    }
  }

  // Listen for tab selection events via the renderable instance
  const tabBarRenderable = renderer.root.findDescendantById("tab-bar");
  if (tabBarRenderable) {
    tabBarRenderable.on(TabSelectRenderableEvents.SELECTION_CHANGED, (index: number) => {
      const tab = TABS[index];
      if (tab) switchView(tab.value as ViewName);
    });
    tabBarRenderable.on(TabSelectRenderableEvents.ITEM_SELECTED, (index: number) => {
      const tab = TABS[index];
      if (tab) switchView(tab.value as ViewName);
    });
  }

  // -- Keyboard handler ------------------------------------------------------
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    // q to quit
    if (key.name === "q" && !key.ctrl && !key.meta) {
      renderer.destroy();
      process.exit(0);
    }

    // Ctrl+C to quit
    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      process.exit(0);
    }

    // r to refresh
    if (key.name === "r" && !key.ctrl && !key.meta) {
      doRefresh(renderer, state);
    }

    // 1/2 for direct tab switch
    if (key.name === "1") {
      setTabIndex(renderer, 0);
      switchView("dashboard");
    }
    if (key.name === "2") {
      setTabIndex(renderer, 1);
      switchView("kanban");
    }
  });

  // -- Initial render --------------------------------------------------------
  doRefresh(renderer, state);
}

// -- Helpers -----------------------------------------------------------------

function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour12: false });
}

function getPlaceholderContent(view: ViewName): string {
  switch (view) {
    case "dashboard":
      return [
        "╭─ Dashboard ──────────────────────────────────────╮",
        "│                                                  │",
        "│  Issue overview and agent status will appear here │",
        "│                                                  │",
        "│  (placeholder — coming in future issues)         │",
        "│                                                  │",
        "╰──────────────────────────────────────────────────╯",
      ].join("\n");
    case "kanban":
      return [
        "╭─ Kanban Board ───────────────────────────────────╮",
        "│                                                  │",
        "│  Board view of issues by status will appear here │",
        "│                                                  │",
        "│  (placeholder — coming in future issues)         │",
        "│                                                  │",
        "╰──────────────────────────────────────────────────╯",
      ].join("\n");
  }
}

function doRefresh(renderer: CliRenderer, state: TuiState): void {
  state.lastRefresh = new Date();
  const timeText = renderer.root.findDescendantById("header-time");
  if (timeText) {
    (timeText as any).content = formatTime(state.lastRefresh);
  }
}

function setTabIndex(renderer: CliRenderer, index: number): void {
  const tabBar = renderer.root.findDescendantById("tab-bar");
  if (tabBar && "setSelectedIndex" in tabBar) {
    (tabBar as any).setSelectedIndex(index);
  }
}
