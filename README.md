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
  start      Start the orchestrator (daemonizes by default)
  status     Show current issue status from beads
  validate   Validate WORKFLOW.md configuration
  init       Create a new WORKFLOW.md
  instances  List all running symphony instances
  doctor     Verify dependencies, config, and runtime state
  logs       Tail the symphony log file
  stop       Stop a running symphony instance
  kanban     Interactive kanban board

Flags:
  --json            Output as JSON
  --workflow PATH   Workflow file (default: WORKFLOW.md)
  --verbose         Verbose output
  -h, --help        Show help
  -v, --version     Show version

Start flags:
  -f, --foreground  Run in foreground (don't daemonize)

Logs flags:
  -f, --follow      Follow the log file (like tail -f)
  -n, --lines N     Number of lines to show (default: 50)

Stop flags:
  --all             Stop all registered symphony instances
  --id ID           Stop a specific instance by ID or unique ID prefix

Validate flags:
  --strict          Treat warnings as errors (non-zero exit)
```

### Instance IDs (deterministic) and targeted stop

Each running instance gets a deterministic ID derived from the absolute project path.

- `symphony start --json` includes top-level `instance_id`
- `symphony status --json` includes `service.instance_id`
- `symphony instances --json` includes `instances[].id`

Example flow:

```bash
symphony instances
# ... copy ID (or a unique prefix) ...
symphony stop --id 1234567890
```

Prefix matching rules for `stop --id`:

- exact ID match wins
- otherwise, a unique prefix is accepted
- if a prefix matches multiple instances, command fails with `instance_id_ambiguous`
- in text mode, ambiguous errors also print top matching IDs to help you pick a longer prefix

### Validate warnings and strict mode

`validate` reports unknown `WORKFLOW.md` sections/keys as warnings to catch typos.
Use strict mode when you want warnings to fail CI:

```bash
symphony validate --strict
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
     │  ▲                     │                         │
     │  │                     │                   PR merged
     ▼  │                     ▼                         │
 ┌──────────┐           ┌──────────┐                    │
 │ deferred │           │  closed  │ ◄──────────────────┘
 │ (backlog)│           └──────────┘
 └──────────┘
```

| State | Orchestrator behavior |
|-------|-----------------------|
| `open`, `in_progress` | Agent dispatched / kept running |
| `review`, `blocked` | Agent stopped, workspace preserved |
| `deferred` | Not dispatched — parked in backlog |
| `closed`, `cancelled` | Agent stopped, workspace removed |

## Backlog workflow

Issues can be deferred to a backlog so the orchestrator skips them until you're ready.

### Creating backlog items

```bash
bd create "Nice-to-have refactor" -s deferred -p 3   # starts in backlog
```

### Moving issues to/from backlog

```bash
bd update bd-42 -s deferred   # send an open issue to backlog
bd update bd-42 -s open       # promote from backlog back to active
```

Deferred issues are **not dispatched** by the orchestrator — they stay parked until explicitly promoted.

### Time-based deferral

You can defer an issue for a specific duration using `--defer`:

```bash
bd update bd-42 --defer '+1w'   # defer for 1 week
bd update bd-42 --defer '+3d'   # defer for 3 days
```

When the deferral period expires, the issue automatically becomes eligible for dispatch again.

### TUI kanban board

The terminal dashboard (`symphony kanban`) shows a **Backlog** column for deferred issues. Keyboard shortcuts:

| Key | Action |
|-----|--------|
| `b` | Send the selected issue to backlog (set `deferred`) |
| `B` | Promote the selected issue from backlog (set `open`) |

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
    set -e
    if [ -n "$REPO_URL" ]; then
      git clone "$REPO_URL" .
    elif [ -n "$SYMPHONY_REPO" ] && [ "$SYMPHONY_REPO" != '$SYMPHONY_REPO' ]; then
      if command -v gh >/dev/null 2>&1; then
        gh repo clone "$SYMPHONY_REPO" .
      else
        git clone "https://github.com/$SYMPHONY_REPO.git" .
      fi
    else
      echo "No repository source configured. Set REPO_URL or workspace.repo." >&2
      exit 1
    fi
    echo "node_modules" >> .gitignore
    bun install
  before_run: |
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed "s|refs/remotes/origin/||" || echo "master")
    git fetch origin $DEFAULT_BRANCH 2>/dev/null || true
    git fetch origin issue/$SYMPHONY_ISSUE_ID 2>/dev/null || true
    if git rev-parse --verify origin/issue/$SYMPHONY_ISSUE_ID >/dev/null 2>&1; then
      git checkout -B issue/$SYMPHONY_ISSUE_ID origin/issue/$SYMPHONY_ISSUE_ID
    else
      git checkout -B issue/$SYMPHONY_ISSUE_ID origin/$DEFAULT_BRANCH
    fi
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
| `SYMPHONY_REMOTE` | Git remote name from `workspace.remote` |
| `SYMPHONY_REPO` | Repository slug from `workspace.repo` (e.g. `owner/repo`) |
| `REPO_URL` | Optional full clone URL set by you in your environment |

The default `after_create` hook fails fast if neither `REPO_URL` nor `workspace.repo`/`SYMPHONY_REPO` is available, so misconfiguration is surfaced early instead of creating an empty workspace.

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

symphony instances                   # see all running + IDs
symphony stop --id <instance-id>    # stop one specific instance
```

Isolation: `.symphony.lock` prevents duplicates, global registry (`~/.symphony/instances/`) detects workspace root collisions (including nested overlaps). `symphony doctor` also reports overlapping workspace roots across running instances.

## WORKFLOW.md hot-reload

Edit `WORKFLOW.md` while the orchestrator is running — changes are detected and applied without restart. Affects future dispatches, not in-flight agents.

## Architecture

```
src/
  cli.ts            CLI entry point and subcommands
  config.ts         WORKFLOW.md parser and validation
  doctor.ts         Dependency and config health checks
  exec.ts           Subprocess helper
  lock.ts           PID lock files + instance registry
  log.ts            Structured logging (text/JSON/file)
  orchestrator.ts   Poll / dispatch / reconcile / retry loop
  pr-monitor.ts     GitHub PR watcher (merge/changes requested)
  runner.ts         Pi agent spawning + stdout capture
  template.ts       Mustache-compatible prompt renderer
  tracker.ts        Beads (bd) CLI integration
  types.ts          TypeScript types
  watcher.ts        WORKFLOW.md file change detection
  workspace.ts      Per-issue workspace management
  tui/
    app.tsx                Kanban TUI entry point
    index.ts               TUI module exports
    issue-data.ts          Beads data access for TUI
    issue-detail-overlay.ts Issue detail panel
    new-issue-dialog.ts    New issue dialog
```

## License

MIT
