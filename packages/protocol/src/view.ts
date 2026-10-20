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
// out of the running tools, and the view also follows the agent's thinking level (`thinkingLevel`). Formatted for this repository.

// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain TypeScript over pi's arrays, as the example is.

import type { AssistantMessage, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AgentEvent,
  EntryRecord,
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

/** A submission waiting in the conversation's inbox behind the running work. */
export type QueuedInput = SnapshotEvent["inbox"][number];

/** Everything a UI shows for one conversation, derived from pi's agent events by `reduceView`. */
export type SessionView = {
  readonly messages: readonly TranscriptMessage[];
  /** The assistant message being streamed, or null. */
  readonly live: TranscriptMessage | null;
  readonly running: boolean;
  readonly tools: readonly RunningTool[];
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
      return { ...view, running: false, live: null, tools: [], retry: null };
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
      if (event.parentToolCallId !== undefined) return view;

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

      return {
        ...view,
        tools: view.tools.map((tool) => {
          if (tool.callId !== event.toolCallId) return tool;

          if ("set" in output) return { ...tool, output: output.set };

          return {
            ...tool,
            output: tool.output.slice(output.trimStart ?? 0) + (output.append ?? ""),
          };
        }),
      };
    }

    case "tool_execution_end":
      return { ...view, tools: view.tools.filter((tool) => tool.callId !== event.toolCallId) };
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
