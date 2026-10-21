import { describe, expect, it } from "vitest";
import { type ComposerCommand, resolveCommand } from "./commands.ts";

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
