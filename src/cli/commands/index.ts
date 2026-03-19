import type { Args } from "../types.ts";
import { runDoctorCommand } from "./doctor.ts";
import { runInitCommand } from "./init.ts";
import { runInstancesCommand } from "./instances.ts";
import { runKanbanCommand } from "./kanban.ts";
import { runLogsCommand } from "./logs.ts";
import { runStartCommand } from "./start.ts";
import { runStatusCommand } from "./status.ts";
import { runStopCommand } from "./stop.ts";
import { runValidateCommand } from "./validate.ts";

export type CommandHandler = (args: Args) => Promise<void>;

export const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  start: runStartCommand,
  status: runStatusCommand,
  validate: runValidateCommand,
  init: runInitCommand,
  instances: runInstancesCommand,
  doctor: runDoctorCommand,
  logs: runLogsCommand,
  stop: runStopCommand,
  kanban: async () => {
    await runKanbanCommand();
  },
};
