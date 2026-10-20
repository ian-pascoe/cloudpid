// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- pi-durable commit callbacks and plain string functions.
// Rollover (`docs/spec.md` → Context management): the agent writes its own Handoff instead of the generated summary of
// a compaction. `context_rollover` returns `control: { handoff }`, which pi-durable applies once the whole tool round is
// done: it appends a `pi.reset` entry carrying the Handoff and ends the run, and a follow-up the tool queued continues
// the task in the new context. The `beforeCompact` hook turns an automatic (threshold) compaction into a request to
// prepare one; an overflow compaction, which cannot wait for the agent, uses the last saved Handoff instead.
import { callDurable, defineEffectTool, effectHook, Harness } from "@cloudpid/effect-durable";
import {
  type CompactionHooks,
  CompactionTask,
  type ConversationId,
  type ToolTaskInput,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ContextDoc, EMPTY_STATE, MAX_NOTE_CHARACTERS, type Note, noteIndex } from "./notes.ts";
import { durable, fail, readEntry } from "./store.ts";

/** The entry kind of the request to prepare a Rollover, so the transcript can tell it from user input. */
export const PREPARE_KIND = "cloudpid.context-prepare";

/** The entry kind of the input that continues the task after a Handoff. */
export const CONTINUE_KIND = "cloudpid.context-continue";

export const PREPARE_PROMPT =
  "Prepare a Context Rollover for the current task: the context is nearly full. Update useful Notes, then call context_rollover as the only tool call of its round with an explicit Handoff containing the objective, decisions, current state, and next actions. Continue the task after the checkpoint.";

export const CONTINUE_PROMPT =
  "The context rolled over. Continue the task from the Handoff above; read Notes and History when you need them.";

const HISTORY_HINT =
  "Earlier History, from before this Handoff, stays readable with context_history (windows, list, search, read).";

/** The first message of a new context: the agent's Handoff, then the Note Index. */
export const handoffText = (
  conversationId: ConversationId,
  handoff: string,
  notes: ReadonlyArray<Note>,
): string =>
  [
    "Context Window Handoff",
    `Agent-written Handoff:\n\n${handoff}`,
    noteIndex(conversationId, notes),
    HISTORY_HINT,
  ].join("\n\n");

/** The summary of an Emergency Rollover: the last saved Handoff, which may be stale, and the Note Index. */
export const emergencyText = (
  conversationId: ConversationId,
  handoff: string | null,
  notes: ReadonlyArray<Note>,
): string =>
  [
    "Context Window Handoff",
    "Emergency Rollover: the context overflowed before a fresh Handoff, so the saved Handoff below may be stale or absent. Recover recent work from History before continuing.",
    handoff ?? "No saved Handoff. Recover the user's task from recent History and Notes.",
    noteIndex(conversationId, notes),
    HISTORY_HINT,
  ].join("\n\n");

const RolloverParameters = Schema.Struct({
  handoff: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_NOTE_CHARACTERS),
  ).annotate({
    description:
      "What the next context needs to continue: the objective, decisions, current state, and next actions",
  }),
});

const NOT_ALONE = "Rollover must be the sole tool call of its round; call context_rollover alone";

export const ContextRollover = defineEffectTool({
  name: "context_rollover",
  description:
    "Save an agent-written Handoff and start a fresh context from it after this tool round; Notes and History stay available. Must be the only tool call of its round.",
  parameters: RolloverParameters,
  // Scripts cannot hand off: the Handoff ends the model's run.
  callers: ["model"],
  execute: (args, api) =>
    Effect.gen(function* () {
      if (args.handoff.trim() === "") {
        return yield* fail(
          `Supply a non-empty Handoff of at most ${MAX_NOTE_CHARACTERS} characters`,
        );
      }

      const task = yield* durable("getTask", (context) => api.getTask(api.taskId, context));
      // SAFETY: a tool call's task is a `pi.tool` task, whose input is a `ToolTaskInput`.
      const input = task?.input as ToolTaskInput | undefined;

      if (input?.kind !== "model") return yield* fail(NOT_ALONE);

      // The round's other calls would run before the new context starts, and their results would not be in it.
      const assistant = yield* readEntry(api, api.conversationId, input.assistant);
      const message = assistant?.model?.[0];

      const calls =
        message?.role === "assistant"
          ? message.content.filter((block) => block.type === "toolCall")
          : [];

      if (calls.length !== 1 || calls[0]?.id !== api.callId) return yield* fail(NOT_ALONE);

      const notes = yield* durable("saveHandoff", (context) =>
        api.commit(async (tx) => {
          const state = await tx.doc(ContextDoc, api.conversationId);

          state.handoff = args.handoff;

          return state.notes.map((note) => ({ ...note }));
        }, context),
      );

      // Queued behind the Handoff, so the task goes on in the new context once pi-durable ends this run.
      const conversation = yield* durable("conversation", (context) =>
        api.conversation(api.conversationId, context),
      );

      if (conversation !== undefined) {
        yield* durable("continue", (context) =>
          conversation.submit(
            {
              type: "input",
              content: CONTINUE_PROMPT,
              whenBusy: "followUp",
              requestId: `context-continue:${api.taskId}`,
              entry: { kind: CONTINUE_KIND },
            },
            context,
          ),
        );
      }

      return {
        output: [
          {
            type: "text" as const,
            text: "Handoff saved. The new context starts from it after this tool round.",
          },
        ],
        control: { handoff: handoffText(api.conversationId, args.handoff, notes) },
      };
    }),
});

type BeforeCompact = Parameters<CompactionHooks["beforeCompact"]>;

/**
 * Automatic compaction as Rollover, in conversations that have `context_rollover`. A threshold compaction is declined
 * and the agent is asked, once per Context Window, to update its Notes and roll over; the request steers into the
 * running work, after its current tool round. An overflow compaction is the Emergency Rollover: its summary is the
 * last saved Handoff and the Note Index, and it keeps pi-durable's cut, which never splits a tool call from its result.
 * A manual compaction keeps pi-durable's summary.
 */
export const PrepareRollover = effectHook(CompactionTask, {
  beforeCompact: (compaction: BeforeCompact[0], api: BeforeCompact[1]) =>
    Effect.gen(function* () {
      if (compaction.reason === "manual") return undefined;

      const { harness } = yield* Harness;

      const conversation = yield* callDurable("conversation", (context) =>
        harness.conversation(api.conversationId, context),
      );

      if (conversation === undefined) return undefined;

      const agent = yield* callDurable("agent", (context) => conversation.agent(context));

      if (!agent.tools.some((tool) => tool.name === "context_rollover")) return undefined;

      if (compaction.reason === "overflow") {
        const state =
          (yield* callDurable("snapshot", (context) =>
            api.snapshot(ContextDoc, api.conversationId, context),
          )) ?? EMPTY_STATE;

        return { summary: emergencyText(api.conversationId, state.handoff, state.notes) };
      }

      // The head of the current Context Window: one request per window, however often the threshold is crossed.
      const window = compaction.entries[0]?.id ?? compaction.firstKept;

      yield* callDurable("prepare", (context) =>
        conversation.submit(
          {
            type: "input",
            content: PREPARE_PROMPT,
            whenBusy: "steer",
            requestId: `context-prepare:${window}`,
            entry: { kind: PREPARE_KIND, data: { reason: compaction.reason } },
          },
          context,
        ),
      );

      return { decline: true } as const;
    }),
});
