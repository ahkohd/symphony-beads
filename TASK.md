You are working on a single Beads issue. Work ONLY on this issue.
Do not implement other features, even if they seem related or you can
see other open issues on the board. One issue = one branch = one PR.

Issue: symphony-beads-8u7
Title: Add Backlog column to kanban board
Description: The kanban board has 4 columns: Open, In Progress, Review, Closed. Add a Backlog column for deferred issues.

1. Add 'deferred' column to COLUMNS array in src/tui/app.tsx (before Open)
2. Color: dim/gray to distinguish from active work
3. Issues with status 'deferred' go in this column
4. Moving a card to Backlog sets status to 'deferred' via bd update -s deferred
5. Moving from Backlog to Open sets status to 'open' (triggers dispatch)
6. The column should be collapsible or narrower since backlog items are lower priority
Priority: 2
Labels: 



## Workflow

Follow these steps in order:

### 1. Mark in progress
```bash
bd update symphony-beads-8u7 --status in_progress
```

### 2. Implement the solution
- You are on branch issue/symphony-beads-8u7
- Make the necessary code changes
- Commit your work with clear, descriptive messages:
  ```bash
  git add -A
  git commit -m "symphony-beads-8u7: <describe what changed>"
  ```

### 3. Push and create a pull request
```bash
git push -u origin HEAD
gh pr create --title "symphony-beads-8u7: Add Backlog column to kanban board" --body "Resolves symphony-beads-8u7" --fill 2>/dev/null || true
```

### 4. Hand off for review
```bash
bd update symphony-beads-8u7 --status review
bd comment symphony-beads-8u7 "PR pushed. Summary: <describe what was done>"
```

**Important**: Do NOT mark the issue as done. Moving to `review` hands off to
a human reviewer. They will merge the PR and mark done, or request rework.