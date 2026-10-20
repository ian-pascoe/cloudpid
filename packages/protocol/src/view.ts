// Adapted from Cloudflare's `agents` repository, `examples/next/harnesses/pi/src/view.ts` as of commit df9c0ef
// https://github.com/cloudflare/agents/blob/df9c0ef6c4541c5552b5ce4d6ba292162dbd0908/examples/next/harnesses/pi/src/view.ts
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
// `const` arrow functions, imports end in `.ts`, `blockPart` guards an undefined first part (`noUncheckedIndexedAccess`),
// the view keeps the inbox's items (`inbox`) instead of their count (`queued`), tool events of nested calls are left
// out of the running tools and kept in `nestedTools` instead, with their output and how they ended (the example
// ignores them), and the view also follows the agent's thinking level (`thinkingLevel`). Formatted for this repository.

// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain TypeScript over pi's arrays, as the example is.

import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type * as Types from "effect/Types";
import type {
  AgentEvent,
  EntryRecord,
  JsonObject,
  MessageChange,
  SnapshotEvent,
} from "@earendil-works/pi-durable";
import {
  projectEntries,
  projectEntry,
  projectMessage,
  type TranscriptMessage,
  type TranscriptPart,
} from "./transcript.ts";

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

/** A submission waiting in the conversation's inbox behind the running work. */
export type QueuedInput = SnapshotEvent["inbox"][number];

/** Everything a UI shows for one conversation, derived from pi's agent events by `reduceView`. */
export type SessionView = {
  readonly messages: readonly TranscriptMessage[];
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
  readonly error: string | null;
};

/** The view before any event. */
export const EMPTY_VIEW: SessionView = {
  messages: [],
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

const append = (view: SessionView, entry: EntryRecord): SessionView => {
  const message = projectEntry(entry);

  if (message === undefined) return view;

  // A reset starts a new context; the snapshot shows only the active one.
  if (entry.kind === "pi.reset") return { ...view, messages: [message] };

  if (view.messages.some((known) => known.id === message.id)) return view;

  return { ...view, messages: [...view.messages, message] };
};

const blockPart = (block: AssistantMessage["content"][number]): TranscriptPart | undefined =>
  projectMessage(
    {
      role: "assistant",
      content: [block],
      api: "",
      provider: "",
      model: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
    LIVE_ID,
  ).parts[0];

const applyChanges = (
  live: TranscriptMessage | null,
  changes: readonly MessageChange[],
): TranscriptMessage | null => {
  let message = live;

  for (const change of changes) {
    if (change.type === "message") {
      message = projectMessage(change.message, LIVE_ID);

      continue;
    }

    if (message === null) continue;

    const parts = [...message.parts];
    const previous = parts[change.contentIndex];

    switch (change.type) {
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
      case "block": {
        const part = blockPart(change.block);

        if (part !== undefined) parts[change.contentIndex] = part;

        break;
      }

      case "text_delta":
        parts[change.contentIndex] = {
          type: "text",
          text: (previous?.type === "text" ? previous.text : "") + change.delta,
        };

        break;
      case "thinking_delta":
        parts[change.contentIndex] = {
          type: "thinking",
          text: (previous?.type === "thinking" ? previous.text : "") + change.delta,
        };

        break;
      case "toolcall_delta":
        // Partial argument JSON; the call renders once its block completes.
        break;
    }

    message = { ...message, parts };
  }

  return message;
};

/** A nested call as a snapshot lists it. */
const snapshotNestedTool = (slot: SnapshotEvent["nestedTools"][number]): NestedTool => {
  const nested: Types.Mutable<NestedTool> = {
    callId: slot.callId,
    parentCallId: slot.parentCallId,
    name: slot.name,
    args: slot.arguments,
    output: slot.output ?? "",
    status: slot.status === "done" ? "done" : "running",
    isError: slot.summary?.isError ?? false,
  };

  const { durationMs, error } = slot.summary ?? {};

  if (durationMs !== undefined) nested.durationMs = durationMs;

  if (error !== undefined) nested.error = error;

  return nested;
};

/** A running tool's output after an update: its window trimmed at the front and appended to, or replaced. */
const nextOutput = (
  current: string,
  update: { readonly trimStart?: number; readonly append?: string } | { readonly set: string },
): string =>
  "set" in update ? update.set : current.slice(update.trimStart ?? 0) + (update.append ?? "");

/** `nested` without the calls below call `callId`, which settled, however deep. */
const withoutDescendants = (
  nested: readonly NestedTool[],
  callId: string,
): readonly NestedTool[] => {
  const gone = new Set([callId]);

  // A parent starts before its children, so one pass in order finds them all.
  return nested.filter((tool) => {
    if (!gone.has(tool.parentCallId)) return true;

    gone.add(tool.callId);

    return false;
  });
};

/**
 * Fold one of pi's agent events into the view. Pure: pi's events are the wire format, and this reducer is the only
 * code that interprets them.
 */
export const reduceView = (view: SessionView, event: AgentEvent): SessionView => {
  switch (event.type) {
    case "snapshot": {
      const partial = event.generation?.message;

      return {
        messages: projectEntries(event.entries),
        live: partial === undefined ? null : projectMessage(partial, LIVE_ID),
        running: event.run !== undefined,
        tools: event.tools
          .filter((slot) => slot.status === "running")
          .map((slot) => ({ callId: slot.callId, name: slot.name, output: slot.output ?? "" })),
        nestedTools: event.nestedTools.map(snapshotNestedTool),
        inbox: event.inbox,
        retry: event.generation?.retry ?? null,
        model: event.agent.model ?? null,
        thinkingLevel: event.agent.thinkingLevel ?? null,
        error: null,
      };
    }

    case "run_start":
      return { ...view, running: true, error: null };
    case "run_end":
      return { ...view, running: false, live: null, tools: [], nestedTools: [], retry: null };
    case "message_start":
      return event.message.role === "assistant"
        ? { ...view, live: projectMessage(event.message, LIVE_ID) }
        : view;
    case "message_update":
      return { ...view, live: applyChanges(view.live, event.changes) };
    case "message_end": {
      const next = append(view, event.entry);

      return event.entry.model?.[0]?.role === "assistant" ? { ...next, live: null } : next;
    }

    case "entry_appended":
      return append(view, event.entry);
    case "tool_execution_start":
      // A nested call belongs to the tool call that made it, which shows it.
      if (event.parentToolCallId !== undefined) {
        return {
          ...view,
          nestedTools: [
            ...view.nestedTools.filter((tool) => tool.callId !== event.toolCallId),
            {
              callId: event.toolCallId,
              parentCallId: event.parentToolCallId,
              name: event.toolName,
              args: event.args,
              output: "",
              status: "running",
              isError: false,
            },
          ],
        };
      }

      return {
        ...view,
        tools: [
          ...view.tools.filter((tool) => tool.callId !== event.toolCallId),
          { callId: event.toolCallId, name: event.toolName, output: "" },
        ],
      };
    case "tool_execution_update": {
      const output = event.output;

      if (output === undefined) return view;

      if (event.parentToolCallId !== undefined) {
        return {
          ...view,
          nestedTools: view.nestedTools.map((tool) =>
            tool.callId === event.toolCallId
              ? { ...tool, output: nextOutput(tool.output, output) }
              : tool,
          ),
        };
      }

      return {
        ...view,
        tools: view.tools.map((tool) =>
          tool.callId === event.toolCallId
            ? { ...tool, output: nextOutput(tool.output, output) }
            : tool,
        ),
      };
    }

    case "tool_execution_end": {
      if (event.parentToolCallId !== undefined) {
        const { result } = event;

        return {
          ...view,
          nestedTools: view.nestedTools.map((tool): NestedTool => {
            if (tool.callId !== event.toolCallId) return tool;

            const done: NestedTool = {
              ...tool,
              status: "done",
              // A call with no result faulted or was orphaned: it did not succeed.
              isError: result?.isError ?? true,
            };

            return result?.durationMs === undefined
              ? done
              : { ...done, durationMs: result.durationMs };
          }),
        };
      }

      // What it made is listed by its result, which a transcript entry carries.
      return {
        ...view,
        tools: view.tools.filter((tool) => tool.callId !== event.toolCallId),
        nestedTools: withoutDescendants(view.nestedTools, event.toolCallId),
      };
    }

    case "inbox_update":
      return { ...view, inbox: event.items };
    case "auto_retry_start":
      return { ...view, retry: { at: event.at, error: event.errorMessage } };
    case "auto_retry_end":
      return { ...view, retry: null };
    case "agent_changed":
      return {
        ...view,
        model: event.agent.model ?? null,
        thinkingLevel: event.agent.thinkingLevel ?? null,
      };
    case "task_failed":
      return { ...view, error: event.message };
    case "submission":
      return event.record.status === "unanswered" &&
        event.record.reason !== "aborted" &&
        event.record.reason !== "withdrawn"
        ? { ...view, error: `Not answered: ${event.record.reason}` }
        : view;
    default:
      return view;
  }
};

/** Fold a batch of events, in order. */
export const reduceEvents = (view: SessionView, events: readonly AgentEvent[]): SessionView =>
  events.reduce(reduceView, view);
