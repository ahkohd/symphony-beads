# symphony-beads

Autonomous coding orchestrator for Beads issues.

It polls issues, creates per-issue workspaces, runs the configured coding runner (default: [`pi`](https://pi.dev)) to implement work, opens PRs, and reacts to PR review outcomes.

Built on [Beads](https://github.com/steveyegge/beads) and [Bun](https://bun.sh), with `pi` as the default runner. Based on the [Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md).

---

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start (5 minutes)](#quick-start-5-minutes)
- [First-run checklist](#first-run-checklist)
- [Daily operator workflow](#daily-operator-workflow)
- [CLI reference](#cli-reference)
- [Runtime isolation and instance IDs](#runtime-isolation-and-instance-ids)
- [WORKFLOW.md configuration](#workflowmd-configuration)
- [Issue lifecycle and backlog](#issue-lifecycle-and-backlog)
- [Validate and doctor](#validate-and-doctor)
- [Troubleshooting](#troubleshooting)
- [JSON output quick reference](#json-output-quick-reference)
- [Running multiple projects](#running-multiple-projects)
- [Contributing and quality gates](#contributing-and-quality-gates)

---

## Requirements

- [Bun](https://bun.sh) >= 1.0
- [Beads](https://github.com/steveyegge/beads) (`bd` CLI)
- [Dolt](https://docs.dolthub.com/introduction/installation) (required by Beads)
- [pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent)
- [gh](https://cli.github.com/) (for PR creation/monitoring)
- [git](https://git-scm.com/)

## Install

```bash
git clone https://github.com/ahkohd/symphony-beads.git
cd symphony-beads
bun install
bun link    # installs the `symphony` command globally
```

---

## Quick start (5 minutes)

```bash
cd your-project
bd init --quiet

# Option A: export full clone URL
export REPO_URL="https://github.com/owner/repo.git"

# Option B: set workspace.repo in WORKFLOW.md (owner/repo)

symphony init
symphony validate --strict
symphony doctor

bd create "Implement feature X" -p 1 -t feature
symphony start
symphony status
symphony logs -f
```

---

## First-run checklist

Before first `start`, confirm:

1. **Clone source is configured**
   - `REPO_URL` env var, or
   - `workspace.repo` in `WORKFLOW.md`.
2. `gh auth status` succeeds.
3. `workspace.root` is unique for this project (not overlapping another running instance root).
4. `symphony validate --strict` passes.
5. `symphony doctor` is healthy.

---

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

---

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

---

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

- `start --json` → top-level `instance_id`
- `status --json` → `service.instance_id`
- `instances --json` → `instances[].id`

Prefix behavior for `stop --id`:

- exact ID match wins
- otherwise unique prefix works
- ambiguous prefix fails with `instance_id_ambiguous`

---

## WORKFLOW.md configuration

`WORKFLOW.md` has YAML front-matter + prompt body.

### Front-matter example (aligned with `symphony init` defaults)

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

---

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

Backlog helpers:

```bash
bd update bd-42 -s deferred   # park in backlog
bd update bd-42 -s open       # promote back to active
```

Kanban backlog shortcuts:

- `b` → move selected issue to backlog (`deferred`)
- `B` → promote selected issue from backlog (`open`)

---

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

---

## Troubleshooting

### `No repository source configured. Set REPO_URL or workspace.repo.`

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

```bash
bd init
symphony doctor
```

### Logs JSON + follow conflict

`logs --json` and `logs --follow` are mutually exclusive.

---

## JSON output quick reference

- `start --json` → includes `instance_id`, `pid`, `log_file`
- `status --json` → includes `service`, `issues`, `by_state`
- `instances --json` → includes `instances[]` with `id`, `pid`, `workspace_root`
- `stop --json` → structured stop result; errors include typed codes (`instance_not_found`, `instance_id_ambiguous`, `stop_flag_conflict`)
- `validate --json` → `valid`, `errors`, `warnings`, `strict`
- `doctor --json` → `checks[]` (+ `fix` section when using `--fix`)

---

## Running multiple projects

```bash
cd ~/projects/project-a && symphony start
cd ~/projects/project-b && symphony start

symphony instances
symphony stop --id <instance-id>
```

Use non-overlapping `workspace.root` values across projects.

---

## Contributing and quality gates

Before commit:

```bash
bun run fmt:check
bun run lint
bun run typecheck
bun run test
bun run smoke:cli
```

CI runs these gates on push/PR.

License: see [LICENSE.md](LICENSE.md).
