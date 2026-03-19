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

  const strictWarningFailure = args.strict && warnings.length > 0;
  const valid = errors.length === 0 && !strictWarningFailure;

  const output = {
    valid,
    strict: args.strict,
    errors,
    warnings,
    config: workflow.config,
    prompt_template_length: workflow.prompt_template.length,
  };

  if (args.json) {
    printJson(output, true);
    if (!valid) {
      process.exit(1);
    }
    return;
  }

  if (valid) {
    log.info("workflow is valid", { file: workflowPath, strict: args.strict });
    console.log(`  tracker:        ${workflow.config.tracker.kind}`);
    console.log(`  project:        ${workflow.config.tracker.project_path}`);
    console.log(`  runner:         ${workflow.config.runner.command}`);
    console.log(`  max_concurrent: ${workflow.config.agent.max_concurrent}`);
    console.log(`  poll_ms:        ${workflow.config.polling.interval_ms}`);
    console.log(`  prompt:         ${workflow.prompt_template.length} chars`);
    printWarningsSummary(warnings, args.strict);

    for (const warning of warnings) {
      log.warn(warning);
    }
    return;
  }

  if (errors.length > 0) {
    log.error("workflow has errors", { file: workflowPath });
    for (const error of errors) {
      console.log(`  - ${error}`);
    }
  } else {
    log.error("workflow has warnings (strict mode)", { file: workflowPath });
    console.log("  strict mode enabled: warnings are treated as errors");
  }

  printWarningsSummary(warnings, args.strict);

  for (const warning of warnings) {
    log.warn(warning);
  }

  process.exit(1);
}

function printWarningsSummary(warnings: string[], strict: boolean): void {
  if (warnings.length === 0) {
    return;
  }

  const hint = strict ? "(strict mode enabled)" : "(use --strict in CI)";
  console.log(`  warnings:       ${warnings.length} ${hint}`);
}
