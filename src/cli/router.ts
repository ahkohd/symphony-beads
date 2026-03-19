import type { Args } from "./types.ts";

export type CommandHandler = (args: Args) => Promise<void>;

export interface CommandHandlers {
  start: CommandHandler;
  status: CommandHandler;
  validate: CommandHandler;
  init: CommandHandler;
  instances: CommandHandler;
  doctor: CommandHandler;
  logs: CommandHandler;
  stop: CommandHandler;
  kanban: CommandHandler;
}

export async function routeCommand(
  args: Args,
  handlers: CommandHandlers,
  onError: (message: string) => never,
): Promise<void> {
  switch (args.command) {
    case "start":
      await handlers.start(args);
      return;
    case "status":
      await handlers.status(args);
      return;
    case "validate":
      await handlers.validate(args);
      return;
    case "init":
      await handlers.init(args);
      return;
    case "instances":
      await handlers.instances(args);
      return;
    case "doctor":
      await handlers.doctor(args);
      return;
    case "logs":
      await handlers.logs(args);
      return;
    case "stop":
      await handlers.stop(args);
      return;
    case "kanban":
      await handlers.kanban(args);
      return;
    case "":
      onError("no command specified");
      return;
    default:
      onError(`unknown command: ${args.command}`);
      return;
  }
}
