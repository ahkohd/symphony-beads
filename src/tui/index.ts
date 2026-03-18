// ---------------------------------------------------------------------------
// TUI components — re-exports
// ---------------------------------------------------------------------------

export { launchTui } from "./app.tsx";
export { launchDashboard } from "./dashboard.tsx";
export { IssueDetailOverlay, showIssueDetail } from "./issue-detail-overlay.ts";
export { NewIssueDialog, showNewIssueDialog } from "./new-issue-dialog.ts";
export {
  fetchIssueDetail,
  fetchIssueComments,
  fetchAgentSession,
  type IssueDetail,
  type IssueComment,
  type AgentSessionInfo,
} from "./issue-data.ts";
export {
  OrchestratorClient,
  type DashboardState,
  type LiveDashboardState,
  type StaticDashboardState,
  type StaticIssue,
} from "./live-client.ts";
