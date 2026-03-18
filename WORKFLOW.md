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
  turn_timeout_ms: 7200000
  stall_timeout_ms: 7200000
polling:
  interval_ms: 30000
hooks:
  after_create: |
    git clone git@github.com:ahkohd/symphony-beads.git . 2>/dev/null || true
    rm -rf .beads 2>/dev/null; ln -sf "$SYMPHONY_PROJECT_PATH/.beads" .beads
  before_run: |
    git fetch origin 2>/dev/null || true
    if git rev-parse --verify origin/issue/$SYMPHONY_ISSUE_ID >/dev/null 2>&1; then
      git checkout -B issue/$SYMPHONY_ISSUE_ID origin/issue/$SYMPHONY_ISSUE_ID
    else
      git checkout -B issue/$SYMPHONY_ISSUE_ID origin/master 2>/dev/null || git checkout -B issue/$SYMPHONY_ISSUE_ID
    fi
log:
  file: ./symphony.log
---

You are working on a Beads issue.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
Description: {{ issue.description }}
Priority: {{ issue.priority }}
Labels: {{ issue.labels }}

{{#review_feedback}}
## ⚠️ PR Review Feedback (Rework Required)

A pull request was previously submitted for this issue and received reviewer
feedback. **Your primary goal is to address the comments below.** Work on the
existing branch — do NOT create a new one.

{{ review_feedback }}

---
{{/review_feedback}}

## Workflow

Follow these steps in order:

### 1. Implement the solution
- You are on branch issue/{{ issue.identifier }}
- Make the necessary code changes
- Commit your work with clear, descriptive messages:
  ```bash
  git add -A
  git commit -m "{{ issue.identifier }}: <describe what changed>"
  ```

### 2. Push and create a pull request
```bash
git push -u origin HEAD
gh pr create --title "{{ issue.identifier }}: {{ issue.title }}" --body "Resolves {{ issue.identifier }}" --fill 2>/dev/null || true
```

### 3. Hand off for review
```bash
bd update {{ issue.identifier }} --status review
bd comment {{ issue.identifier }} "PR pushed. Summary: <describe what was done>"
```

**Important**: Do NOT mark the issue as done. Moving to `review` hands off to
a human reviewer. They will merge the PR and mark done, or request rework.
