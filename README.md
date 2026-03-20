# symphony-beads

Autonomous coding orchestrator for Beads issues.

It polls issues, creates per-issue workspaces, runs the configured coding runner (default: [`pi`](https://pi.dev)) to implement work, opens PRs, and reacts to PR review outcomes.

Built on [Beads](https://github.com/steveyegge/beads) and [Bun](https://bun.sh), with `pi` as the default runner. Based on the [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md).

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start-5-minutes)
- [First-run checklist](#first-run-checklist)
- [Daily operator workflow](#daily-operator-workflow)
- [Creating tickets via agents](#creating-tickets-via-agents)
- [CLI reference](#cli-reference)
- [Kanban](#kanban)
- [Runtime isolation and instance IDs](#runtime-isolation-and-instance-ids)
- [WORKFLOW.md configuration](#workflowmd-configuration)
- [Model routing and per-ticket model selection](#model-routing-and-per-ticket-model-selection)
- [Issue lifecycle and backlog](#issue-lifecycle-and-backlog)
- [Validate and doctor](#validate-and-doctor)
- [Troubleshooting](#troubleshooting)
- [JSON output quick reference](#json-output-quick-reference)
- [Running multiple projects](#running-multiple-projects)
- [Contributing and quality gates](#contributing-and-quality-gates)

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Beads](https://github.com/steveyegge/beads) (`bd` CLI)
- [Dolt](https://docs.dolthub.com/introduction/installation) (required by Beads)
- [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) (default runner used by `symphony init`)
- A coding runner available in PATH for your configured `runner.command` (you can replace `pi`)
- [gh](https://cli.github.com/) (for PR creation/monitoring)
- [git](https://git-scm.com/)

## Install

```bash
git clone https://github.com/ahkohd/symphony-beads.git
cd symphony-beads
bun install
bun link    # installs the `symphony` command globally
```

## Quick start

```bash
cd your-project

# Ask your coding agent to initialize Beads in this repo

# Option A: export full clone URL
export REPO_URL="https://github.com/owner/repo.git"

# Option B: set workspace.repo in WORKFLOW.md (owner/repo)

symphony init
symphony validate --strict
symphony doctor

# Ask your coding agent to create the first ticket in Beads
symphony start
symphony status
symphony logs -f
```

## First-run checklist

Before first `start`, confirm:

1. **Clone source is configured**
   - `REPO_URL` env var, or
   - `workspace.repo` in `WORKFLOW.md`.
2. `gh auth status` succeeds.
3. `workspace.root` is unique for this project (not overlapping another running instance root).
4. `symphony validate --strict` passes.
5. `symphony doctor` is healthy.

## Daily operator workflow

```bash
# Start (daemon by default)
symphony start

# Observe
symphony status
symphony instances
symphony logs -f

# Stop one instance
symphony stop --id <instance-id-or-unique-prefix>

# Stop all
symphony stop --all
```

## Creating tickets via agents

Beads operations are agent-facing in this workflow. Humans are expected to ask their coding agent to create and update tickets.

Example requests to your agent:

- "Create a P1 bug ticket in Beads: Fix flaky CI test suite. Description: Intermittent failure in parser tests."
- "Create a feature ticket for Migrate auth flow and set metadata model=claude-opus-4-6."
- "Create a ticket for docs cleanup and set it to deferred (backlog)."
- "For issue bd-42, set metadata model=claude-opus-4-6."
- "For issue bd-42, clear metadata model."

When model metadata is present, Symphony uses it as the highest-priority model routing signal (see model routing section below).

## CLI reference

```text
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
  -f, --foreground  Run in foreground

Logs flags:
  -f, --follow      Follow the log file
  -n, --lines N     Number of lines to show (default: 50)

Stop flags:
  --all             Stop all registered symphony instances
  --id ID           Stop a specific instance by ID or unique ID prefix

Validate flags:
  --strict          Treat warnings as errors

Doctor flags:
  --fix             Apply safe automatic repairs before checks
  --dry-run         Preview fixes without applying changes (requires --fix)
```

## Kanban

Launch the TUI board:

```bash
symphony kanban
```

Kanban is an operator view for triage and monitoring. Ticket creation remains agent-driven (`n` shows guidance to ask your coding agent).

- `j/k` or arrows: move selection
- `g/G`: jump to top/bottom in active column
- `m/M`: move status forward/backward
- `b/B`: defer/promote backlog
- `r`: refresh
- `q`: quit

Kanban screenshot:

![Kanban screenshot](https://github.com/user-attachments/assets/54421b0e-31a4-43aa-8ecc-b51c3cc0c305)

## Runtime isolation and instance IDs

### Isolation model

- **Per project:** `.symphony.lock` prevents duplicate local starts.
- **Global:** `~/.symphony/instances/` tracks live instances.
- **Workspace collision guard:** overlapping roots are blocked (exact match and parent/child overlap).

Example overlap (invalid):

- Instance A: `/tmp/symphony`
- Instance B: `/tmp/symphony/project-b`

### Deterministic instance IDs

Instance IDs are deterministic from absolute project path.

- `start --json`: top-level `instance_id`
- `status --json`: `service.instance_id`
- `instances --json`: `instances[].id`

Prefix behavior for `stop --id`:

- exact ID match wins
- otherwise unique prefix works
- ambiguous prefix fails with `instance_id_ambiguous`

## WORKFLOW.md configuration

`WORKFLOW.md` has YAML front-matter and prompt body.

Front-matter example (aligned with `symphony init` defaults)

```yaml
---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: ./workspaces
  repo: $SYMPHONY_REPO
  remote: origin
agent:
  max_concurrent: 5
  max_turns: 20
runner:
  command: pi --no-session
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
    bun install 2>/dev/null || npm install 2>/dev/null || true
  before_run: |
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/$SYMPHONY_REMOTE/HEAD 2>/dev/null | sed "s|refs/remotes/$SYMPHONY_REMOTE/||" || echo "master")
    git fetch $SYMPHONY_REMOTE $DEFAULT_BRANCH 2>/dev/null || true
    git fetch $SYMPHONY_REMOTE issue/$SYMPHONY_ISSUE_ID 2>/dev/null || true
    if git rev-parse --verify $SYMPHONY_REMOTE/issue/$SYMPHONY_ISSUE_ID >/dev/null 2>&1; then
      git checkout -B issue/$SYMPHONY_ISSUE_ID $SYMPHONY_REMOTE/issue/$SYMPHONY_ISSUE_ID
    else
      git checkout -B issue/$SYMPHONY_ISSUE_ID $SYMPHONY_REMOTE/$DEFAULT_BRANCH
    fi
    git clean -fd 2>/dev/null || true
log:
  file: ./symphony.log
---
```

### Hook environment variables

| Variable | Description |
|---|---|
| `SYMPHONY_ISSUE_ID` | Current issue identifier |
| `SYMPHONY_PROJECT_PATH` | Absolute project path |
| `SYMPHONY_REMOTE` | `workspace.remote` value |
| `SYMPHONY_REPO` | `workspace.repo` value (`owner/repo`) |
| `REPO_URL` | Optional full clone URL |

### Prompt template variables

| Variable | Description |
|---|---|
| `{{ issue.identifier }}` | Issue ID |
| `{{ issue.title }}` | Title |
| `{{ issue.description }}` | Description |
| `{{ issue.priority }}` | Priority |
| `{{ issue.labels }}` | Comma-separated labels |
| `{{ issue.state }}` | Current state |
| `{{ attempt }}` | Retry attempt |
| `{{ review_feedback }}` | PR review feedback on rework |


## Model routing and per-ticket model selection

Symphony supports per-ticket model routing.

Resolution order (highest first):

1. `issue.metadata.model`
2. `runner.models.<issue_type>` (for example `bug`, `feature`, `chore`)
3. `runner.models.P0..P4`
4. `runner.models.default`

To enable dynamic model selection, ensure your runner command consumes `$SYMPHONY_MODEL`:

```yaml
runner:
  command: pi --no-session --model $SYMPHONY_MODEL
  models:
    default: claude-sonnet-4-5-20250929
    P0: claude-opus-4-6
    bug: claude-opus-4-6
    chore: claude-haiku-4-5-20251001
```

Notes:

- For non-`pi` runners, use an equivalent command that accepts a model argument (still via `$SYMPHONY_MODEL`).
- Legacy fixed model is still supported via `runner.model` when `runner.models` is not set.

To set a per-issue model override, ask your agent to update issue metadata in Beads (for example: set `model=claude-opus-4-6` on `bd-42`).

## Issue lifecycle and backlog

```text
open/in_progress -> review -> closed
          ^          |
          |          | changes requested
          +----------+

open <-> deferred (backlog)
```

| State | Orchestrator behavior |
|---|---|
| `open`, `in_progress` | dispatch / keep running |
| `review`, `blocked`, `deferred` | do not dispatch; running agent is stopped |
| `closed`, `cancelled`, `duplicate` | terminal; workspace cleaned |

Backlog helpers (via agent requests):

- "Move bd-42 to deferred (backlog)."
- "Move bd-42 back to open."

Kanban backlog shortcuts:

- `b`: move selected issue to backlog (`deferred`)
- `B`: promote selected issue from backlog (`open`)


## Validate and doctor

### `symphony validate`

- validates known config semantics
- warns on unknown sections/keys (typo detection)
- warns when clone bootstrap likely has no source (`workspace.repo` and `REPO_URL` missing)
- `--strict` turns warnings into non-zero exit (CI mode)

### `symphony doctor`

Checks dependencies + runtime health, including workspace overlap risk.

When overlap is detected, doctor includes actionable hints such as:

- `symphony instances`
- `symphony stop --id <instance-id>`

### `symphony doctor --fix`

Safe repairs before checks:

- remove stale project lock
- ensure workspace root exists
- prune stale/invalid global registry entries

Use preview mode first:

```bash
symphony doctor --fix --dry-run
```


## Troubleshooting
### No repository source configured
No repository source configured. Set `REPO_URL` or `workspace.repo`.

Configure one of:

- `export REPO_URL=...`
- `workspace.repo: owner/repo`

Then run:

```bash
symphony validate --strict
```

### Workspace overlap failure

Run:

```bash
symphony instances
symphony stop --id <conflicting-id>
```

Then set distinct `workspace.root` paths per project.

### `gh` auth failures

```bash
gh auth login
symphony doctor
```

### Beads DB missing

Ask your coding agent to initialize Beads, then re-run:

```bash
symphony doctor
```

### Logs JSON

`logs --json` and `logs --follow` are mutually exclusive.

## JSON output quick reference

- `start --json`: includes `instance_id`, `pid`, `log_file`
- `status --json`: includes `service`, `issues`, `by_state`
- `instances --json`: includes `instances[]` with `id`, `pid`, `workspace_root`
- `stop --json`: structured stop result; errors include typed codes (`instance_not_found`, `instance_id_ambiguous`, `stop_flag_conflict`)
- `validate --json`: `valid`, `errors`, `warnings`, `strict`
- `doctor --json`: `checks[]` (`fix` section when using `--fix`)


## Running multiple projects

```bash
cd ~/projects/project-a && symphony start
cd ~/projects/project-b && symphony start

symphony instances
symphony stop --id <instance-id>
```

Use non-overlapping `workspace.root` values across projects.
