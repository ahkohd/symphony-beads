You are working on a Beads issue.

Issue: symphony-beads-raa
Title: Add git clone/sync hooks to default WORKFLOW.md template
Description: Per spec section 9.3, workspace population is implementation-defined via hooks. We need:
1. after_create hook: git clone the repo into the workspace (runs once)
2. before_run hook: git fetch + create/reset issue branch (runs each attempt)
3. after_run hook: optional cleanup
The init subcommand should generate a WORKFLOW.md with these hooks pre-configured, using a $REPO_URL env var. Depends on: multiline YAML parser support.
Priority: 1
Labels: 

Implement the solution. When done, mark the issue complete:
  bd update symphony-beads-raa --status done