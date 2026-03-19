import { dirname, resolve } from "node:path";
import { findUnknownWorkflowKeys, validateConfig } from "../../config.ts";
import { checkWorkspaceCollisions } from "../../lock.ts";
import { log } from "../../log.ts";
import { printJson } from "../output.ts";
import type { Args } from "../types.ts";
import { loadWorkflow } from "../workflow.ts";

export async function runValidateCommand(args: Args): Promise<void> {
  const workflowPath = resolve(args.workflow);
  const workflow = await loadWorkflow(workflowPath, args.json);
  const errors = validateConfig(workflow.config);

  const projectDir = resolve(dirname(workflowPath));
  const workspaceRoot = resolve(workflow.config.workspace.root);
  const conflicts = await checkWorkspaceCollisions(projectDir, workspaceRoot);

  const source = await Bun.file(workflowPath).text();
  const warnings = findUnknownWorkflowKeys(source);

  for (const conflict of conflicts) {
    warnings.push(
      `workspace root collision: "${workspaceRoot}" is also used by project "${conflict.project_path}" (PID ${conflict.pid})`,
    );
  }

  const output = {
    valid: errors.length === 0,
    errors,
    warnings,
    config: workflow.config,
    prompt_template_length: workflow.prompt_template.length,
  };

  if (args.json) {
    printJson(output, true);
    return;
  }

  if (errors.length === 0) {
    log.info("workflow is valid", { file: workflowPath });
    console.log(`  tracker:        ${workflow.config.tracker.kind}`);
    console.log(`  project:        ${workflow.config.tracker.project_path}`);
    console.log(`  runner:         ${workflow.config.runner.command}`);
    console.log(`  max_concurrent: ${workflow.config.agent.max_concurrent}`);
    console.log(`  poll_ms:        ${workflow.config.polling.interval_ms}`);
    console.log(`  prompt:         ${workflow.prompt_template.length} chars`);

    for (const warning of warnings) {
      log.warn(warning);
    }
    return;
  }

  log.error("workflow has errors", { file: workflowPath });
  for (const error of errors) {
    console.log(`  - ${error}`);
  }
  for (const warning of warnings) {
    log.warn(warning);
  }

  process.exit(1);
}
