You are working on a Beads issue.

Issue: symphony-beads-p09
Title: YAML parser: support multiline pipe strings for hook scripts
Description: Per spec section 5.3.4, hooks are multiline shell script strings. Our YAML parser only handles single-line values. It needs to support YAML pipe syntax (|) so hooks like after_create can contain multi-line shell scripts. Example:
hooks:
  after_create: |
    git clone $REPO_URL .
    npm install
Without this, hooks are limited to one-liners which makes git setup impractical.
Priority: 1
Labels: 

Implement the solution. When done, mark the issue complete:
  bd update symphony-beads-p09 --status done