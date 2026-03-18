You are working on a Beads issue.

Issue: symphony-beads-bjf
Title: Configure beads review state and document human review workflow
Description: Per spec section 14.4: operators control behavior by changing issue states in the tracker. We need:
1. Ensure beads supports a 'review' status (or document how to add custom statuses)
2. Document the review workflow: agent moves issue to review -> human reviews workspace/branch -> human moves to done (accept) or open (rework)
3. The review state must NOT be in active_states or terminal_states so the orchestrator stops the agent but preserves the workspace (this is already handled by spec section 8.5 part B)
4. Update README with the full lifecycle diagram
Priority: 2
Labels: 

Implement the solution. When done, mark the issue complete:
  bd update symphony-beads-bjf --status done