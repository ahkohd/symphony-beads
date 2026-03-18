// ---------------------------------------------------------------------------
// Workspace manager — per-issue isolated directories
// ---------------------------------------------------------------------------

import { join, resolve } from "path";
import { mkdir, rm } from "fs/promises";
import type { ServiceConfig, Workspace } from "./types.ts";
import { exec } from "./exec.ts";
import { log } from "./log.ts";

export class WorkspaceManager {
  private root: string;
  private hooks: ServiceConfig["hooks"];

  constructor(config: ServiceConfig) {
    this.root = resolve(config.workspace.root);
    this.hooks = config.hooks;
  }

  /** Create or reuse a workspace directory for an issue. */
  async ensure(identifier: string): Promise<Workspace> {
    const key = sanitize(identifier);
    const path = join(this.root, key);
    this.assertInRoot(path);

    let created = false;
    try {
      await mkdir(path, { recursive: true });
      // mkdir with recursive doesn't tell us if it was new, so stat the dir
      // We treat it as "created" the first time we see a marker file missing.
      const marker = Bun.file(join(path, ".symphony-init"));
      if (!(await marker.exists())) {
        await Bun.write(marker, new Date().toISOString());
        created = true;
      }
    } catch (err) {
      log.error("workspace creation failed", { path, error: String(err) });
      throw err;
    }

    if (created && this.hooks.after_create) {
      const ok = await this.runHook("after_create", path, this.hooks.after_create);
      if (!ok) {
        // Fatal — clean up partially created workspace
        await rm(path, { recursive: true, force: true }).catch(() => {});
        throw new Error(`after_create hook failed for ${identifier}`);
      }
    }

    return { path, key, created };
  }

  /** Remove a workspace directory. Runs before_remove hook first. */
  async remove(identifier: string): Promise<void> {
    const key = sanitize(identifier);
    const path = join(this.root, key);

    try {
      const stat = await Bun.file(join(path, ".symphony-init")).exists();
      if (!stat) return;
    } catch {
      return;
    }

    if (this.hooks.before_remove) {
      await this.runHook("before_remove", path, this.hooks.before_remove);
      // Failure is logged but ignored per spec
    }

    await rm(path, { recursive: true, force: true }).catch((err) => {
      log.warn("failed to remove workspace", { path, error: String(err) });
    });
  }

  /** Run before_run hook. Returns false on failure. */
  async beforeRun(path: string): Promise<boolean> {
    if (!this.hooks.before_run) return true;
    return this.runHook("before_run", path, this.hooks.before_run);
  }

  /** Run after_run hook. Failure is logged and ignored. */
  async afterRun(path: string): Promise<void> {
    if (!this.hooks.after_run) return;
    await this.runHook("after_run", path, this.hooks.after_run);
  }

  /** Resolve workspace path without creating. */
  pathFor(identifier: string): string {
    return join(this.root, sanitize(identifier));
  }

  // -- Private ---------------------------------------------------------------

  private assertInRoot(path: string): void {
    const abs = resolve(path);
    if (!abs.startsWith(this.root + "/") && abs !== this.root) {
      throw new Error(`workspace path escapes root: ${abs}`);
    }
  }

  private async runHook(name: string, cwd: string, script: string): Promise<boolean> {
    log.debug("running hook", { hook: name, cwd });
    const result = await exec(["sh", "-lc", script], {
      cwd,
      timeout: this.hooks.timeout_ms,
    });
    if (result.code !== 0) {
      log.warn("hook failed", {
        hook: name,
        code: result.code,
        stderr: result.stderr.slice(0, 500),
      });
      return false;
    }
    return true;
  }
}

/** Only [A-Za-z0-9._-] allowed in workspace directory names. */
function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}