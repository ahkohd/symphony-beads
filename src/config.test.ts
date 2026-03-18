import { describe, expect, it } from "bun:test";
import { parseWorkflow } from "./config.ts";

describe("parseWorkflow YAML pipe strings", () => {
  it("parses basic pipe (|) multiline hook", () => {
    const content = `---
hooks:
  after_create: |
    git clone $REPO_URL .
    npm install
---

Prompt text here.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\nnpm install\n");
  });

  it("parses pipe-strip (|-) without trailing newline", () => {
    const content = `---
hooks:
  after_create: |-
    git clone $REPO_URL .
    npm install
---

Prompt text here.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\nnpm install");
  });

  it("parses pipe-keep (|+) preserving trailing blank lines", () => {
    const content = `---
hooks:
  after_create: |+
    git clone $REPO_URL .
    npm install

---

Prompt text here.
`;
    const wf = parseWorkflow(content);
    // |+ keeps trailing empty lines plus final newline
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\nnpm install\n\n");
  });

  it("parses multiple pipe hooks", () => {
    const content = `---
hooks:
  after_create: |
    git clone $REPO_URL .
    npm install
  before_run: |
    git fetch origin
    git checkout -B issue-branch
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\nnpm install\n");
    expect(wf.config.hooks.before_run).toBe("git fetch origin\ngit checkout -B issue-branch\n");
  });

  it("still parses single-line values correctly", () => {
    const content = `---
hooks:
  after_create: echo hello
  timeout_ms: 30000
workspace:
  root: ./workspaces
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("echo hello");
    expect(wf.config.hooks.timeout_ms).toBe(30000);
    expect(wf.config.workspace.root).toContain("workspaces");
  });

  it("handles pipe block with empty lines in the middle", () => {
    const content = `---
hooks:
  after_create: |
    echo "step 1"

    echo "step 2"
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe('echo "step 1"\n\necho "step 2"\n');
  });

  it("handles pipe followed by another section", () => {
    const content = `---
hooks:
  after_create: |
    git clone $REPO_URL .
agent:
  max_concurrent: 3
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBe("git clone $REPO_URL .\n");
    expect(wf.config.agent.max_concurrent).toBe(3);
  });

  it("returns null for hooks not specified", () => {
    const content = `---
hooks:
  timeout_ms: 5000
---

Prompt.
`;
    const wf = parseWorkflow(content);
    expect(wf.config.hooks.after_create).toBeNull();
    expect(wf.config.hooks.before_run).toBeNull();
  });
});
