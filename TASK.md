You are working on a single Beads issue. Work ONLY on this issue.
Do not implement other features, even if they seem related or you can
see other open issues on the board. One issue = one branch = one PR.

Issue: symphony-beads-1eu
Title: PR monitor: track processed PRs to avoid re-checking every tick
Description: The PR monitor checks every merged/reviewed PR on every tick. If the beads issue no longer exists (e.g., after reinit), it spams warnings every 30 seconds forever.

Fix: maintain a Set<number> of already-processed PR numbers. Once a PR has been handled (issue closed, issue not found, or PR state recorded), add it to the set and skip it on future ticks.

The set should be in-memory only (resets on restart, which is fine). Clear entries if a PR transitions back to OPEN (rework case).
Priority: 2
Labels: 



## Workflow

Follow these steps in order:

### 1. Mark in progress
```bash
bd update symphony-beads-1eu --status in_progress
```

### 2. Implement the solution
- You are on branch issue/symphony-beads-1eu
- Make the necessary code changes
- Commit your work with clear, descriptive messages:
  ```bash
  git add -A
  git commit -m "symphony-beads-1eu: <describe what changed>"
  ```

### 3. Push and create a pull request
```bash
git push -u origin HEAD
gh pr create --title "symphony-beads-1eu: PR monitor: track processed PRs to avoid re-checking every tick" --body "Resolves symphony-beads-1eu" --fill 2>/dev/null || true
```

### 4. Hand off for review
```bash
bd update symphony-beads-1eu --status review
bd comment symphony-beads-1eu "PR pushed. Summary: <describe what was done>"
```

**Important**: Do NOT mark the issue as done. Moving to `review` hands off to
a human reviewer. They will merge the PR and mark done, or request rework.