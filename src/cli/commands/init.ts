import { exec } from "../../exec.ts";
import { log } from "../../log.ts";
import { DEFAULT_WORKFLOW } from "../default-workflow.ts";
import { exitCommandError, printJson } from "../output.ts";
import type { Args } from "../types.ts";

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
