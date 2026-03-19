export const COLORS = {
  bg: "#1a1b26",
  bgOverlay: "#000000",
  surface: "#24283b",
  border: "#414868",
  text: "#c0caf5",
  textDim: "#565f89",
  accent: "#7aa2f7",
  green: "#9ece6a",
  yellow: "#e0af68",
  red: "#f7768e",
  cyan: "#7dcfff",
  magenta: "#bb9af7",
} as const;

export const PRIORITY_COLORS: Record<number, string> = {
  0: COLORS.red,
  1: COLORS.yellow,
  2: COLORS.accent,
  3: COLORS.textDim,
  4: COLORS.textDim,
};

export const PRIORITY_LABELS: Record<number, string> = {
  0: "P0 Critical",
  1: "P1 High",
  2: "P2 Medium",
  3: "P3 Low",
  4: "P4 Backlog",
};

export const STATUS_COLORS: Record<string, string> = {
  open: COLORS.green,
  in_progress: COLORS.cyan,
  review: COLORS.yellow,
  closed: COLORS.textDim,
  done: COLORS.textDim,
};
