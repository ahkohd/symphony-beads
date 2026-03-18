You are working on a Beads issue.

Issue: symphony-beads-4h5
Title: Support specifying the pi model in WORKFLOW.md runner config
Description: Add a 'model' field to the runner config section in WORKFLOW.md so users can control which LLM model pi uses. Example: runner.model: claude-3-5-haiku-latest. The runner should append --model <value> to the pi command when spawning agents. This avoids users having to hardcode --model in runner.command and makes it easier to switch models per-project.
Priority: 2
Labels: 

Implement the solution. When done, mark the issue complete:
  bd update symphony-beads-4h5 --status done