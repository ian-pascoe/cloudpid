// @effect-diagnostics asyncFunction:off -- browser code with no Effect runtime: promises are the platform here.
import { sessionCommandsFor } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { type ComposerCommand, resolveCommand, sessionCommands } from "./commands.ts";

const run = () => null;

const commands: readonly ComposerCommand[] = [
  { name: "stop", description: "Stop", argument: "none", run },
  { name: "name", description: "Rename", argument: "required", argumentHint: "<title>", run },
  { name: "model", description: "Model", argument: "optional", argumentHint: "[model]", run },
];

describe("resolving a submitted message against the composer's Slash commands", () => {
  it("runs a known command with its arguments", () => {
    expect(resolveCommand(commands, "/name Fix the build")).toMatchObject({
      kind: "run",
      command: { name: "name" },
      args: "Fix the build",
    });
    expect(resolveCommand(commands, "/model")).toMatchObject({ kind: "run", args: "" });
  });

  it("sends a message that is no command, or one the composer does not know", () => {
    expect(resolveCommand(commands, "hello")).toEqual({ kind: "send" });
    expect(resolveCommand(commands, "/skill:tdd fix it")).toEqual({ kind: "send" });
    expect(resolveCommand(commands, "/tmp/x is gone")).toEqual({ kind: "send" });
  });

  it("refuses a command missing the argument it needs, naming it", () => {
    expect(resolveCommand(commands, "/name")).toEqual({
      kind: "refuse",
      message: "/name needs <title>.",
    });
  });

  it("refuses an argument to a command that takes none", () => {
    expect(resolveCommand(commands, "/stop now")).toEqual({
      kind: "refuse",
      message: "/stop takes no argument.",
    });
  });
});

describe("the Session's Slash commands in the composer", () => {
  it("run through the Session with their arguments, and keep their hints and choices", async () => {
    const calls: string[] = [];

    const [todo, exported] = sessionCommands(
      [
        {
          name: "todo",
          description: "Clear the Todo List",
          argumentHint: "clear",
          argument: "required",
          choices: [{ value: "clear" }],
        },
        { name: "export", description: "Export", argument: "none" },
      ],
      (name, args) => {
        calls.push(`${name}(${args})`);

        return Promise.resolve(name === "todo" ? null : "Not now.");
      },
    );

    expect(todo).toMatchObject({ argumentHint: "clear", choices: [{ value: "clear" }] });
    expect(exported).not.toHaveProperty("argumentHint");
    expect(await todo?.run("clear")).toBeNull();
    expect(await exported?.run("")).toBe("Not now.");
    expect(calls).toEqual(["todo(clear)", "export()"]);
    expect(resolveCommand([todo!], "/todo")).toEqual({
      kind: "refuse",
      message: "/todo needs clear.",
    });
  });

  it("are known without the catalog: a subagent's composer runs /compact and sends /rollover as written", () => {
    const run = () => Promise.resolve(null);
    const child = sessionCommands(sessionCommandsFor(false), run);
    const root = sessionCommands(sessionCommandsFor(true), run);

    expect(resolveCommand(child, "/compact the API")).toMatchObject({
      kind: "run",
      args: "the API",
    });
    expect(resolveCommand(child, "/rollover")).toEqual({ kind: "send" });
    expect(resolveCommand(root, "/rollover")).toMatchObject({ kind: "run", args: "" });
  });
});
