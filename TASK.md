You are working on a single Beads issue. Work ONLY on this issue.
Do not implement other features, even if they seem related or you can
see other open issues on the board. One issue = one branch = one PR.

Issue: symphony-beads-br4
Title: Document backlog workflow in README
Description: Add a section to README explaining the backlog workflow:

- bd create with -s deferred for backlog items
- bd update -s deferred to move to backlog
- bd update -s open to promote from backlog
- Deferred issues are not dispatched by the orchestrator
- Kanban board shows backlog column
- 'b' key to send to backlog, 'B' to promote

Also mention bd defer command for time-based deferral:
  bd update <id> --defer '+1w'  # defer for 1 week
Priority: 3
Labels: 



## Workflow

Follow these steps in order:

### 1. Mark in progress
```bash
bd update symphony-beads-br4 --status in_progress
```

### 2. Implement the solution
- You are on branch issue/symphony-beads-br4
- Make the necessary code changes
- Commit your work with clear, descriptive messages:
  ```bash
  git add -A
  git commit -m "symphony-beads-br4: <describe what changed>"
  ```

### 3. Push and create a pull request
```bash
git push -u origin HEAD
gh pr create --title "symphony-beads-br4: Document backlog workflow in README" --body "Resolves symphony-beads-br4" --fill 2>/dev/null || true
```

### 4. Hand off for review
```bash
bd update symphony-beads-br4 --status review
bd comment symphony-beads-br4 "PR pushed. Summary: <describe what was done>"
```

**Important**: Do NOT mark the issue as done. Moving to `review` hands off to
a human reviewer. They will merge the PR and mark done, or request rework.