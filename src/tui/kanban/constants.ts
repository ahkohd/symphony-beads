export const COLUMNS = [
  { key: "open", label: "Open", color: "#9ece6a" },
  { key: "in_progress", label: "In Progress", color: "#7dcfff" },
  { key: "review", label: "Review", color: "#e0af68" },
  { key: "closed", label: "Closed", color: "#565f89" },
  { key: "deferred", label: "Deferred", color: "#bb9af7" },
] as const;

export const STATUS_ORDER: string[] = COLUMNS.map((column) => column.key);

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
