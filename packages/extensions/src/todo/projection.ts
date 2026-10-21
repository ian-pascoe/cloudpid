// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- plain functions over a request's messages.
// The Todo List in the model's context (`docs/spec.md` → Todo). pi-todo keeps hidden snapshots of the list among the
// messages, each at a fixed place with fixed text, and re-places one after a compaction. Here the list is a document
// that a Handoff or compaction never touches, and the context needs it back in two cases, each handled at a place that
// stays the same for as long as the context lasts, so the provider's prompt cache keeps hitting:
//
// - A script's nested `todo` calls leave no result in the context. An `afterTool` hook appends the list to the result of
//   the call that made them, which is then committed with it.
// - A Handoff or compaction took the `todo` results out. A `beforeRequest` hook puts the list into the Context Window's
//   first message, as it stood when the window's first request was made, and records that text in the document, so every
//   later request of the window sends the same bytes.
//
// Both rest on `details.todoRev`, the revision of the list that a result's text shows.
import { callDurable, effectHook, Harness } from "@cloudpid/effect-durable";

import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { GenerationTask, type JsonObject, ToolTask } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { EMPTY_TODO_STATE, TodoDoc, type TodoState } from "./doc.ts";
import { formatTasks } from "./list.ts";
import { SHOWN_REV } from "./tool.ts";

/** What the prompt says about the tool: fixed text, so it never changes the prompt prefix. */
export const TODO_GUIDELINE =
  "Track this conversation's Tasks in the Todo List with todo. When it has Tasks, keep it current: mark a Task active when you start it and completed as soon as it is done, and bring it up to date before the context is compacted or rolled over.";

/** Marks the text as the extension's, so the model does not read it as the user's. */
export const SNAPSHOT_HEADER =
  "Todo List state at the start of this context, from the todo extension (not a user message):";

/** Marks a list a script changed, appended to the result of the call that ran the script. */
export const CHANGED_HEADER = "Todo List after this call, from the todo extension:";

/** Asked when the model has seen no list at all in this context: a Handoff's plan may have moved on from the list. */
export const RECONCILE_INSTRUCTION =
  "The context was compacted or rolled over while Tasks were unfinished. Before continuing, reconcile this Todo List with the work already done and the plan carried forward: mark finished Tasks completed, remove abandoned ones, and keep it current as you work.";

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

const decodeDetails = Schema.decodeUnknownOption(Schema.Struct({ [SHOWN_REV]: Schema.Finite }));

/** The revision of the list the result `message` shows, if it is a result that does. */
const shownRevision = (message: Message): number | undefined =>
  message.role === "toolResult"
    ? Option.getOrUndefined(
        Option.map(decodeDetails(message.details), (details) => details.todoRev),
      )
    : undefined;

/** The text that puts `state` in front of a context that has `seen` a list or not; none when there is nothing to say. */
export const snapshotText = (state: TodoState, seen: boolean): string | undefined => {
  // A list that was never used needs no words; one the model saw other than it is now does.
  if (state.tasks.length === 0 && !seen) return undefined;

  const list = `${SNAPSHOT_HEADER}\n${formatTasks(state.tasks)}`;

  return !seen && state.tasks.some((task) => task.status !== "completed")
    ? `${list}\n\n${RECONCILE_INSTRUCTION}`
    : list;
};

/** `message` with `text` after its own, so the two stay one turn. */
const withText = (message: UserMessage, text: string): UserMessage => ({
  ...message,
  content: Predicate.isString(message.content)
    ? `${message.content}\n\n${text}`
    : [...message.content, { type: "text", text: `\n${text}` }],
});

/**
 * Puts the Todo List in the first message of a Context Window that shows none. The window is told by the timestamp of
 * its first message, which a Handoff or compaction summary gets once. The text is recorded in the document, so a window
 * sends the same first message in every request.
 */
export const TodoWindow = Effect.gen(function* () {
  const { harness } = yield* Harness;

  return yield* effectHook(GenerationTask, {
    beforeRequest: (request, api) =>
      Effect.gen(function* () {
        const { messages } = request;
        const at = messages.findIndex((message) => message.role !== "system");
        const first = messages[at];

        if (first?.role !== "user") return undefined;

        const state =
          (yield* callDurable("snapshot", (context) =>
            api.snapshot(TodoDoc, api.conversationId, context),
          )) ?? EMPTY_TODO_STATE;

        const shown = Arr.flatMap(messages, (message) => {
          const rev = shownRevision(message);

          return rev === undefined ? [] : [rev];
        });

        // The last result in the context shows the list as it is: the window needs nothing more.
        const current = shown.at(-1) === state.rev;
        const window = first.timestamp;
        const kept = state.shown?.window === window ? state.shown : null;

        let text = kept !== null && (current || kept.rev === state.rev) ? kept.text : undefined;

        if (text === undefined && !current) {
          text = snapshotText(state, shown.length > 0);

          if (text !== undefined) {
            const recorded = { window, rev: state.rev, text };

            yield* callDurable("record", (context) =>
              harness.commit(async (tx) => {
                (await tx.doc(TodoDoc, api.conversationId)).shown = recorded;
              }, context),
            );
          }
        }

        if (text === undefined) return undefined;

        return {
          messages: messages.map((message, index) =>
            index === at && message.role === "user" ? withText(message, text) : message,
          ),
        };
      }),
  });
});

/** Appends the list to the result of a call whose nested `todo` calls changed it. */
export const TodoResult = effectHook(ToolTask, {
  afterTool: (call, result, api) =>
    Effect.gen(function* () {
      // A nested call's result goes to its caller, not to the context.
      if (call.parent !== undefined || result.output === undefined) return undefined;

      const state = yield* callDurable("snapshot", (context) =>
        api.snapshot(TodoDoc, api.conversationId, context),
      );

      if (state === undefined || !state.changedBy.includes(call.id)) return undefined;

      const kept = Option.getOrElse(decodeRecord(result.details), () => ({}));
      // SAFETY: `Schema.Json` values are JSON, as `JsonValue`'s are; the types differ only in `readonly`.
      const details = { ...kept, [SHOWN_REV]: state.rev } as JsonObject;

      return {
        ...result,
        output: [
          ...result.output,
          { type: "text" as const, text: `\n\n${CHANGED_HEADER}\n${formatTasks(state.tasks)}` },
        ],
        details,
      };
    }),
});
