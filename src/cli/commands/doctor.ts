import { runDoctor } from "../../doctor.ts";
import { printJson } from "../output.ts";
import type { Args } from "../types.ts";

export async function runDoctorCommand(args: Args): Promise<void> {
  const report = await runDoctor(args.workflow);

  if (args.json) {
    printJson(report, true);
  } else {
    console.log("");
    const maxName = Math.max(...report.checks.map((check) => check.name.length));

    for (const check of report.checks) {
      const status = check.ok ? "ok  " : "FAIL";
      const paddedName = check.name.padEnd(maxName);
      console.log(`  ${paddedName}  ${status}  ${check.detail}`);
    }

    console.log("");
    if (report.ok) {
      console.log("  All checks passed.");
    } else {
      const failedCount = report.checks.filter((check) => !check.ok).length;
      console.log(`  ${failedCount} check(s) failed.`);
    }
    console.log("");
  }

  if (!report.ok) {
    process.exit(1);
  }
}
