You are working on a Beads issue.

Issue: symphony-beads-1t6
Title: Watch WORKFLOW.md for changes and hot-reload config
Description: Per spec section 6.2: Dynamic reload is required. The service should watch WORKFLOW.md for changes, re-read and re-apply config and prompt template without restart. Reloaded config applies to future dispatch, retry scheduling, reconciliation, hook execution, and agent launches. In-flight sessions are not required to restart. Invalid reloads must not crash the service — keep last known good config and log the error. Use Bun file watcher or poll-based detection.
Priority: 2
Labels: 

Implement the solution. When done, mark the issue complete:
  bd update symphony-beads-1t6 --status done