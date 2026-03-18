You are working on a single Beads issue. Work ONLY on this issue.
Do not implement other features, even if they seem related or you can
see other open issues on the board. One issue = one branch = one PR.

Issue: symphony-beads-xtp
Title: Fix token display: use total_tokens instead of input+output in dashboard and kanban
Description: The dashboard and kanban views compute total tokens as input_tokens + output_tokens, which misses cache tokens (cache_read and cache_write). This causes displayed totals to be misleadingly low. Fix: use total_tokens from the snapshot directly instead of summing input + output. Files: src/tui/dashboard.tsx and src/tui/app.tsx.
Priority: 1
Labels: 



## Workflow

Follow these steps in order:

### 1. Mark in progress
```bash
bd update symphony-beads-xtp --status in_progress
```

### 2. Implement the solution
- You are on branch issue/symphony-beads-xtp
- Make the necessary code changes
- Commit your work with clear, descriptive messages:
  ```bash
  git add -A
  git commit -m "symphony-beads-xtp: <describe what changed>"
  ```

### 3. Push and create a pull request
```bash
git push -u origin HEAD
gh pr create --title "symphony-beads-xtp: Fix token display: use total_tokens instead of input+output in dashboard and kanban" --body "Resolves symphony-beads-xtp" --fill 2>/dev/null || true
```

### 4. Hand off for review
```bash
bd update symphony-beads-xtp --status review
bd comment symphony-beads-xtp "PR pushed. Summary: <describe what was done>"
```

**Important**: Do NOT mark the issue as done. Moving to `review` hands off to
a human reviewer. They will merge the PR and mark done, or request rework.