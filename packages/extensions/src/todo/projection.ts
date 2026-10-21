// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over a request's messages.
// The Todo List in the model's context (`docs/spec.md` → Todo). pi-todo keeps hidden snapshots of the list among the
// messages and re-places them after a compaction. Here the list is a document that a Handoff or compaction never
// touches, and each result of the `todo` tool shows the whole list with the revision it shows (`details.rev`). So a
// request needs a snapshot only when its last `todo` result is not the current revision: after a Handoff or compaction
// took the results out, or a script changed the list through nested calls, which leave no result in the context. The
// snapshot goes last, in the one request only, so what came before it keeps its place in the provider's prompt cache.
import { callDurable, effectHook } from "@cloudpid/effect-durable";
import { GenerationTask } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { EMPTY_TODO_STATE, TodoDoc, type TodoState } from "./doc.ts";
import { formatTasks } from "./list.ts";

/** What the prompt says about the tool: fixed text, so it never changes the prompt prefix. */
export const TODO_GUIDELINE =
  "Track this conversation's Tasks in the Todo List with todo. When it has Tasks, keep it current: mark a Task active when you start it and completed as soon as it is done, and bring it up to date before the context is compacted or rolled over.";

/** Marks the snapshot as the extension's, so the model does not read it as the user's. */
export const SNAPSHOT_HEADER = "Todo List state from the todo extension (not a user message):";

/** Asked when the model has seen no list at all in this context: a Handoff's plan may have moved on from the list. */
export const RECONCILE_INSTRUCTION =
  "The context was compacted or rolled over while Tasks were unfinished. Before continuing, reconcile this Todo List with the work already done and the plan carried forward: mark finished Tasks completed, remove abandoned ones, and keep it current as you work.";

const decodeDetails = Schema.decodeUnknownOption(Schema.Struct({ rev: Schema.Finite }));

/** The revision a `todo` result shows, when it is a successful call's. */
const shownRevision = (message: Message): number | undefined => {
  if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) {
    return undefined;
  }

  return Option.getOrUndefined(
    Option.map(decodeDetails(message.details), (details) => details.rev),
  );
};

/** The snapshot message `messages` need to show the list `state` holds, or none when they already show it. */
export const snapshotFor = (
  messages: ReadonlyArray<Message>,
  state: TodoState,
): Message | undefined => {
  const shown = messages.flatMap((message) => {
    const rev = shownRevision(message);

    return rev === undefined ? [] : [rev];
  });

  if (shown.at(-1) === state.rev) return undefined;

  const seen = shown.length > 0;

  // A list that was never used needs no words; one the model saw other than it is now does.
  if (state.tasks.length === 0 && !seen) return undefined;

  const unfinished = state.tasks.some((task) => task.status !== "completed");
  const list = `${SNAPSHOT_HEADER}\n${formatTasks(state.tasks)}`;

  return {
    role: "user",
    content: !seen && unfinished ? `${list}\n\n${RECONCILE_INSTRUCTION}` : list,
    timestamp: messages.at(-1)?.timestamp ?? 0,
  };
};

/** Puts the Todo List last in a request that does not show it. */
export const TodoProjection = effectHook(GenerationTask, {
  beforeRequest: (request, api) =>
    Effect.gen(function* () {
      const state =
        (yield* callDurable("snapshot", (context) =>
          api.snapshot(TodoDoc, api.conversationId, context),
        )) ?? EMPTY_TODO_STATE;

      const snapshot = snapshotFor(request.messages, state);

      return snapshot === undefined ? undefined : { messages: [...request.messages, snapshot] };
    }),
});
