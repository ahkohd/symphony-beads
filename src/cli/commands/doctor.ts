import { type DoctorFixReport, runDoctor, runDoctorFix } from "../../doctor.ts";
import { exitCommandError, printJson } from "../output.ts";
import type { Args } from "../types.ts";

export async function runDoctorCommand(args: Args): Promise<void> {
  if (args.dryRun && !args.fix) {
    exitCommandError({
      args,
      payload: {
        error: "doctor_flag_conflict",
        message: "--dry-run requires --fix",
      },
      message: "--dry-run requires --fix",
      hint: "Use: symphony doctor --fix --dry-run",
    });
  }

  const fixReport = args.fix ? await runDoctorFix(args.workflow, { dryRun: args.dryRun }) : null;
  const report = await runDoctor(args.workflow);

  if (args.json) {
    if (fixReport) {
      printJson({ ...report, fix: fixReport }, true);
    } else {
      printJson(report, true);
    }
  } else {
    if (fixReport) {
      printFixSummary(fixReport);
    }

    console.log("");
    const maxName = Math.max(...report.checks.map((check) => check.name.length));

    for (const check of report.checks) {
      const status = check.ok ? "ok  " : "FAIL";
      const paddedName = check.name.padEnd(maxName);
      console.log(`  ${paddedName}  ${status}  ${check.detail}`);

      for (const hint of check.hints ?? []) {
        console.log(`    hint: ${hint}`);
      }
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

  if (!report.ok || (fixReport !== null && !fixReport.ok)) {
    process.exit(1);
  }
}

function printFixSummary(fixReport: DoctorFixReport): void {
  console.log("");
  console.log(`  doctor --fix actions${fixReport.dry_run ? " (dry-run)" : ""}:`);

  for (const action of fixReport.actions) {
    const status = action.ok
      ? fixReport.dry_run && action.would_change
        ? "would-fix"
        : action.changed
          ? "fixed"
          : "ok"
      : "FAIL";
    console.log(`    ${action.name}: ${status} — ${action.detail}`);
  }

  if (fixReport.dry_run) {
    console.log(`  doctor --fix would change ${fixReport.would_change} action(s)`);
    return;
  }

  console.log(`  doctor --fix changed ${fixReport.changed} action(s)`);
}
