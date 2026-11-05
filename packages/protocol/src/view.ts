// Adapted from Cloudflare's `agents` repository, `examples/next/harnesses/pi/src/view.ts` as of commit 9e88bbf
// https://github.com/cloudflare/agents/blob/9e88bbf502fc3590790e575b4ab1b5ccb33c9495/examples/next/harnesses/pi/src/view.ts
//
// MIT License
//
// Copyright (c) 2025 Cloudflare, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// Changes: types renamed (`PiSessionView` → `SessionView`, `PiRunningTool` → `RunningTool`), functions written as
// `const` arrow functions, imports end in `.ts`. The view keeps the inbox's items (`inbox`) instead of their count
// (`queued`); nested calls (`pi.live.nestedTools`) are kept in `nestedTools`, with their output and how they ended; it
// follows the agent's thinking level (`thinkingLevel`); it shows the whole transcript the client holds, the Context
// Windows before the newest reset included, where the example's starts at that reset; gaps are left out (the client's
// mirror fills them, `mirror.ts`) rather than shown as `gap` messages; and the live message's tool calls keep their
// arguments only for the tools that stream them (`StreamedTools`). Every derived part keeps its identity while what it
// is derived from does. Formatted for this repository.

// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain TypeScript over pi's arrays, as the example is.

import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentState,
  InboxItem,
  InboxState,
  JsonObject,
  LiveState,
  NestedToolSlot,
  RunFailure,
  ToolSlot,
  TranscriptItem,
  TranscriptView,
} from "@earendil-works/pi-durable";
import type * as Types from "effect/Types";
import { projectEntry, projectMessage, type TranscriptMessage } from "./transcript.ts";

/** A tool call running now, with its streamed output. */
export type RunningTool = {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
};

/**
 * A call a running tool made (a script's call of `read` or `bash`), shown under the call that made it. It stays, done,
 * beside its siblings until that call ends and its own result lists them.
 */
export type NestedTool = {
  readonly callId: string;
  /** The call that made this one: a model-issued call, or another nested call. */
  readonly parentCallId: string;
  readonly name: string;
  readonly args: JsonObject;
  readonly output: string;
  readonly status: "running" | "done";
  /** Whether it ended in an error; false until it has ended. */
  readonly isError: boolean;
  readonly durationMs?: number;
  /** Error text, when it ended in an error that left one. */
  readonly error?: string;
};

/** A submission waiting in the conversation's inbox behind the running work: a steer, a follow-up, or a write. */
export type QueuedInput = Pick<InboxItem, "id" | "mode">;

/**
 * Everything a UI shows for one conversation, projected from pi's conversation view by `projectView`: pi's view is the
 * state, and the projection is the only code that interprets it.
 */
export type SessionView = {
  /**
   * The messages of the transcript the client holds, oldest first: every Context Window's, with the head markers that
   * began them (a Handoff's reset, a compaction summary) where they were written.
   */
  readonly messages: readonly TranscriptMessage[];
  /** Whether the transcript goes back before the oldest message: the thread offers to load the page before it. */
  readonly earlier: boolean;
  /** The assistant message being streamed, or null. */
  readonly live: TranscriptMessage | null;
  readonly running: boolean;
  readonly tools: readonly RunningTool[];
  /** The calls running tools made, in the order they started; see `NestedTool`. */
  readonly nestedTools: readonly NestedTool[];
  /** Submissions queued in pi's inbox behind the running work, in the order pi places them. */
  readonly inbox: readonly QueuedInput[];
  /** Retry backoff pi is waiting out, if any. */
  readonly retry: { readonly at: number; readonly error: string } | null;
  readonly model: { readonly provider: string; readonly modelId: string } | null;
  /** The agent's thinking level; null before the agent has one. */
  readonly thinkingLevel: ModelThinkingLevel | null;
  /** Why the newest run ended without an answer (`pi.live.runFailure`), unless the owner stopped it. */
  readonly error: string | null;
};

/** The view before the first `view` of a conversation. */
export const EMPTY_VIEW: SessionView = {
  messages: [],
  earlier: false,
  live: null,
  running: false,
  tools: [],
  nestedTools: [],
  inbox: [],
  retry: null,
  model: null,
  thinkingLevel: null,
  error: null,
};

const LIVE_ID = "live";

const NONE: readonly never[] = [];

/** The arguments a streaming call shows when its tool does not stream them. */
const NO_ARGUMENTS: JsonObject = {};

/**
 * The names of the tools whose streamed arguments the live message keeps (the Session's App tools,
 * `docs/architecture/mcp-apps.md` → Lifecycle): every other tool's call in the live message shows no arguments until
 * its message is committed, since a card that redrew a growing argument (a long `write`) at every change would cost
 * the transcript per token, and no card draws one before the call ends. `undefined` keeps none.
 */
export type StreamedTools = ReadonlySet<string> | undefined;

/** Why a run ended without an answer, unless the owner stopped it. */
const failure = (failed: RunFailure | undefined): string | null => {
  if (failed === undefined || failed.reason === "aborted") return null;

  return failed.detail === undefined
    ? `Not answered: ${failed.reason}`
    : `Not answered: ${failed.reason}: ${failed.detail}`;
};

type ProjectedItems = Pick<SessionView, "messages" | "earlier">;

/**
 * The messages of a transcript's items. A merge that adds no entries keeps the same items array, so a streamed token
 * does not project them again.
 */
const projectedItems = new WeakMap<readonly TranscriptItem[], ProjectedItems>();

const projectItems = (items: readonly TranscriptItem[]): ProjectedItems => {
  const cached = projectedItems.get(items);

  if (cached !== undefined) return cached;

  const messages = items.flatMap((item): TranscriptMessage[] => {
    if (item.kind !== "entry") return [];

    const message = projectEntry(item.entry);

    return message === undefined ? [] : [message];
  });

  const result = { messages, earlier: items[0]?.kind === "earlier" };

  projectedItems.set(items, result);

  return result;
};

/** The live message as `streamed` shows it, by the partial it is projected from. */
const projectedLive = new WeakMap<
  object,
  { readonly streamed: StreamedTools; readonly message: TranscriptMessage }
>();

const projectLive = (partial: AssistantMessage, streamed: StreamedTools): TranscriptMessage => {
  const cached = projectedLive.get(partial);

  if (cached !== undefined && cached.streamed === streamed) return cached.message;

  const projected = projectMessage(partial, LIVE_ID);

  const parts = projected.parts.map((part) =>
    part.type === "tool-call" && streamed?.has(part.name) !== true
      ? { ...part, arguments: NO_ARGUMENTS }
      : part,
  );

  const message = { ...projected, parts };

  projectedLive.set(partial, { streamed, message });

  return message;
};

/** The running tools of a round, by its slots. */
const projectedTools = new WeakMap<readonly ToolSlot[], readonly RunningTool[]>();

const projectTools = (slots: readonly ToolSlot[] | undefined): readonly RunningTool[] => {
  if (slots === undefined) return NONE;

  const cached = projectedTools.get(slots);

  if (cached !== undefined) return cached;

  const tools = slots
    .filter((slot) => slot.status === "running")
    .map((slot) => ({ callId: slot.callId, name: slot.name, output: slot.output ?? "" }));

  projectedTools.set(slots, tools);

  return tools;
};

/** A nested call as its slot shows it. */
const nestedTool = (slot: NestedToolSlot): NestedTool => {
  const nested: Types.Mutable<NestedTool> = {
    callId: slot.callId,
    parentCallId: slot.parentCallId,
    name: slot.name,
    args: slot.arguments,
    output: slot.status === "done" ? "" : (slot.output ?? ""),
    status: slot.status === "done" ? "done" : "running",
    // A call that faulted or was orphaned is done without a summary: it did not succeed.
    isError: slot.summary?.isError ?? slot.status === "done",
  };

  const { durationMs, error } = slot.summary ?? {};

  if (durationMs !== undefined) nested.durationMs = durationMs;

  if (error !== undefined) nested.error = error;

  return nested;
};

/** The nested calls of the running tools, by their slots. */
const projectedNested = new WeakMap<readonly NestedToolSlot[], readonly NestedTool[]>();

const projectNested = (slots: readonly NestedToolSlot[] | undefined): readonly NestedTool[] => {
  if (slots === undefined) return NONE;

  const cached = projectedNested.get(slots);

  if (cached !== undefined) return cached;

  // A call not started yet is not shown: it has done nothing to show.
  const nested = slots.flatMap((slot) => (slot.status === "pending" ? [] : [nestedTool(slot)]));

  projectedNested.set(slots, nested);

  return nested;
};

/**
 * What a UI shows for a conversation: pi's conversation view, with the client's whole transcript
 * (`ConversationTranscript.merge()`) in place of the window. `streamed` names the tools whose calls in the live message
 * keep their arguments. Pure, so the browser and the tests run the same code.
 */
export const projectView = (view: TranscriptView, streamed?: StreamedTools): SessionView => {
  // SAFETY: pi's built-in documents, keyed by their kind, have pi's shapes.
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  // SAFETY: as above.
  const inbox = view.docs["pi.inbox"] as InboxState | undefined;
  // SAFETY: as above.
  const agent = view.docs["pi.agent"] as AgentState | undefined;
  // SAFETY: the partial is the JSON of pi-ai's assistant message, which has no values JSON cannot hold.
  const partial = live.generation?.message as AssistantMessage | undefined;
  const { messages, earlier } = projectItems(view.items);

  return {
    messages,
    earlier,
    live: partial === undefined ? null : projectLive(partial, streamed),
    running: live.run !== undefined,
    tools: projectTools(live.tools),
    nestedTools: projectNested(live.nestedTools),
    inbox: inbox?.items ?? NONE,
    retry: live.generation?.retry ?? null,
    model: agent?.model ?? null,
    thinkingLevel: agent?.thinkingLevel ?? null,
    error: failure(live.runFailure),
  };
};
