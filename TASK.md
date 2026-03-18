You are working on a single Beads issue. Work ONLY on this issue.
Do not implement other features, even if they seem related or you can
see other open issues on the board. One issue = one branch = one PR.

Issue: symphony-beads-hfn
Title: Add 'b' keybinding to send kanban card to backlog
Description: In the kanban board, add 'b' keybinding on a selected card to move it to backlog (deferred status). This is a quick way to deprioritize an issue without navigating through columns.

Also add 'B' to move from backlog to open (promote to active).
Priority: 2
Labels: 



## Workflow

Follow these steps in order:

### 1. Mark in progress
```bash
bd update symphony-beads-hfn --status in_progress
```

### 2. Implement the solution
- You are on branch issue/symphony-beads-hfn
- Make the necessary code changes
- Commit your work with clear, descriptive messages:
  ```bash
  git add -A
  git commit -m "symphony-beads-hfn: <describe what changed>"
  ```

### 3. Push and create a pull request
```bash
git push -u origin HEAD
gh pr create --title "symphony-beads-hfn: Add 'b' keybinding to send kanban card to backlog" --body "Resolves symphony-beads-hfn" --fill 2>/dev/null || true
```

### 4. Hand off for review
```bash
bd update symphony-beads-hfn --status review
bd comment symphony-beads-hfn "PR pushed. Summary: <describe what was done>"
```

**Important**: Do NOT mark the issue as done. Moving to `review` hands off to
a human reviewer. They will merge the PR and mark done, or request rework.