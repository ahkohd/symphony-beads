import { existsSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parseWorkflow } from "../config.ts";
import { isJsonMode, log } from "../log.ts";
import type { ServiceConfig } from "../types.ts";

export async function loadWorkflow(path: string): Promise<ReturnType<typeof parseWorkflow>> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    if (isJsonMode()) {
      console.log(JSON.stringify({ error: "workflow file not found", path }));
    } else {
      log.error(`workflow file not found: ${path}`);
      console.log("\nRun: symphony init");
    }
    process.exit(1);
  }

  const content = await file.text();
  const workflow = parseWorkflow(content);
  resolveConfigPaths(workflow.config, resolve(dirname(path)));
  return workflow;
}

export function resolveConfigPaths(config: ServiceConfig, projectRoot: string): void {
  if (!isAbsoluteOrTilde(config.workspace.root)) {
    config.workspace.root = resolve(projectRoot, config.workspace.root);
  }

  if (!isAbsoluteOrTilde(config.tracker.project_path)) {
    config.tracker.project_path = resolve(projectRoot, config.tracker.project_path);
  }

  if (config.log.file && !isAbsoluteOrTilde(config.log.file)) {
    config.log.file = resolve(projectRoot, config.log.file);
  }
}

function isAbsoluteOrTilde(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~");
}

/**
 * Walk up from startDir looking for a project root marker (.git, .jj, or
 * WORKFLOW.md). Returns the directory containing the first marker found,
 * or startDir itself if no marker is found.
 */
export function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  while (true) {
    if (
      existsSync(join(dir, ".git")) ||
      existsSync(join(dir, ".jj")) ||
      existsSync(join(dir, "WORKFLOW.md"))
    ) {
      return dir;
    }

    const parent = parsePath(dir).dir;
    if (parent === dir) {
      return resolve(startDir);
    }

    dir = parent;
  }
}
