---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: /tmp/symphony-workspaces
  repo: ahkohd/symphony-beads
  remote: origin
agent:
  max_concurrent: 5
  max_turns: 20
runner:
  command: pi --no-session
  turn_timeout_ms: 7200000
  stall_timeout_ms: 7200000
polling:
  interval_ms: 30000
hooks:
  after_create: |
    gh repo clone $SYMPHONY_REPO . || true
    rm -rf .beads 2>/dev/null; ln -sf "$SYMPHONY_PROJECT_PATH/.beads" .beads
    echo "node_modules" >> .gitignore
    bun install 2>/dev/null || true
    cat >> AGENTS.md << 'AGENTS'

    # Symphony Agent Guidelines
    - Work ONLY within this directory. Do not read or write files outside of it.
    - Do not cd to parent directories or access ../
    - All file paths must be relative to the current working directory.
    - Use git to commit and push your changes when done.
    AGENTS
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

You are working on a single Beads issue. Work ONLY on this issue.
Do not implement other features, even if they seem related or you can
see other open issues on the board. One issue = one branch = one PR.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
Description: {{ issue.description }}
Priority: {{ issue.priority }}
Labels: {{ issue.labels }}

{{#review_feedback}}
## PR Review Feedback (Rework Required)

A pull request was previously submitted and received reviewer feedback.
Your primary goal is to address the comments below. Work on the existing
branch — do NOT create a new one.

{{ review_feedback }}

---
{{/review_feedback}}

## Workflow

Follow these steps in order:

### 1. Mark in progress
```bash
bd update {{ issue.identifier }} --status in_progress
```

### 2. Implement the solution
- You are on branch issue/{{ issue.identifier }}
- Make the necessary code changes
- Commit your work with clear, descriptive messages:
  ```bash
  git add -A
  git commit -m "{{ issue.identifier }}: <describe what changed>"
  ```

### 3. Push and create a pull request
```bash
git push -u origin HEAD
gh pr create --title "{{ issue.identifier }}: {{ issue.title }}" --body "Resolves {{ issue.identifier }}" --fill 2>/dev/null || true
```

### 4. Hand off for review
```bash
bd update {{ issue.identifier }} --status review
bd comment {{ issue.identifier }} "PR pushed. Summary: <describe what was done>"
```

**Important**: Do NOT mark the issue as done. Moving to `review` hands off to
a human reviewer. They will merge the PR and mark done, or request rework.
