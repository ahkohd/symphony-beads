import { listInstances } from "../../lock.ts";
import { printJson } from "../output.ts";
import type { Args } from "../types.ts";

export async function runInstancesCommand(args: Args): Promise<void> {
  const instances = await listInstances();

  if (args.json) {
    printJson({ instances }, true);
    return;
  }

  if (instances.length === 0) {
    console.log("No running symphony instances.");
    return;
  }

  console.log(`Running symphony instances (${instances.length}):\n`);

  for (const instance of instances) {
    console.log(`  PID:        ${instance.pid}`);
    console.log(`  Project:    ${instance.project_path}`);
    console.log(`  Workspace:  ${instance.workspace_root}`);
    console.log(`  Workflow:   ${instance.workflow_file}`);
    console.log(`  Started:    ${instance.started_at}`);
    console.log("");
  }
}
