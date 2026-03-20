import { dirname, join } from "node:path";
import { exec } from "../../exec.ts";
import { log } from "../../log.ts";
import { DEFAULT_WORKFLOW } from "../default-workflow.ts";
import { exitCommandError, printJson } from "../output.ts";
import type { Args } from "../types.ts";

const DOLT_RUNTIME_IGNORE_PATTERNS = [
  "dolt-server.lock",
  "dolt-server.log",
  "dolt-server.pid",
  "dolt-server.port",
] as const;

async function ensureGitignorePatterns(workflowPath: string): Promise<void> {
  const gitignorePath = join(dirname(workflowPath), ".gitignore");
  const file = Bun.file(gitignorePath);
  const current = (await file.exists()) ? await file.text() : "";

  const lines = current.split(/\r?\n/).filter((line) => line.length > 0);
  const existing = new Set(lines);

  const missingPatterns = DOLT_RUNTIME_IGNORE_PATTERNS.filter((pattern) => !existing.has(pattern));
  if (missingPatterns.length === 0) {
    return;
  }

  const hasDoltComment = existing.has("# Dolt server runtime artifacts");
  const sectionLines = [
    ...(hasDoltComment ? [] : ["# Dolt server runtime artifacts"]),
    ...missingPatterns,
  ];

  let next = current;
  if (next.length > 0 && !next.endsWith("\n")) {
    next += "\n";
  }
  if (next.length > 0 && !next.endsWith("\n\n")) {
    next += "\n";
  }

  next += `${sectionLines.join("\n")}\n`;
  await Bun.write(gitignorePath, next);
}

export async function runInitCommand(args: Args): Promise<void> {
  const path = args.workflow;
  const file = Bun.file(path);

  if (await file.exists()) {
    exitCommandError({
      args,
      payload: { error: "file already exists", path },
      message: `${path} already exists`,
    });
  }

  await Bun.write(path, DEFAULT_WORKFLOW);
  await ensureGitignorePatterns(path);

  // Configure the 'review' custom status in beads so agents can use it.
  // This status is intentionally NOT in active_states or terminal_states,
  // causing the orchestrator to stop the agent while preserving the workspace.
  const configResult = await exec(["bd", "config", "set", "status.custom", "review"], {
    cwd: process.cwd(),
  });
  const reviewConfigured = configResult.code === 0;

  if (args.json) {
    printJson({ created: path, review_status_configured: reviewConfigured });
    return;
  }

  log.info("created workflow file", { path });

  if (reviewConfigured) {
    log.info("configured beads custom status: review");
    return;
  }

  log.warn(
    "could not configure 'review' custom status — run: bd config set status.custom \"review\"",
  );
}
