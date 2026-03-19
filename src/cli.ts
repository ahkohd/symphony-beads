#!/usr/bin/env bun

// ---------------------------------------------------------------------------
// Symphony CLI — Beads Edition
//
// Subcommands:
//   start     Start the orchestrator (daemonizes by default; -f for foreground)
//   status    Show current issue status from beads
//   validate  Validate WORKFLOW.md
//   init      Initialize a new WORKFLOW.md
//   instances List all running symphony instances
//   doctor    Verify dependencies, config, and runtime state
//   logs      Tail the symphony log file
//   stop      Stop a running symphony instance
//
// Global flags:
//   --json           JSON output
//   --workflow PATH  Path to WORKFLOW.md (default: ./WORKFLOW.md)
//   --verbose        Verbose logging
//   -h, --help       Show help
//   -v, --version    Show version
// ---------------------------------------------------------------------------

import { COMMAND_HANDLERS } from "./cli/commands/index.ts";
import { exitUsageError, printJson } from "./cli/output.ts";
import type { Args } from "./cli/types.ts";
import { resolveWorkflowArg } from "./cli/workflow.ts";
import { isJsonMode, log, setJsonMode } from "./log.ts";

const VERSION = "0.1.0";

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "",
    json: false,
    workflow: "WORKFLOW.md",
    verbose: false,
    foreground: false,
    follow: false,
    shortF: false,
    lines: 50,
    all: false,
    instanceId: null,
    strict: false,
    fix: false,
  };

  const positional: string[] = [];
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--workflow":
        args.workflow = argv[++i] ?? "WORKFLOW.md";
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--foreground":
        args.foreground = true;
        break;
      case "-f":
        args.shortF = true;
        break;
      case "--follow":
        args.follow = true;
        break;
      case "--lines":
      case "-n":
        args.lines = parseInt(argv[++i] ?? "50", 10);
        if (Number.isNaN(args.lines) || args.lines < 1) {
          args.lines = 50;
        }
        break;
      case "--all":
        args.all = true;
        break;
      case "--id": {
        const value = argv[++i];
        if (!value) {
          exitUsageError("missing value for --id", printUsage);
        }
        args.instanceId = value;
        break;
      }
      case "--strict":
        args.strict = true;
        break;
      case "--fix":
        args.fix = true;
        break;
      case "-h":
      case "--help":
        help = true;
        break;
      case "-v":
      case "--version":
        version = true;
        break;
      default:
        if (arg.startsWith("-")) {
          exitUsageError(`unknown flag: ${arg}`, printUsage);
        }
        positional.push(arg);
    }
  }

  if (help) {
    printUsage();
    process.exit(0);
  }

  if (version) {
    printVersion(args.json);
    process.exit(0);
  }

  args.command = positional[0] ?? "";
  return args;
}

function applyShortFlags(args: Args): void {
  if (!args.shortF) {
    return;
  }

  if (args.command === "start") {
    args.foreground = true;
    return;
  }

  if (args.command === "logs") {
    args.follow = true;
    return;
  }

  args.foreground = true;
}

function printUsage(): void {
  console.log(`symphony-beads ${VERSION}

Usage: symphony <command> [flags]

Commands:
  start      Start the orchestrator (daemonizes by default)
  status     Show current issue status from beads
  validate   Validate WORKFLOW.md configuration
  init       Create a new WORKFLOW.md
  instances  List all running symphony instances
  doctor     Verify dependencies, config, and runtime state
  logs       Tail the symphony log file
  stop       Stop a running symphony instance
  kanban     Interactive kanban board

Flags:
  --json           Output as JSON
  --workflow PATH   Workflow file (default: WORKFLOW.md)
  --verbose         Verbose output
  -h, --help        Show this help
  -v, --version     Show version

Start flags:
  -f, --foreground  Run in foreground (don't daemonize)

Logs flags:
  -f, --follow     Follow the log file (like tail -f)
  -n, --lines N    Number of lines to show (default: 50)

Stop flags:
  --all            Stop all registered symphony instances
  --id ID          Stop a specific running instance by ID (see: symphony instances)

Validate flags:
  --strict         Treat warnings as errors (non-zero exit)

Doctor flags:
  --fix            Apply safe automatic repairs before running checks`);
}

function printVersion(json: boolean): void {
  if (json) {
    printJson({ version: VERSION });
    return;
  }

  console.log(`symphony-beads ${VERSION}`);
}

async function runCommand(args: Args): Promise<void> {
  if (!args.command) {
    exitUsageError("no command specified", printUsage);
  }

  const handler = COMMAND_HANDLERS[args.command];
  if (!handler) {
    exitUsageError(`unknown command: ${args.command}`, printUsage);
  }

  await handler(args);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.json) {
    setJsonMode(true);
  }

  applyShortFlags(args);
  args.workflow = resolveWorkflowArg(args.workflow);

  await runCommand(args);
}

if (import.meta.main || process.argv[1]?.endsWith("/cli.ts")) {
  main().catch((error) => {
    if (isJsonMode()) {
      console.error(JSON.stringify({ error: String(error) }));
    } else {
      log.error(String(error));
    }
    process.exit(1);
  });
}

export { findProjectRoot, resolveConfigPaths } from "./cli/workflow.ts";
