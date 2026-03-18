Now let me check the tests and related files to understand the full picture:
Now I have a thorough understanding of the code. Let me implement the changes:
Now update the `KanbanColumn` component to accept a `collapsed` prop:
Now add the `backlogCollapsed` state and the `b` key binding to the `KanbanApp` component:
Now add the `b` key binding in the keyboard handler:
Now update the render section to pass `collapsed` and `narrow` props to the Backlog column:
Now update the Footer to include the `b` key hint:
Now update the `dashboard.tsx` `fetchStaticCounts` to include deferred status:
Now update the static counts initialization in the DashboardApp:
Update the static summary display to include deferred count:
Now let me verify the changes look correct:
I see the color ended up as `#545c7e` - let me fix it to use a dim gray that's clearly distinct:
Now let's run the tests to verify nothing is broken:
All 314 tests pass. Let me also check the tracker.ts to see if it has any hardcoded status values that might need updating:
Good — the tracker doesn't hardcode statuses, it just normalizes. Now let me verify the final state of the changed files:
Now let me commit and push:
Everything is clean. Let me verify the final state:
All done. Here's a summary of what was implemented:

## Changes for symphony-beads-8u7: Add Backlog column to kanban board

### `src/tui/app.tsx`
1. **Added `deferred` column** to `COLUMNS` array as the first entry (before Open), with label "Backlog" and dim gray color `#565f89`
2. **Collapsible behavior**: Backlog column starts collapsed by default (`backlogCollapsed` state = `true`). When collapsed, it shows a narrow 14-char strip with just the label, count, and `▸ [b]` hint
3. **Narrower when expanded**: Uses `flexGrow: 0.6` (vs `1.0` for other columns) to take less space
4. **`b` key binding**: Toggles Backlog column collapse/expand
5. **Status transitions work**: Moving cards with `m`/`M` traverses the full status order `deferred → open → in_progress → review → closed`
6. **Footer updated**: Added `b backlog` keybinding hint

### `src/tui/dashboard.tsx`
7. **`StaticCounts` interface**: Added `deferred` field
8. **`fetchStaticCounts()`**: Counts issues with `status === "deferred"` 
9. **Static summary display**: Shows `◇ N backlog` count alongside other statuses

**All 314 tests pass.**