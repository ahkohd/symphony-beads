// ---------------------------------------------------------------------------
// Domain types for Symphony-Beads
// Based on https://github.com/openai/symphony/blob/main/SPEC.md
// ---------------------------------------------------------------------------

/** Normalized issue record used across all layers. */
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  labels: string[];
  blocked_by: BlockerRef[];
  issue_type: string | null;
  metadata: Record<string, string> | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

// -- Workflow ----------------------------------------------------------------

export interface WorkflowDefinition {
  config: ServiceConfig;
  prompt_template: string;
}

// -- Config ------------------------------------------------------------------

export interface ServiceConfig {
  tracker: TrackerConfig;
  polling: PollingConfig;
  workspace: WorkspaceConfig;
  hooks: HooksConfig;
  agent: AgentConfig;
  runner: RunnerConfig;
  log: LogConfig;
  server?: ServerConfig;
}

export interface ServerConfig {
  port: number | null;
  hostname: string;
}

export interface LogConfig {
  file: string | null;
}

export interface TrackerConfig {
  kind: "beads";
  project_path: string;
  active_states: string[];
  terminal_states: string[];
}

export interface PollingConfig {
  interval_ms: number;
}

export interface WorkspaceConfig {
  root: string;
  repo: string | null;
  remote: string;
}

export interface HooksConfig {
  after_create: string | null;
  before_run: string | null;
  after_run: string | null;
  before_remove: string | null;
  timeout_ms: number;
}

export interface AgentConfig {
  max_concurrent: number;
  max_concurrent_by_state: Record<string, number> | null;
  max_turns: number;
  max_retry_backoff_ms: number;
}

export interface RunnerConfig {
  command: string;
  model: string | null;
  models: Record<string, string> | null;
  turn_timeout_ms: number;
  stall_timeout_ms: number;
}

// -- Workspace ---------------------------------------------------------------

export interface Workspace {
  path: string;
  key: string;
  created: boolean;
}

// -- Runtime state -----------------------------------------------------------

export interface RunningEntry {
  issue: Issue;
  session_id: string | null;
  attempt: number;
  started_at: number; // Date.now()
  last_event: string | null;
  last_event_at: number | null;
  last_message: string;
  tokens: TokenCount;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at: number; // Date.now() + delay
  timer: ReturnType<typeof setTimeout>;
  error: string | null;
}

export interface TokenCount {
  input: number;
  output: number;
  total: number;
}

export interface AgentTotals {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  ended_seconds: number;
}

// -- Events ------------------------------------------------------------------

export type AgentEvent =
  | { kind: "session_started"; session_id: string }
  | { kind: "turn_completed"; message: string }
  | { kind: "turn_failed"; message: string }
  | { kind: "turn_timeout"; message: string }
  | { kind: "token_update"; tokens: TokenCount }
  | { kind: "log"; message: string };

// -- CLI ---------------------------------------------------------------------

export interface CliFlags {
  json: boolean;
  workflow: string;
  port: number | null;
  verbose: boolean;
}