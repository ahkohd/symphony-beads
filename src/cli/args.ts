import type { Args } from "./types.ts";

export const VERSION = "0.1.0";

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
  };

  const positional: string[] = [];
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--workflow":
        args.workflow = argv[++index] ?? "WORKFLOW.md";
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
        args.lines = Number.parseInt(argv[++index] ?? "50", 10);
        if (Number.isNaN(args.lines) || args.lines < 1) {
          args.lines = 50;
        }
        break;
      case "--all":
        args.all = true;
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
          error(`unknown flag: ${arg}`);
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

export function printUsage(): void {
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
  --all            Stop all registered symphony instances`);
}

export function printVersion(json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ version: VERSION }));
  } else {
    console.log(`symphony-beads ${VERSION}`);
  }
}

export function error(message: string): never {
  console.error(`error: ${message}\n`);
  printUsage();
  process.exit(1);
}
