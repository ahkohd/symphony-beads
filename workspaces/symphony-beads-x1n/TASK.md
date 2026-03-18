You are working on a Beads issue.

Issue: symphony-beads-x1n
Title: Update prompt template to instruct agent on git and review workflow
Description: Per spec section 1: ticket writes (state transitions, comments, PR links) are performed by the coding agent. Per section 11.5: workflow success often means reaching a handoff state like Human Review, not Done.

The default prompt template must instruct the agent to:
1. Create a feature branch named after the issue (git checkout -b issue/IDENTIFIER)
2. Implement the solution with proper commits
3. Push the branch (git push origin HEAD)
4. Move the issue to review state (bd update IDENTIFIER --status review)
5. Add a comment summarizing what was done (bd comment IDENTIFIER ...)

The orchestrator already handles non-active states correctly per spec section 8.5 part B: if tracker state is neither active nor terminal, it stops the agent without workspace cleanup. So moving to review will pause the issue until a human acts.
Priority: 1
Labels: 

Implement the solution. When done, mark the issue complete:
  bd update symphony-beads-x1n --status done