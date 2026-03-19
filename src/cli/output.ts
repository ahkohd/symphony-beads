import { log } from "../log.ts";
import type { Args } from "./types.ts";

type LogLevel = "info" | "warn" | "error";

interface ExitCommandErrorOptions {
  args: Pick<Args, "json">;
  payload: Record<string, unknown>;
  message: string;
  level?: LogLevel;
  hint?: string;
}

export function printJson(payload: unknown, pretty = false): void {
  if (pretty) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(JSON.stringify(payload));
}

export function exitCommandError(options: ExitCommandErrorOptions): never {
  const { args, payload, message, level = "error", hint } = options;

  if (args.json) {
    printJson(payload);
  } else {
    logAtLevel(level, message);
    if (hint) {
      console.log(hint);
    }
  }

  process.exit(1);
}

export function exitUsageError(message: string, printUsage: () => void): never {
  console.error(`error: ${message}\n`);
  printUsage();
  process.exit(1);
}

function logAtLevel(level: LogLevel, message: string): void {
  switch (level) {
    case "info":
      log.info(message);
      break;
    case "warn":
      log.warn(message);
      break;
    case "error":
      log.error(message);
      break;
  }
}
