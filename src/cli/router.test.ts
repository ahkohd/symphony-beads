import { describe, expect, test } from "bun:test";
import { routeCommand } from "./router.ts";
import type { Args } from "./types.ts";

function makeArgs(command: string): Args {
  return {
    command,
    json: false,
    workflow: "WORKFLOW.md",
    verbose: false,
    foreground: false,
    follow: false,
    shortF: false,
    lines: 50,
    all: false,
  };
}

describe("routeCommand", () => {
  test("routes known command handlers", async () => {
    const called: string[] = [];

    await routeCommand(
      makeArgs("status"),
      {
        start: async () => {
          called.push("start");
        },
        status: async () => {
          called.push("status");
        },
        validate: async () => {
          called.push("validate");
        },
        init: async () => {
          called.push("init");
        },
        instances: async () => {
          called.push("instances");
        },
        doctor: async () => {
          called.push("doctor");
        },
        logs: async () => {
          called.push("logs");
        },
        stop: async () => {
          called.push("stop");
        },
        kanban: async () => {
          called.push("kanban");
        },
      },
      (message) => {
        throw new Error(message);
      },
    );

    expect(called).toEqual(["status"]);
  });

  test("delegates unknown commands to the shared error handler", async () => {
    await expect(
      routeCommand(
        makeArgs("nope"),
        {
          start: async () => {},
          status: async () => {},
          validate: async () => {},
          init: async () => {},
          instances: async () => {},
          doctor: async () => {},
          logs: async () => {},
          stop: async () => {},
          kanban: async () => {},
        },
        (message) => {
          throw new Error(message);
        },
      ),
    ).rejects.toThrow("unknown command: nope");
  });
});
