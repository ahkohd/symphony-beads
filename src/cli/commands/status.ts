import { BeadsTracker } from "../../tracker.ts";
import { printJson } from "../output.ts";
import type { Args } from "../types.ts";
import { loadWorkflow } from "../workflow.ts";

export async function runStatusCommand(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow, args.json);
  const tracker = new BeadsTracker(workflow.config);

  const candidates = await tracker.fetchCandidates();
  const terminalIds = await tracker.fetchTerminalIds();

  const output = {
    candidates: candidates.length,
    terminal: terminalIds.length,
    issues: candidates.map((issue) => ({
      id: issue.id,
      title: issue.title,
      state: issue.state,
      priority: issue.priority,
    })),
  };

  if (args.json) {
    printJson(output, true);
    return;
  }

  for (const issue of output.issues) {
    console.log(`  ${issue.id}  P${issue.priority ?? "-"}  [${issue.state}]  ${issue.title}`);
  }

  if (output.issues.length === 0) {
    console.log("  (no active issues)");
  }
}
