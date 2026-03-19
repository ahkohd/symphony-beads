import { dirname, resolve } from "node:path";
import { exitCommandError } from "../output.ts";
import type { Args } from "../types.ts";
import { loadWorkflow } from "../workflow.ts";

export async function runLogsCommand(args: Args): Promise<void> {
  const workflow = await loadWorkflow(args.workflow, args.json);
  const logFile = workflow.config.log.file;

  if (!logFile) {
    exitCommandError({
      args,
      payload: {
        error: "no_log_file",
        message: "no log file configured in WORKFLOW.md (log.file)",
      },
      message: "no log file configured in WORKFLOW.md (log.file)",
    });
  }

  const resolvedPath = resolve(dirname(args.workflow), logFile);
  const file = Bun.file(resolvedPath);

  if (!(await file.exists())) {
    exitCommandError({
      args,
      payload: {
        error: "log_file_not_found",
        path: resolvedPath,
      },
      message: `log file not found: ${resolvedPath}`,
    });
  }

  const content = await file.text();
  const lines = content.split("\n");

  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const startIndex = Math.max(0, lines.length - args.lines);
  const tailLines = lines.slice(startIndex);

  for (const line of tailLines) {
    if (line.trim()) {
      console.log(line);
    }
  }

  if (!args.follow) {
    return;
  }

  await followLogs(resolvedPath, content.length);
}

async function followLogs(path: string, initialOffset: number): Promise<void> {
  let offset = initialOffset;
  const { watch } = await import("node:fs");

  const printNewContent = async () => {
    try {
      const file = Bun.file(path);
      const size = file.size;

      if (size <= offset) {
        if (size < offset) {
          offset = 0;
        }
        return;
      }

      const chunk = await file.slice(offset, size).text();
      offset = size;

      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          console.log(line);
        }
      }
    } catch {
      // File might be rotated or removed; ignore and retry on next event/poll.
    }
  };

  const watcher = watch(path, () => {
    void printNewContent();
  });

  const pollInterval = setInterval(() => {
    void printNewContent();
  }, 1000);

  const cleanup = () => {
    watcher.close();
    clearInterval(pollInterval);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep the process alive while follow mode is active.
  await new Promise(() => {});
}
