You are working on a Beads issue.

Issue: symphony-beads-f08
Title: Support running multiple symphony instances on one machine for different projects
Description: Currently symphony assumes a single project. We need to support running multiple instances on the same computer for different projects without conflicts. Consider: 1) workspace root isolation per project, 2) PID file or lock to prevent duplicate instances for the same project, 3) unique log paths per project, 4) a top-level 'symphony-multi' or similar that can manage N projects from one config, 5) port conflicts if HTTP server is added later. The simplest approach may be to just ensure the service is self-contained per WORKFLOW.md and document how to run multiple via tmux/systemd. But also check for conflicts like workspace root collisions.
Priority: 1
Labels: 

Implement the solution. When done, mark the issue complete:
  bd update symphony-beads-f08 --status done