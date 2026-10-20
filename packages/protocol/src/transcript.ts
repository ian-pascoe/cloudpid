// Adapted from Cloudflare's `agents` repository, `examples/next/harnesses/pi/src/transcript.ts`
// https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi
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
// Changes: formatted for this repository, relative imports end in `.ts`, the view keeps the inbox's items instead of
// their count, and tool events of nested calls are left out of the running tools.

// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain TypeScript over pi's arrays, as the example is.

import type {
  AssistantMessage,
  ImageContent,
  JsonValue,
  Message,
  TextContent,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import * as Predicate from "effect/Predicate";

/**
 * The display model of a transcript. The Session returns pi's own entries; the UI folds them into these messages, in
 * the browser for a snapshot and for streamed events alike.
 */
export type TranscriptPart =
  | TextContent
  | ImageContent
  | { readonly type: "thinking"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: JsonValue;
    }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly content: readonly (TextContent | ImageContent)[];
      readonly details?: JsonValue;
      readonly error: boolean;
    };

/** One display-ready message projected from a pi transcript entry. */
export type TranscriptMessage = {
  /** The pi entry ID, or `live` for the message being streamed. */
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice";
  readonly parts: readonly TranscriptPart[];
  readonly timestamp: number;
  readonly stopReason?: string;
  readonly error?: string;
};

const userParts = (content: UserMessage["content"]): TranscriptPart[] =>
  Predicate.isString(content) ? [{ type: "text", text: content }] : [...content];

const assistantParts = (content: AssistantMessage["content"]): TranscriptPart[] =>
  content.map((part): TranscriptPart => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "thinking":
        return { type: "thinking", text: part.thinking };
      case "toolCall":
        return { type: "tool-call", id: part.id, name: part.name, arguments: part.arguments };
    }
  });

/** Project one pi-ai message. */
export const projectMessage = (message: Message, id: string): TranscriptMessage => {
  switch (message.role) {
    case "system":
      // pi records prompt changes as system entries; the UI does not show them.
      return { id, role: "notice", parts: [], timestamp: 0 };
    case "user":
      return {
        id,
        role: "user",
        parts: userParts(message.content),
        timestamp: message.timestamp,
      };
    case "assistant": {
      const projected: TranscriptMessage = {
        id,
        role: "assistant",
        parts: assistantParts(message.content),
        timestamp: message.timestamp,
        stopReason: message.stopReason,
      };

      return message.errorMessage === undefined
        ? projected
        : { ...projected, error: message.errorMessage };
    }

    case "toolResult": {
      const result: TranscriptPart = {
        type: "tool-result",
        id: message.toolCallId,
        name: message.toolName,
        content: message.content,
        error: message.isError,
      };

      return {
        id,
        role: "tool",
        parts: [message.details === undefined ? result : { ...result, details: message.details }],
        timestamp: message.timestamp,
      };
    }
  }
};

/**
 * Project one transcript entry. Entries that carry a model message become that message; a reset becomes a notice;
 * system-prompt entries and other bookkeeping have no projection.
 */
export const projectEntry = (entry: EntryRecord): TranscriptMessage | undefined => {
  const message = entry.model?.[0];

  if (entry.kind === "pi.reset") {
    return {
      id: String(entry.id),
      role: "notice",
      parts: [{ type: "text", text: "Context reset" }],
      timestamp: 0,
    };
  }

  if (entry.kind === "pi.system" || message === undefined) return undefined;

  return projectMessage(message, String(entry.id));
};

/** Project a snapshot's entries. */
export const projectEntries = (entries: readonly EntryRecord[]): TranscriptMessage[] =>
  entries.flatMap((entry) => {
    const message = projectEntry(entry);

    return message === undefined ? [] : [message];
  });
