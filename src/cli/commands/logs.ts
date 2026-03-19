import { resolve } from "node:path";
import { exitCommandError, printJson } from "../output.ts";
import type { Args } from "../types.ts";
import { loadWorkflow } from "../workflow.ts";

interface LogsOutput {
  path: string;
  total_lines: number;
  shown_lines: number;
  follow: boolean;
  lines: string[];
}

export async function runLogsCommand(args: Args): Promise<void> {
  if (args.json && args.follow) {
    exitCommandError({
      args,
      payload: {
        error: "json_follow_not_supported",
        message: "--json cannot be combined with --follow for logs",
      },
      message: "--json cannot be combined with --follow for logs",
      hint: "Use either: symphony logs --json OR symphony logs -f",
    });
  }

  const workflowPath = resolve(args.workflow);
  const workflow = await loadWorkflow(workflowPath, args.json);
  const logFile = workflow.config.log.file;

  if (!logFile) {
    exitCommandError({
      args,
      payload: {
        error: "no_log_file",
        workflow_file: workflowPath,
        message: "no log file configured in WORKFLOW.md (log.file)",
      },
      message: "no log file configured in WORKFLOW.md (log.file)",
    });
  }

  const resolvedPath = resolve(logFile);
  const file = Bun.file(resolvedPath);

  if (!(await file.exists())) {
    exitCommandError({
      args,
      payload: {
        error: "log_file_not_found",
        workflow_file: workflowPath,
        path: resolvedPath,
      },
      message: `log file not found: ${resolvedPath}`,
    });
  }

  const content = await file.text();
  const lines = splitLines(content);
  const startIndex = Math.max(0, lines.length - args.lines);
  const tailLines = lines.slice(startIndex);

  if (args.json) {
    const payload: LogsOutput = {
      path: resolvedPath,
      total_lines: lines.length,
      shown_lines: tailLines.length,
      follow: false,
      lines: tailLines,
    };
    printJson(payload, true);
    return;
  }

  console.log(`==> ${resolvedPath} <==`);
  if (tailLines.length === 0) {
    console.log("(log is empty)");
  } else {
    for (const line of tailLines) {
      console.log(line);
    }
  }

  if (!args.follow) {
    return;
  }

  console.log("-- following (Ctrl+C to stop) --");
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
        console.log(line);
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

function splitLines(content: string): string[] {
  const lines = content.split("\n");

  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}
