// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- plain functions over a request's messages.
// The Todo List in the model's context (`docs/spec.md` → Todo). pi-todo keeps hidden snapshots of the list among the
// messages, each at a fixed place with fixed text, and re-places one after a compaction. Here the list is a document
// that a Handoff or compaction never touches, and the context needs it back in three cases. The first two are handled
// at a place that stays the same for as long as the context lasts, so the provider's prompt cache keeps hitting:
//
// - A script's nested `todo` calls leave no result in the context. An `afterTool` hook appends the list to the result of
//   the call that made them, which is then committed with it.
// - A Handoff or compaction took the `todo` results out. A `beforeRequest` hook puts the list into the Context Window's
//   first message, as it stood when the window's first request was made, and records that text in the document, so every
//   later request of the window sends the same bytes. A recorded text is never rewritten, and a window that holds a
//   `todo` result gets none.
// - The list changed and no result shows it: a Stop during a script after its nested call, an interrupted call, parallel
//   scripts whose results finish out of order, a fork. Rare, so it gets a note at the end of the request, which lasts
//   until the model calls `todo` and its result shows the list.
//
// All rest on `details.todoRev`, the revision of the list that a result's text shows.
import { callDurable, effectHook, Harness } from "@cloudpid/effect-durable";

import type { Message } from "@earendil-works/pi-ai";
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

/** The text that puts `state` in front of a context that holds no `todo` result; none for a list with nothing in it. */
export const snapshotText = (state: TodoState): string | undefined => {
  if (state.tasks.length === 0) return undefined;

  const list = `${SNAPSHOT_HEADER}\n${formatTasks(state.tasks)}`;

  return state.tasks.some((task) => task.status !== "completed")
    ? `${list}\n\n${RECONCILE_INSTRUCTION}`
    : list;
};

/** The note for a request whose last `todo` result, or the list in its first message, is behind the list. */
export const STALE_NOTE =
  "Todo List note from the todo extension (not a user message): the Todo List changed after the last list shown in this conversation, for example because a call was stopped after changing it. Call todo with action list to see the current list before relying on it.";

/** `message` with `text` after its own, so the two stay one turn; a message that has no text to add to is left as it is. */
const withText = (message: Message, text: string): Message => {
  if (message.role === "user") {
    return {
      ...message,
      content: Predicate.isString(message.content)
        ? `${message.content}\n\n${text}`
        : [...message.content, { type: "text", text: `\n${text}` }],
    };
  }

  if (message.role === "toolResult") {
    return { ...message, content: [...message.content, { type: "text", text: `\n${text}` }] };
  }

  return message;
};

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

        const window = first.timestamp;
        const kept = state.shown?.window === window ? state.shown : null;
        let head: string | undefined;
        let stale: boolean;

        if (shown.length === 0) {
          // Nothing in this window shows the list: the first request of it puts the list in the first message, once.
          head = kept?.text ?? snapshotText(state);
          stale = kept !== null && kept.rev !== state.rev;

          if (kept === null && head !== undefined) {
            const recorded = { window, rev: state.rev, text: head };

            yield* callDurable("record", (context) =>
              harness.commit(async (tx) => {
                (await tx.doc(TodoDoc, api.conversationId)).shown = recorded;
              }, context),
            );
          }
        } else {
          head = kept?.text;
          stale = shown.at(-1) !== state.rev;
        }

        if (head === undefined && !stale) return undefined;

        const last = messages.length - 1;

        return {
          messages: messages.map((message, index) => {
            const first = head !== undefined && index === at ? withText(message, head) : message;

            return stale && index === last ? withText(first, STALE_NOTE) : first;
          }),
        };
      }),
  });
});

/**
 * Whether a result of `output` and `added` text stays within pi-durable's default limits (50 KB and 2,000 lines), with
 * room to spare.
 */
const withinLimits = (output: ReadonlyArray<{ readonly type: string }>, added: string): boolean => {
  const text = Arr.flatMap(output, (block) =>
    "text" in block && Predicate.isString(block.text) ? [block.text] : [],
  );

  const all = [...text, added].join("\n");

  return new TextEncoder().encode(all).length <= 40_000 && all.split("\n").length <= 1_800;
};

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

      const added = `\n\n${CHANGED_HEADER}\n${formatTasks(state.tasks)}`;

      // pi-durable keeps the head of a result within its limits, after this hook: a list that would be cut is not shown,
      // so the result does not claim it is, and the request says the list changed.
      if (!withinLimits(result.output, added)) return undefined;

      const kept = Option.getOrElse(decodeRecord(result.details), () => ({}));
      // SAFETY: `Schema.Json` values are JSON, as `JsonValue`'s are; the types differ only in `readonly`.
      const details = { ...kept, [SHOWN_REV]: state.rev } as JsonObject;

      return {
        ...result,
        output: [...result.output, { type: "text" as const, text: added }],
        details,
      };
    }),
});
