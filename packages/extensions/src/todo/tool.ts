// @effect-diagnostics asyncFunction:off missingPipeableSignature:off missedPipeableOpportunity:off preferEffectArray:off -- pi-durable commit callbacks are Promise code; plain functions over the list's JSON.
// The `todo` tool: pi-todo's parameters, atomic batches, and structured output, over the conversation's Todo document.
// A call reads and changes the list in one commit, so it sees the list as the last call left it and a failure changes
// nothing. The text of every result ends with the whole list, so the model's context shows the current list wherever the
// last call is, and the projection (`./projection.ts`) only has to fill in when no call is.
import { callDurable, defineEffectTool } from "@cloudpid/effect-durable";
import type { ToolTaskInput } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MAX_CHANGED_BY, TODO_STATUSES, TodoDoc, type TodoState } from "./doc.ts";
import { TodoError } from "./errors.ts";
import {
  applyTodo,
  formatTasks,
  MAX_DESCRIPTION_CHARACTERS,
  MAX_TITLE_CHARACTERS,
  TODO_ACTIONS,
  type TodoInput,
  type TodoList,
  type TodoOutcome,
} from "./list.ts";

/** The key of a result's `details` that names the revision of the list its text shows, for the projection. */
export const SHOWN_REV = "todoRev";

const TaskId = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

const Status = Schema.Literals(TODO_STATUSES);

/** Models often send `null` for a field they leave out, as pi-todo's `acceptNullForOptionalArguments` expects. */
const Maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema));

const Title = Schema.String.check(Schema.isMaxLength(MAX_TITLE_CHARACTERS));

const Description = Schema.String.check(Schema.isMaxLength(MAX_DESCRIPTION_CHARACTERS));

const TodoParameters = Schema.Struct({
  action: Schema.Literals(TODO_ACTIONS),
  id: Maybe(TaskId).annotate({
    description: "Task ID for update or remove; not allowed with updates",
  }),
  title: Maybe(Title).annotate({
    description: `Task title (at most ${MAX_TITLE_CHARACTERS} characters) for add or update; not allowed with tasks or updates`,
  }),
  description: Maybe(Description).annotate({
    description: `Optional Task description (at most ${MAX_DESCRIPTION_CHARACTERS} characters); null removes it during update; not allowed with tasks or updates`,
  }),
  tasks: Maybe(
    Schema.Array(
      Schema.Struct({
        title: Title.annotate({ description: "Task title" }),
        description: Maybe(Description).annotate({ description: "Optional Task description" }),
      }),
    ).check(Schema.isMinLength(1)),
  ).annotate({
    description:
      "Tasks to add in one call, all or none, with sequential IDs; use instead of title and description",
  }),
  updates: Maybe(
    Schema.Array(
      Schema.Struct({
        id: TaskId.annotate({ description: "Task ID" }),
        status: Maybe(Status).annotate({ description: "New Task status" }),
        title: Maybe(Title).annotate({ description: "New Task title" }),
        description: Maybe(Description).annotate({
          description: "New Task description; null removes it",
        }),
      }),
    ).check(Schema.isMinLength(1)),
  ).annotate({
    description:
      "Task changes to apply in one call, all or none, one per Task ID; use instead of id, title, description, and status",
  }),
  status: Maybe(Status).annotate({
    description: "Task status; for add, applies to every new Task; not allowed with updates",
  }),
});

const TaskOutput = Schema.Struct({
  id: TaskId,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  status: Status,
});

/** Flat, as pi-todo's: `action` (and whether the request carried `tasks` or `updates`) says which field is present. */
const TodoOutputSchema = Schema.Struct({
  action: Schema.Literals(TODO_ACTIONS).annotate({ description: "The operation that ran" }),
  tasks: Schema.optionalKey(
    Schema.Array(TaskOutput).annotate({
      description:
        "list: every Task in ID order; add with tasks: the Tasks created, in ID order; update with updates: the Tasks changed, in request order",
    }),
  ),
  task: Schema.optionalKey(TaskOutput),
  id: Schema.optionalKey(TaskId.annotate({ description: "remove: ID of the removed Task" })),
  cleared: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
      description: "clear: number of Tasks removed",
    }),
  ),
});

type Args = typeof TodoParameters.Type;

/** The call's input with each `null` the model sent for a field it left out taken as absent; `null` stays where it means "remove". */
const inputOf = (args: Args): TodoInput => ({
  action: args.action,
  id: args.id ?? undefined,
  title: args.title ?? undefined,
  description: args.description,
  tasks: args.tasks?.map((task) => ({
    title: task.title,
    description: task.description ?? undefined,
  })),
  updates: args.updates?.map((update) => ({
    id: update.id,
    title: update.title ?? undefined,
    description: update.description,
    status: update.status ?? undefined,
  })),
  status: args.status ?? undefined,
});

/** The document's list, as the actions take it: a copy, so a draft is never kept by what they return. */
const listOf = (state: TodoState): TodoList => ({
  nextId: state.nextId,
  tasks: state.tasks.map((task) => ({ ...task })),
});

/** What a call did to the list, and the revision it left. */
type Applied = { readonly outcome: TodoOutcome; readonly rev: number; readonly text: string };

/** The text of a result: what the call did, then the whole list. */
const textOf = (outcome: Extract<TodoOutcome, { ok: true }>, list: string): string =>
  outcome.output.action === "list" ? list : `${outcome.message}\n${list}`;

export const TodoTool = defineEffectTool({
  name: "todo",
  description:
    "Manage this conversation's Todo List: flat Tasks with a title, an optional description, and a status (pending, active, completed). Actions list, add, update, remove, clear. add takes a title, or tasks to add several; update takes an id and fields, or updates to change several; both batches are all or nothing. Every result shows the whole list.",
  parameters: TodoParameters,
  structuredOutputSchema: Schema.toJsonSchemaDocument(TodoOutputSchema).schema,
  executionMode: "sequential",
  execute: (args, api) =>
    Effect.gen(function* () {
      const input = inputOf(args);

      // Whether this is a nested call, and of which call.
      const task = yield* callDurable("getTask", (context) => api.getTask(api.taskId, context));
      // SAFETY: a tool call's task is a `pi.tool` task, whose input is a `ToolTaskInput`.
      const caller = task?.input as ToolTaskInput | undefined;

      // A failure leaves the document as it was: only a successful change writes.
      const applied = yield* callDurable("todo", (context) =>
        api.commit(async (tx): Promise<Applied> => {
          const state = await tx.doc(TodoDoc, api.conversationId);
          const list = listOf(state);
          const outcome = applyTodo(list, input);

          // An action that changes nothing (`list`, `clear` of an empty list) hands back the list it was given.
          if (outcome.ok && outcome.list !== list) {
            state.nextId = outcome.list.nextId;
            state.tasks = outcome.list.tasks.map((task) => ({ ...task }));
            state.rev += 1;

            // A nested call (a script's) leaves no result in the context: remember whose, so that its result shows the list.
            if (caller?.kind === "nested") {
              state.changedBy = [...state.changedBy, caller.parentCallId].slice(-MAX_CHANGED_BY);
            }
          }

          return { outcome, rev: state.rev, text: formatTasks(state.tasks) };
        }, context),
      ).pipe(Effect.mapError((error) => TodoError.make({ message: error.message })));

      if (!applied.outcome.ok) return yield* TodoError.make({ message: applied.outcome.message });

      return {
        output: [{ type: "text" as const, text: textOf(applied.outcome, applied.text) }],
        structuredOutput: applied.outcome.output,
        details: { [SHOWN_REV]: applied.rev },
      };
    }),
});
