---
tracker:
  kind: beads
  project_path: "."
workspace:
  root: ./workspaces
agent:
  max_concurrent: 5
  max_turns: 3
runner:
  command: pi -p --no-session
  turn_timeout_ms: 7200000
  stall_timeout_ms: 7200000
polling:
  interval_ms: 60000
---

You are working on a Beads issue.

Issue: {{ issue.identifier }}
Title: {{ issue.title }}
Description: {{ issue.description }}
Priority: {{ issue.priority }}
Labels: {{ issue.labels }}

Implement the solution. When done, mark the issue complete:
  bd update {{ issue.identifier }} --status done
