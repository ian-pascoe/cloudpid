// The Slash commands the composer runs itself, rather than sending as a message, and how a submitted message resolves
// against them.

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over native arrays, not combinators.

import type { CatalogCommand } from "@cloudpid/protocol";
import type * as Types from "effect/Types";
import { parseCommand } from "./completion.ts";

/** A value a command's argument can take, offered in the menu once the command's name is typed. */
export type CommandChoice = {
  readonly value: string;
  readonly description?: string | undefined;
};

/** A Slash command the composer runs. */
export type ComposerCommand = {
  /** Its name, without the `/`. */
  readonly name: string;
  readonly description: string;
  /** Shown after the name: `<title>` for a required argument, `[model]` for an optional one. */
  readonly argumentHint?: string;
  readonly argument: "none" | "optional" | "required";
  /** The values its argument can take; picking one runs the command with it. */
  readonly choices?: readonly CommandChoice[];
  /** Run it with its arguments (trimmed, "" when none): null when it worked, or why it did not. */
  readonly run: (args: string) => string | null | Promise<string | null>;
};

/** What to do with a submitted message: send it, run a command, or refuse it saying why. */
export type Resolution =
  | { readonly kind: "send" }
  | { readonly kind: "run"; readonly command: ComposerCommand; readonly args: string }
  | { readonly kind: "refuse"; readonly message: string };

/**
 * How `text` resolves against `commands`. A `/name` the composer does not know is sent as written: the Session may know
 * it (a Prompt template, a Skill), and otherwise the model reads it like any message.
 */
export const resolveCommand = (commands: readonly ComposerCommand[], text: string): Resolution => {
  const call = parseCommand(text);
  const command = call === null ? undefined : commands.find(({ name }) => name === call.name);

  if (call === null || command === undefined) return { kind: "send" };

  if (command.argument === "required" && call.args === "") {
    return {
      kind: "refuse",
      message: `/${command.name} needs ${command.argumentHint ?? "an argument"}.`,
    };
  }

  if (command.argument === "none" && call.args !== "") {
    return { kind: "refuse", message: `/${command.name} takes no argument.` };
  }

  return { kind: "run", command, args: call.args };
};

/**
 * The Session's own Slash commands (`/compact`, `/rollover`, `/todo`, `/export`) as the composer offers them: each runs
 * through `run`, which resolves to null when it worked or to why it did not.
 */
export const sessionCommands = (
  commands: readonly CatalogCommand[],
  run: (name: string, args: string) => Promise<string | null>,
): ComposerCommand[] =>
  commands.map((command) => {
    const composer: Types.Mutable<ComposerCommand> = {
      name: command.name,
      description: command.description,
      argument: command.argument,
      run: (args) => run(command.name, args),
    };

    if (command.argumentHint !== undefined) composer.argumentHint = command.argumentHint;

    if (command.choices !== undefined) composer.choices = command.choices;

    return composer;
  });
