import { existsSync } from "node:fs";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { parseWorkflow } from "../config.ts";
import type { ServiceConfig } from "../types.ts";
import { exitCommandError } from "./output.ts";

export type ParsedWorkflow = ReturnType<typeof parseWorkflow>;

export async function loadWorkflow(path: string, json: boolean): Promise<ParsedWorkflow> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    exitCommandError({
      args: { json },
      payload: { error: "workflow file not found", path },
      message: `workflow file not found: ${path}`,
      hint: "\nRun: symphony init",
    });
  }

  const content = await file.text();
  const workflow = parseWorkflow(content);

  // Resolve relative config paths against the workflow directory so they
  // remain correct when symphony is invoked from a subdirectory.
  resolveConfigPaths(workflow.config, resolve(dirname(path)));

  return workflow;
}

/**
 * Resolve relative paths in the parsed config so they are absolute, anchored
 * to the project root (the directory containing WORKFLOW.md). This makes all
 * downstream consumers (tracker, workspace, lock) independent of cwd.
 */
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

export function resolveWorkflowArg(workflowArg: string): string {
  if (existsSync(resolve(workflowArg))) {
    return workflowArg;
  }

  const root = findProjectRoot(process.cwd());
  const candidate = resolve(root, workflowArg);
  if (existsSync(candidate)) {
    return candidate;
  }

  return workflowArg;
}

function isAbsoluteOrTilde(path: string): boolean {
  return path.startsWith("/") || path.startsWith("~");
}
