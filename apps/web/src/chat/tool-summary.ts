import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

/** The longest summary shown, in characters. */
const MAX_LENGTH = 80;

/** A call's arguments, as the page receives them. */
type Args = ToolCallMessagePartProps["args"];

const text = (args: Args, key: string): Option.Option<string> =>
  Option.liftPredicate(args[key], Predicate.isString).pipe(Option.filter((value) => value !== ""));

const clip = (line: string): string =>
  line.length <= MAX_LENGTH ? line : `${line.slice(0, MAX_LENGTH - 1)}…`;

/** What a search looks for, and where when it names a path. */
const search = (args: Args): Option.Option<string> =>
  Option.map(text(args, "pattern"), (pattern) =>
    Option.match(text(args, "path"), {
      onNone: () => pattern,
      onSome: (path) => `${pattern} in ${path}`,
    }),
  );

/** The first line of a script that is not its `// @options:` line, or nothing for an empty one. */
const script = (args: Args): Option.Option<string> =>
  Option.flatMap(text(args, "code"), (code) =>
    Arr.findFirst(
      Arr.map(code.split("\n"), (line) => line.trim()),
      (line) => line !== "" && !line.startsWith("// @options:"),
    ),
  );

/**
 * The one thing about a call worth showing beside its name: the path a file tool works on, what a search looks for, or
 * the command a shell runs. Nothing for a tool the page does not know, or arguments that do not have it.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const toolSummary = (toolName: string, args: Args): string | undefined => {
  const summary = (() => {
    switch (toolName) {
      case "read":
      case "write":
      case "edit":
      case "ls":
        return text(args, "path");
      case "grep":
      case "find":
        return search(args);
      case "codemode":
        return script(args);
      case "bash":
        return Option.map(text(args, "command"), (command) => command.split("\n")[0] ?? command);
      default:
        return Option.none();
    }
  })();

  return Option.getOrUndefined(Option.map(summary, clip));
};
