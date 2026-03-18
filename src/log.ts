// ---------------------------------------------------------------------------
// Structured logging. Plain text by default, JSON when --json is active.
// Supports writing to a per-project log file in addition to stdout/stderr.
// ---------------------------------------------------------------------------

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

let jsonMode = false;
let logFilePath: string | null = null;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/**
 * Set a file path for log output. All log entries will be appended to this
 * file in addition to stdout/stderr. Useful for per-project log isolation.
 */
export async function setLogFile(path: string): Promise<void> {
  logFilePath = path;
  // Ensure parent directory exists
  await mkdir(dirname(path), { recursive: true });
}

interface LogEntry {
  level: "info" | "warn" | "error" | "debug";
  msg: string;
  [key: string]: unknown;
}

function emit(entry: LogEntry): void {
  const ts = new Date().toISOString();

  if (jsonMode) {
    const out = JSON.stringify({ ts, ...entry });
    if (entry.level === "error") {
      process.stderr.write(`${out}\n`);
    } else {
      process.stdout.write(`${out}\n`);
    }
    writeToFile(`${out}\n`);
    return;
  }

  const prefix = prefixFor(entry.level);
  const extra = Object.keys(entry)
    .filter((k) => k !== "level" && k !== "msg")
    .map((k) => `${k}=${JSON.stringify(entry[k])}`)
    .join(" ");

  const line = extra ? `${prefix} ${entry.msg}  ${extra}` : `${prefix} ${entry.msg}`;

  if (entry.level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }

  // Also write to file with timestamp prefix
  writeToFile(`${ts} ${line}\n`);
}

function writeToFile(data: string): void {
  if (!logFilePath) return;
  // Fire-and-forget — don't block log emission
  appendFile(logFilePath, data).catch(() => {});
}

function prefixFor(level: string): string {
  switch (level) {
    case "error":
      return "[error]";
    case "warn":
      return "[warn] ";
    case "debug":
      return "[debug]";
    default:
      return "[info] ";
  }
}

export const log = {
  info(msg: string, extra?: Record<string, unknown>): void {
    emit({ level: "info", msg, ...extra });
  },
  warn(msg: string, extra?: Record<string, unknown>): void {
    emit({ level: "warn", msg, ...extra });
  },
  error(msg: string, extra?: Record<string, unknown>): void {
    emit({ level: "error", msg, ...extra });
  },
  debug(msg: string, extra?: Record<string, unknown>): void {
    emit({ level: "debug", msg, ...extra });
  },
};
