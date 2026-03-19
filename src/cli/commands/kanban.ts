export async function runKanbanCommand(): Promise<void> {
  const { launchKanban } = await import("../../tui/app.tsx");
  await launchKanban();
}
