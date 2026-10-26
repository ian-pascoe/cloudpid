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

/** Why a `container_restart` call restarts the Container, and whether it starts afresh. */
const restart = (args: Args): Option.Option<string> =>
  Option.map(firstLine(args, "reason"), (reason) =>
    args.fresh === true ? `${reason} (fresh)` : reason,
  );

/** Why a `container_resize` call restarts the Container at another size, and the size. */
const resize = (args: Args): Option.Option<string> =>
  Option.map(firstLine(args, "reason"), (reason) =>
    Option.match(text(args, "size"), {
      onNone: () => reason,
      onSome: (size) => `${reason} (to ${size})`,
    }),
  );

/** The variable an `environment_*` call changes, in the Environment its `id` names when it names one. */
const variable = (args: Args): Option.Option<string> =>
  Option.map(text(args, "name"), (name) =>
    Option.match(text(args, "id"), {
      onNone: () => name,
      onSome: (id) => `${name} in ${id}`,
    }),
  );

/** `line`, after the Environment a call's `id` names when it names one. */
const inEnvironment = (args: Args, line: Option.Option<string>): Option.Option<string> =>
  Option.map(line, (value) =>
    Option.match(text(args, "id"), {
      onNone: () => value,
      onSome: (id) => `${id}: ${value}`,
    }),
  );

/** Why an `environment_idle_time_set` call sets the idle time, and the minutes. */
const idleTime = (args: Args): Option.Option<string> =>
  Option.map(firstLine(args, "reason"), (reason) =>
    Predicate.isNumber(args.minutes) ? `${reason} (${args.minutes} min)` : reason,
  );

/** What an `environment_*` call changes in an Environment's record: its new name, or the Repo, in the Environment its `id` names when it names one. */
const lifecycle = (toolName: string, args: Args): Option.Option<string> =>
  Option.map(text(args, toolName === "environment_repo_add" ? "url" : "name"), (what) =>
    Option.match(text(args, "id"), {
      onNone: () => what,
      onSome: (id) => `${what} in ${id}`,
    }),
  );

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
 * the command a shell runs, why the Container is restarted or resized, the task a subagent starts with, the instructions of a browser handoff, the message an agent sends, the agent a call addresses, or the Environment an `environment_*` call reads and the variable it changes. Nothing for a tool the page does not know, or arguments that do not have it.
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
      // A transcript keeps the calls made under the tool's former name.
      case "container_restart":
      case "restart_container":
        return restart(args);
      case "container_resize":
        return resize(args);
      case "todo":
        return todo(args);
      case "environment_get":
      case "environment_rebuild":
        return text(args, "id");
      case "environment_create":
        return text(args, "name");
      case "environment_rename":
      case "environment_repo_add":
      case "environment_repo_remove":
        return lifecycle(toolName, args);
      case "environment_variable_set":
      case "environment_variable_unset":
        return variable(args);
      case "environment_container_resize":
        return inEnvironment(args, resize(args));
      case "environment_idle_time_set":
        return inEnvironment(args, idleTime(args));
      case "environment_setup_script_set":
      case "environment_start_script_set":
      case "environment_toolchains_set":
      case "environment_ignore_set":
        return inEnvironment(args, firstLine(args, "reason"));
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
