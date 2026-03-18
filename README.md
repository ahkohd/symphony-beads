# symphony-beads

Symphony implementation for [Beads](https://github.com/steveyegge/beads) issue tracker.

Based on the [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md) by OpenAI.
Uses [pi](https://pi.dev) as the coding agent and [Bun](https://bun.sh) as the runtime.

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Beads](https://github.com/steveyegge/beads) (`bd` CLI)
- [Dolt](https://docs.dolthub.com/introduction/installation) (required by Beads)
- [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) coding agent

## Quick start

```bash
# Install dependencies
bun install

# Initialize beads in your project
cd your-project
bd init --quiet

# Create a workflow file
bun run src/cli.ts init

# Create some issues
bd create "Implement user auth" -p 1 -t feature
bd create "Fix login bug" -p 2 -t bug

# Start the orchestrator
bun run src/cli.ts start
```

## CLI

```
symphony <command> [flags]

Commands:
  start      Start the orchestrator daemon
  status     Show current issue status from beads
  validate   Validate WORKFLOW.md configuration
  init       Create a new WORKFLOW.md
  instances  List all running symphony instances

Flags:
  --json           Output as JSON
  --workflow PATH  Workflow file (default: WORKFLOW.md)
  --verbose        Verbose output
  -h, --help       Show this help
  -v, --version    Show version
```

All subcommands support `--json` for machine-readable output.

## Configuration

Configuration lives in `WORKFLOW.md` with YAML front-matter:

```yaml
---
tracker:
  kind: beads
  project_path: "."            # path to beads project
workspace:
  root: ./workspaces           # per-issue workspace directory
agent:
  max_concurrent: 5            # max parallel agents
  max_turns: 20                # max turns per agent session
  max_retry_backoff_ms: 300000 # max retry delay (5 min)
runner:
  command: pi -p --no-session  # coding agent command
  turn_timeout_ms: 3600000     # max turn duration (1 hour)
  stall_timeout_ms: 300000     # stall detection (5 min)
polling:
  interval_ms: 30000           # poll interval (30s)
log:
  file: ./symphony.log         # per-project log file (null = stdout only)
hooks:
  after_create: |              # runs once when workspace is created
    git clone git@github.com:org/repo.git .
  before_run: |                # runs before each agent attempt
    git pull --rebase
  after_run: |                 # runs after each agent attempt
    echo "done"
  timeout_ms: 60000            # hook timeout
---

Prompt template goes here. Uses Mustache syntax.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
Description: {{ issue.description }}
```

## Running multiple projects

Symphony supports running multiple instances on the same machine, one per
project. Each instance is self-contained: it reads its own `WORKFLOW.md`,
manages its own workspaces, and writes its own log file.

### Isolation mechanisms

| Concern | How it's handled |
|---------|-----------------|
| **Duplicate instances** | A `.symphony.lock` file in the project directory prevents two instances from starting for the same project. Stale locks (dead PID) are automatically cleaned up. |
| **Workspace collisions** | On startup, symphony checks a global registry (`~/.symphony/instances/`) to ensure no other running instance uses the same `workspace.root`. |
| **Log isolation** | Configure `log.file` in each project's `WORKFLOW.md` to write logs to a project-specific path (e.g., `./symphony.log`). |
| **Port conflicts** | No HTTP server yet. When added, configure a unique port per project. |

### Setup

Each project gets its own `WORKFLOW.md` with unique paths:

```yaml
# Project A — ~/projects/project-a/WORKFLOW.md
workspace:
  root: ./workspaces
log:
  file: ./symphony.log

# Project B — ~/projects/project-b/WORKFLOW.md
workspace:
  root: ./workspaces          # same relative path, different absolute path
log:
  file: ./symphony.log
```

### Running with tmux

```bash
# Start a tmux session per project
tmux new-session -d -s project-a -c ~/projects/project-a \
  'bun run ~/symphony-beads/src/cli.ts start'

tmux new-session -d -s project-b -c ~/projects/project-b \
  'bun run ~/symphony-beads/src/cli.ts start'

# Attach to any session
tmux attach -t project-a
```

### Running with systemd

Create a unit file per project:

```ini
# ~/.config/systemd/user/symphony-project-a.service
[Unit]
Description=Symphony orchestrator for project-a

[Service]
WorkingDirectory=%h/projects/project-a
ExecStart=/usr/local/bin/bun run %h/symphony-beads/src/cli.ts start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now symphony-project-a
systemctl --user enable --now symphony-project-b
```

## How it works

1. Polls Beads for issues in active states (`open`, `in_progress`)
2. Dispatches eligible issues to pi agent sessions
3. Each issue gets an isolated workspace directory
4. Agent runs in the workspace with the rendered prompt
5. On completion, schedules a continuation check
6. On failure, retries with exponential backoff
7. Reconciles running sessions against tracker state each tick

## Issue lifecycle

Issues move through three categories of states. The orchestrator's behavior
depends on which category the current state falls into:

| Category | States | Orchestrator behavior |
|----------|--------|-----------------------|
| **Active** | `open`, `in_progress` | Agent is dispatched / kept running |
| **Paused** | `review`, `blocked`, `deferred` | Agent is stopped, workspace is **preserved** |
| **Terminal** | `done`, `closed`, `cancelled`, `duplicate` | Agent is stopped, workspace is **removed** |

The full lifecycle with human review:

```
                  ┌──────────────────────────────────────┐
                  │                                      │
                  ▼                                      │
  ┌────────┐  dispatch  ┌─────────────┐  agent moves  ┌────────┐
  │  open  │ ─────────► │ in_progress │ ────────────► │ review │
  └────────┘            └─────────────┘               └────────┘
      ▲                       │                          │  │
      │                       │ agent/human              │  │
      │                       ▼                          │  │
      │                 ┌───────────┐    human accepts   │  │
      │                 │   done    │ ◄──────────────────┘  │
      │                 └───────────┘                       │
      │                                                    │
      └────────────────────────────────────────────────────┘
                        human requests rework
```

### Review workflow

The review state enables human-in-the-loop oversight. Here is the complete
flow:

1. **Agent works on the issue.** The orchestrator dispatches the issue and the
   agent implements the solution in an isolated workspace, committing to a
   feature branch.

2. **Agent moves the issue to `review`.** When the agent finishes, it runs
   `bd update <id> --status review`. Because `review` is neither an active
   state nor a terminal state, the orchestrator stops the agent but **preserves
   the workspace and branch** for inspection.

3. **Human reviews.** The operator inspects the workspace, branch, or PR:
   - Review the code changes on the feature branch
   - Run tests, check CI results
   - Read the agent's summary comment (`bd show <id>`)

4. **Human decides:**
   - **Accept →** `bd update <id> --status done` (terminal: workspace cleaned up)
   - **Rework →** `bd update <id> --status open` (active: agent picks it up again)
   - **Rework with notes →** `bd comment <id> "Please fix X"` then
     `bd update <id> --status open`

### Configuring the review status

The `review` status is a custom beads status. It is configured automatically
when you run `symphony init`, but you can also set it up manually:

```bash
bd config set status.custom "review"
```

To add multiple custom statuses (comma-separated):

```bash
bd config set status.custom "review,qa,staging"
```

> **Important:** Do not add `review` to `active_states` or `terminal_states`
> in your WORKFLOW.md. The orchestrator must treat it as a paused state —
> stopping the agent while keeping the workspace intact for human inspection.

## Architecture

```
src/
  cli.ts          CLI entry point and arg parsing
  config.ts       WORKFLOW.md parser and validation
  lock.ts         PID lock file & instance registry
  orchestrator.ts Poll/dispatch/reconcile/retry loop
  tracker.ts      Beads (bd) CLI integration
  workspace.ts    Per-issue workspace management
  runner.ts       Pi agent process management
  template.ts     Mustache-compatible prompt renderer
  exec.ts         Subprocess execution helper
  log.ts          Structured logging (text/JSON, file output)
  types.ts        TypeScript type definitions
```

## License

MIT
