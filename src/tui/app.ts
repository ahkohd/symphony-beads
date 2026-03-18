// ---------------------------------------------------------------------------
// TUI App — main entry point for `symphony tui`
//
// Creates the CliRenderer and launches the kanban board view.
// ---------------------------------------------------------------------------

import { createCliRenderer } from "@opentui/core";
import { KanbanBoard } from "./kanban.ts";

export async function startTui(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useAlternateScreen: true,
    useMouse: false,
    targetFps: 30,
  });

  const kanban = new KanbanBoard(renderer);
  await kanban.start();
  renderer.start();
}
