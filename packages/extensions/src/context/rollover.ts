// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- pi-durable commit callbacks and plain string functions.
// Rollover (`docs/spec.md` → Context management): the agent writes its own Handoff instead of the generated summary of
// a compaction. `context_rollover` returns `control: { handoff }`, which pi-durable applies once the whole tool round is
// done: it appends a `pi.reset` entry carrying the Handoff and ends the run, and a follow-up the tool queued continues
// the task in the new context. The `beforeCompact` hook turns a background threshold compaction into a Rollover request;
// a compaction that cannot wait for the agent (a blocking threshold one, or an overflow one) is the Emergency Rollover,
// whose summary is the last saved Handoff.
import { callDurable, defineEffectTool, effectHook, Harness } from "@cloudpid/effect-durable";
import {
  type CompactionHooks,
  CompactionTask,
  type ConversationId,
  LiveDoc,
  type ToolExecutionApi,
  type ToolTaskInput,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ContextDoc, EMPTY_STATE, MAX_NOTE_CHARACTERS, type Note, noteIndex } from "./notes.ts";
import { durable, fail, readEntry } from "./store.ts";

/**
 * The Rollover request's entry: its own kind, and a `notice` title, so the transcript shows it as a notice rather than
 * as user input.
 */
export const PREPARE_ENTRY = {
  kind: "cloudpid.context-prepare",
  data: { notice: "Rollover requested" },
} as const;

/** The entry of the input that continues the task after a Handoff. */
export const CONTINUE_ENTRY = {
  kind: "cloudpid.context-continue",
  data: { notice: "Continued after the Handoff" },
} as const;

/** The request ID prefix of Rollover requests; the suffix names the Context Window it was made in. */
const PREPARE_REQUEST = "context-prepare:";

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
    "Emergency Rollover: the context filled up before a fresh Handoff, so the saved Handoff below may be stale or absent. Recover recent work from History before continuing.",
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

/**
 * Whether this Rollover was requested after the task was answered: every input of the run is a Rollover request. A
 * request steered during the task joins the task's run, and a user message queued behind one is an input of its own
 * run; either still needs the continuation.
 */
const requestedAfterAnswer = (api: ToolExecutionApi) =>
  Effect.gen(function* () {
    const { harness } = yield* Harness;

    const live = yield* durable("snapshot", (context) =>
      api.snapshot(LiveDoc, api.conversationId, context),
    );

    const records = yield* Effect.forEach(live?.run?.inputs ?? [], (id) =>
      durable("submission", async (context) =>
        (await harness.submission(id, context))?.status(context),
      ),
    );

    return (
      records.length > 0 &&
      Arr.every(records, (record) => record?.requestId?.startsWith(PREPARE_REQUEST) === true)
    );
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

      // Queued behind the Handoff, so the task goes on in the new context once pi-durable ends this run. A Rollover
      // requested after the task was answered has no task to go on with: it stops at the Handoff.
      const conversation = yield* durable("conversation", (context) =>
        api.conversation(api.conversationId, context),
      );

      if (conversation !== undefined && !(yield* requestedAfterAnswer(api))) {
        yield* durable("continue", (context) =>
          conversation.submit(
            {
              type: "input",
              content: CONTINUE_PROMPT,
              whenBusy: "followUp",
              requestId: `context-continue:${api.taskId}`,
              entry: CONTINUE_ENTRY,
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
 * Automatic compaction as Rollover, in conversations that offer `context_rollover`:
 *
 * - A background threshold compaction is declined: it blocks nothing, and the request goes ahead with pi-durable's
 *   overflow recovery intact. While a run is live, the agent is asked once per Context Window, by a request steered
 *   after the current tool round, to update its Notes and roll over. With no run live it only declines; the next
 *   input crosses the threshold again and asks then.
 * - A blocking threshold compaction and an overflow compaction cannot wait for the agent: declining the blocking one
 *   would send a request without overflow recovery. Both are the Emergency Rollover, whose summary is the last saved
 *   Handoff and the Note Index, on pi-durable's cut, which never splits a tool call from its result.
 * - A manual compaction keeps pi-durable's summary.
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

      if (!Arr.some(agent.tools, (tool) => tool.name === "context_rollover")) return undefined;

      const live = yield* callDurable("snapshot", (context) =>
        api.snapshot(LiveDoc, api.conversationId, context),
      );

      const blocking =
        live?.compactions?.find((status) => status.taskId === api.taskId)?.blocking ?? false;

      if (compaction.reason === "overflow" || blocking) {
        const state =
          (yield* callDurable("snapshot", (context) =>
            api.snapshot(ContextDoc, api.conversationId, context),
          )) ?? EMPTY_STATE;

        return { summary: emergencyText(api.conversationId, state.handoff, state.notes) };
      }

      if (live?.run === undefined) return { decline: true } as const;

      // The head of the current Context Window: one request per window, however often the threshold is crossed.
      const window = compaction.entries[0]?.id ?? compaction.firstKept;

      yield* callDurable("prepare", (context) =>
        conversation.submit(
          {
            type: "input",
            content: PREPARE_PROMPT,
            whenBusy: "steer",
            requestId: `${PREPARE_REQUEST}${window}`,
            entry: PREPARE_ENTRY,
          },
          context,
        ),
      );

      return { decline: true } as const;
    }),
});
