import { describe, expect, it } from "bun:test";
import { parseWorkflow } from "../config.ts";
import { DEFAULT_WORKFLOW } from "./default-workflow.ts";

describe("DEFAULT_WORKFLOW", () => {
  it("before_run includes a valid issue-branch if/else flow", () => {
    const workflow = parseWorkflow(DEFAULT_WORKFLOW);
    const beforeRun = workflow.config.hooks.before_run ?? "";

    expect(beforeRun).toContain(
      "if git rev-parse --verify $SYMPHONY_REMOTE/issue/$SYMPHONY_ISSUE_ID >/dev/null 2>&1; then",
    );
    expect(beforeRun).toContain("else");
    expect(beforeRun).toContain("fi");
  });

  it("after_create fails fast and supports REPO_URL/SYMPHONY_REPO fallback", () => {
    const workflow = parseWorkflow(DEFAULT_WORKFLOW);
    const afterCreate = workflow.config.hooks.after_create ?? "";

    expect(afterCreate).toContain('if [ -n "$REPO_URL" ]; then');
    expect(afterCreate).toContain(
      'elif [ -n "$SYMPHONY_REPO" ] && [ "$SYMPHONY_REPO" != \'$SYMPHONY_REPO\' ]; then',
    );
    expect(afterCreate).toContain('gh repo clone "$SYMPHONY_REPO" .');
    expect(afterCreate).toContain('git clone "https://github.com/$SYMPHONY_REPO.git" .');
    expect(afterCreate).toContain(
      "No repository source configured. Set REPO_URL or workspace.repo.",
    );
    expect(afterCreate).not.toContain("--branch master");
    expect(afterCreate).not.toContain("git clone $REPO_URL . 2>/dev/null || true");
  });
});
