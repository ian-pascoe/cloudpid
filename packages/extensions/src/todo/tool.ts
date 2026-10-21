// @effect-diagnostics asyncFunction:off missingPipeableSignature:off missedPipeableOpportunity:off preferEffectArray:off -- pi-durable commit callbacks are Promise code; plain functions over the list's JSON.
// The `todo` tool: pi-todo's parameters, atomic batches, and structured output, over the conversation's Todo document.
// A call reads and changes the list in one commit, so it sees the list as the last call left it and a failure changes
// nothing. The text of every result ends with the whole list, so the model's context shows the current list wherever the
// last call is, and the projection (`./projection.ts`) only has to fill in when no call is.
import { defineEffectTool } from "@cloudpid/effect-durable";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { durable, fail } from "../context/store.ts";
import { TODO_STATUSES, TodoDoc, type TodoState } from "./doc.ts";
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

/** The `details` of a result: which revision of the list its text shows, for the projection. */
export type TodoDetails = { readonly rev: number };

const TaskId = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

const Status = Schema.Literals(TODO_STATUSES);

const Title = Schema.String.check(Schema.isMaxLength(MAX_TITLE_CHARACTERS * 2));

const Description = Schema.String.check(Schema.isMaxLength(MAX_DESCRIPTION_CHARACTERS * 2));

const TodoParameters = Schema.Struct({
  action: Schema.Literals(TODO_ACTIONS),
  id: Schema.optional(TaskId).annotate({
    description: "Task ID for update or remove; not allowed with updates",
  }),
  title: Schema.optional(Title).annotate({
    description: "Task title for add or update; not allowed with tasks or updates",
  }),
  description: Schema.optional(Schema.NullOr(Description)).annotate({
    description:
      "Optional Task description; null removes it during update; not allowed with tasks or updates",
  }),
  tasks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Title.annotate({ description: "Task title" }),
        description: Schema.optional(Description).annotate({
          description: "Optional Task description",
        }),
      }),
    ).check(Schema.isMinLength(1)),
  ).annotate({
    description:
      "Tasks to add in one call, all or none, with sequential IDs; use instead of title and description",
  }),
  updates: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: TaskId.annotate({ description: "Task ID" }),
        status: Schema.optional(Status).annotate({ description: "New Task status" }),
        title: Schema.optional(Title).annotate({ description: "New Task title" }),
        description: Schema.optional(Schema.NullOr(Description)).annotate({
          description: "New Task description; null removes it",
        }),
      }),
    ).check(Schema.isMinLength(1)),
  ).annotate({
    description:
      "Task changes to apply in one call, all or none, one per Task ID; use instead of id, title, description, and status",
  }),
  status: Schema.optional(Status).annotate({
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

/** The document's list, as the actions take it: a copy, so a draft is never kept by what they return. */
const listOf = (state: TodoState): TodoList => ({
  nextId: state.nextId,
  tasks: state.tasks.map((task) => ({ ...task })),
});

/** What a call did to the list, and the revision it left. */
type Applied = { readonly outcome: TodoOutcome; readonly state: TodoState };

/** The text of a result: what the call did, then the whole list. */
const textOf = (outcome: Extract<TodoOutcome, { ok: true }>, state: TodoState): string => {
  const list = formatTasks(state.tasks);

  return outcome.output.action === "list" ? list : `${outcome.message}\n${list}`;
};

export const TodoTool = defineEffectTool({
  name: "todo",
  description:
    "Manage this conversation's Todo List: flat Tasks with a title, an optional description, and a status (pending, active, completed). Actions list, add, update, remove, clear. add takes a title, or tasks to add several; update takes an id and fields, or updates to change several; both batches are all or nothing. Every result shows the whole list.",
  parameters: TodoParameters,
  structuredOutputSchema: Schema.toJsonSchemaDocument(TodoOutputSchema).schema,
  executionMode: "sequential",
  execute: (args, api) =>
    Effect.gen(function* () {
      const input: TodoInput = args;

      // A failure leaves the document as it was: only a successful change writes.
      const applied = yield* durable("todo", (context) =>
        api.commit(async (tx): Promise<Applied> => {
          const state = await tx.doc(TodoDoc, api.conversationId);
          const list = listOf(state);
          const outcome = applyTodo(list, input);

          // An action that changes nothing (`list`, `clear` of an empty list) hands back the list it was given.
          if (outcome.ok && outcome.list !== list) {
            state.nextId = outcome.list.nextId;
            state.tasks = outcome.list.tasks.map((task) => ({ ...task }));
            state.rev += 1;
          }

          return {
            outcome,
            state: {
              nextId: state.nextId,
              rev: state.rev,
              tasks: state.tasks.map((task) => ({ ...task })),
            },
          };
        }, context),
      );

      if (!applied.outcome.ok) return yield* fail(applied.outcome.message);

      return {
        output: [{ type: "text" as const, text: textOf(applied.outcome, applied.state) }],
        structuredOutput: applied.outcome.output,
        details: { rev: applied.state.rev } satisfies TodoDetails,
      };
    }),
});
