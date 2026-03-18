# symphony-beads

Autonomous coding orchestrator. Creates issues, dispatches AI agents, opens PRs, handles review feedback — all from the terminal.

Built on [Beads](https://github.com/steveyegge/beads) (issue tracker), [pi](https://pi.dev) (coding agent), and [Bun](https://bun.sh) (runtime). Based on the [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md) by OpenAI.

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Beads](https://github.com/steveyegge/beads) (`bd` CLI)
- [Dolt](https://docs.dolthub.com/introduction/installation) (required by Beads)
- [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) coding agent
- [gh](https://cli.github.com/) GitHub CLI (for PR creation)
- [git](https://git-scm.com/)

## Install

```bash
git clone https://github.com/ahkohd/symphony-beads.git
cd symphony-beads
bun install
bun link    # makes 'symphony' available globally
```

## Quick start

```bash
cd your-project
bd init --quiet                # initialize beads
symphony init                  # create WORKFLOW.md
# edit WORKFLOW.md — set your repo URL, model, etc.

bd create "Implement feature X" -p 1 -t feature
symphony start                 # start the orchestrator
symphony status                # see what's happening
symphony logs -f               # watch the logs
```

## CLI

```
symphony <command> [flags]

Commands:
  start       Start the orchestrator daemon
  stop        Stop a running instance
  status      Show current issue status
  logs        Tail the log file (-f to follow)
  doctor      Verify all dependencies and config
  validate    Validate WORKFLOW.md
  init        Create a new WORKFLOW.md
  instances   List all running instances
  tui         Terminal dashboard and kanban board

Flags:
  --json            JSON output (all commands)
  --workflow PATH   Workflow file (default: WORKFLOW.md)
  --foreground      Run in foreground (start only)
  --follow, -f      Follow mode (logs only)
  --lines, -n       Number of lines (logs only)
  --all             Stop all instances (stop only)
  -h, --help        Show help
  -v, --version     Show version
```

## How it works

```
bd create issue → symphony dispatches → pi implements → git push
                                                         ↓
            auto-close ← PR monitor ← you merge ← gh pr create
                  OR
            reopen ← changes requested → agent gets feedback → fixes
```

1. Polls Beads for issues in active states (`open`, `in_progress`)
2. Creates isolated workspace per issue (git clone + branch)
3. Renders prompt template with issue details
4. Spawns pi agent to implement the solution
5. Agent commits, pushes, creates PR via `gh`, moves issue to `review`
6. PR monitor watches GitHub — auto-closes on merge, reopens on changes requested
7. On rework: fetches review comments and injects into prompt
8. On failure: retries with exponential backoff

## Issue lifecycle

```
             ┌──────────────────────────────────────────┐
             │            human requests rework          │
             ▼                                           │
  ┌────────┐  dispatch  ┌─────────────┐  PR created  ┌────────┐
  │  open  │ ─────────► │ in_progress │ ───────────► │ review │
  └────────┘            └─────────────┘              └────────┘
                              │                         │
                              │                   PR merged
                              ▼                         │
                        ┌──────────┐                    │
                        │  closed  │ ◄──────────────────┘
                        └──────────┘
```

| State | Orchestrator behavior |
|-------|-----------------------|
| `open`, `in_progress` | Agent dispatched / kept running |
| `review`, `blocked` | Agent stopped, workspace preserved |
| `closed`, `cancelled` | Agent stopped, workspace removed |

## Configuration

`WORKFLOW.md` with YAML front-matter:

```yaml
---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: ./workspaces
agent:
  max_concurrent: 5
  max_turns: 20
runner:
  command: pi -p --no-session
  model: claude-sonnet-4-5-20250929   # optional, appended as --model
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
polling:
  interval_ms: 30000
hooks:
  after_create: |
    git clone --single-branch --branch master $REPO_URL .
    echo "node_modules" >> .gitignore
    bun install
  before_run: |
    git fetch origin master
    git fetch origin issue/$SYMPHONY_ISSUE_ID 2>/dev/null || true
    git checkout -B issue/$SYMPHONY_ISSUE_ID origin/master
log:
  file: ./symphony.log
---

Prompt template with Mustache syntax...
```

### Hook environment variables

| Variable | Description |
|----------|-------------|
| `SYMPHONY_ISSUE_ID` | Current issue identifier |
| `SYMPHONY_PROJECT_PATH` | Absolute path to the project root |
| `REPO_URL` | Set by you in your environment |

### Prompt template variables

| Variable | Description |
|----------|-------------|
| `{{ issue.identifier }}` | Issue ID (e.g., `my-project-abc`) |
| `{{ issue.title }}` | Issue title |
| `{{ issue.description }}` | Issue description |
| `{{ issue.priority }}` | Priority (0-4) |
| `{{ issue.labels }}` | Comma-separated labels |
| `{{ issue.state }}` | Current state |
| `{{ attempt }}` | Retry attempt number |
| `{{ review_feedback }}` | PR review comments (on rework) |

Sections: `{{#review_feedback}}...{{/review_feedback}}` renders only when feedback exists.

## PR monitor

The orchestrator monitors GitHub PRs created by agents:

- **PR merged** → issue auto-closed via `bd update -s closed`
- **Changes requested** → issue reopened via `bd update -s open`, agent re-dispatched with review feedback injected into prompt

## Running multiple projects

Each project gets its own `WORKFLOW.md`, lock file, and log. No conflicts:

```bash
cd ~/projects/project-a && symphony start
cd ~/projects/project-b && symphony start

symphony instances   # see all running
```

Isolation: `.symphony.lock` prevents duplicates, global registry (`~/.symphony/instances/`) detects workspace root collisions.

## WORKFLOW.md hot-reload

Edit `WORKFLOW.md` while the orchestrator is running — changes are detected and applied without restart. Affects future dispatches, not in-flight agents.

## Architecture

```
src/
  cli.ts            CLI entry point and subcommands
  config.ts         WORKFLOW.md parser and validation
  orchestrator.ts   Poll / dispatch / reconcile / retry loop
  tracker.ts        Beads (bd) CLI integration
  workspace.ts      Per-issue workspace management
  runner.ts         Pi agent spawning + stdout capture
  pr-monitor.ts     GitHub PR watcher (merge/changes requested)
  template.ts       Mustache-compatible prompt renderer
  server.ts         HTTP dashboard (GET /api/v1/state)
  doctor.ts         Dependency and config health checks
  watcher.ts        WORKFLOW.md file change detection
  lock.ts           PID lock files + instance registry
  exec.ts           Subprocess helper
  log.ts            Structured logging (text/JSON/file)
  types.ts          TypeScript types
```

## License

MIT
