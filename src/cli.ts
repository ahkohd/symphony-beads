#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { error, parseArgs } from "./cli/args.ts";
import {
  cmdDoctor,
  cmdInit,
  cmdInstances,
  cmdLogs,
  cmdStart,
  cmdStatus,
  cmdStop,
  cmdTui,
  cmdValidate,
} from "./cli/commands.ts";
import { routeCommand } from "./cli/router.ts";
import type { Args } from "./cli/types.ts";
import { findProjectRoot, resolveConfigPaths } from "./cli/workflow.ts";
import { isJsonMode, log, setJsonMode } from "./log.ts";

function resolveShortFlagAlias(args: Args): void {
  if (!args.shortF) return;

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

function resolveWorkflowFromProjectRoot(args: Args): void {
  if (existsSync(resolve(args.workflow))) {
    return;
  }

  const root = findProjectRoot(process.cwd());
  const candidate = resolve(root, args.workflow);
  if (existsSync(candidate)) {
    args.workflow = candidate;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.json) {
    setJsonMode(true);
  }

  resolveShortFlagAlias(args);
  resolveWorkflowFromProjectRoot(args);

  await routeCommand(
    args,
    {
      start: cmdStart,
      status: cmdStatus,
      validate: cmdValidate,
      init: cmdInit,
      instances: cmdInstances,
      doctor: cmdDoctor,
      logs: cmdLogs,
      stop: cmdStop,
      kanban: async () => cmdTui(),
    },
    error,
  );
}

if (import.meta.main || process.argv[1]?.endsWith("/cli.ts")) {
  main().catch((err) => {
    if (isJsonMode()) {
      console.error(JSON.stringify({ error: String(err) }));
    } else {
      log.error(String(err));
    }
    process.exit(1);
  });
}

export { findProjectRoot, parseArgs, resolveConfigPaths };
