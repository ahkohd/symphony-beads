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
