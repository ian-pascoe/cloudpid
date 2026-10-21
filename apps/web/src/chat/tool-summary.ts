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

/** The first line of `key`'s text. */
const firstLine = (args: Args, key: string): Option.Option<string> =>
  Option.map(text(args, key), (value) => value.split("\n")[0] ?? value);

/** What a `todo` call does: its action, and the Task it names or how many it takes. */
const todo = (args: Args): Option.Option<string> =>
  Option.map(text(args, "action"), (action) => {
    const batch = Arr.isArray(args.tasks)
      ? args.tasks.length
      : Arr.isArray(args.updates)
        ? args.updates.length
        : undefined;

    const id = Predicate.isNumber(args.id) ? ` #${args.id}` : "";

    return Option.match(firstLine(args, "title"), {
      onNone: () =>
        batch === undefined ? `${action}${id}` : `${action} ${batch} Task${batch === 1 ? "" : "s"}`,
      onSome: (title) => `${action}${id}: ${title}`,
    });
  });

/** `line`, after the agent a call names when it names one. */
const toAgent = (args: Args, line: Option.Option<string>): Option.Option<string> =>
  Option.map(line, (value) =>
    Option.match(text(args, "agent_id"), {
      onNone: () => value,
      onSome: (agent) => `${agent}: ${value}`,
    }),
  );

/**
 * The one thing about a call worth showing beside its name: the path a file tool works on, what a search looks for,
 * the command a shell runs, the task a subagent starts with, the instructions of a browser handoff, the message an agent sends, or the agent a call addresses. Nothing for a tool the page does not know, or arguments that do not have it.
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
        return firstLine(args, "command");
      case "browser_handoff":
        return firstLine(args, "instructions");
      case "todo":
        return todo(args);
      case "subagent":
        return toAgent(args, firstLine(args, "task"));
      case "agent_message":
        return toAgent(args, firstLine(args, "message"));
      case "subagent_wait":
      case "subagent_status":
      case "subagent_cancel":
      case "subagent_delete":
        return text(args, "agent_id");
      default:
        return Option.none();
    }
  })();

  return Option.getOrUndefined(Option.map(summary, clip));
};
