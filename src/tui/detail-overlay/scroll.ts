import type { Renderable } from "@opentui/core";

export type DetailScrollbox = {
  scrollBy?: (
    delta: number | { x: number; y: number },
    unit?: "absolute" | "viewport" | "content" | "step",
  ) => void;
  scrollTo?: (position: number | { x: number; y: number }) => void;
  scrollHeight?: number;
  viewport?: { height: number };
};

export function getDetailScrollbox(
  root: Renderable,
  overlayRoot: Renderable | null,
): DetailScrollbox | null {
  const byRoot = root.getRenderable?.("issue-detail-scrollbox");
  const byOverlay = overlayRoot?.getRenderable?.("issue-detail-scrollbox");
  const byDescendant = overlayRoot?.findDescendantById?.("issue-detail-scrollbox");

  const scrollbox = byRoot ?? byOverlay ?? byDescendant ?? null;
  return (scrollbox as DetailScrollbox | null | undefined) ?? null;
}

export function scrollDetail(scrollbox: DetailScrollbox | null, delta: number): void {
  scrollbox?.scrollBy?.(delta, "step");
}

export function scrollHalfPage(scrollbox: DetailScrollbox | null, direction: 1 | -1): void {
  if (!scrollbox?.scrollBy) return;

  const viewportHeight = scrollbox.viewport?.height ?? 0;
  const delta = Math.max(1, Math.floor(viewportHeight / 2));
  scrollbox.scrollBy(direction * delta, "step");
}

export function scrollToTop(scrollbox: DetailScrollbox | null): void {
  scrollbox?.scrollTo?.(0);
}

export function scrollToBottom(scrollbox: DetailScrollbox | null): void {
  if (!scrollbox?.scrollTo || !scrollbox.viewport) return;

  const viewportHeight = scrollbox.viewport.height;
  const scrollHeight = scrollbox.scrollHeight ?? 0;
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  scrollbox.scrollTo(maxScrollTop);
}
