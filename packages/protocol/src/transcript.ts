// Adapted from Cloudflare's `agents` repository, `examples/next/harnesses/pi/src/transcript.ts` as of commit 1e54cf1
// https://github.com/cloudflare/agents/blob/1e54cf19d747f122c141e0eb323226ec8b4d4865/examples/next/harnesses/pi/src/transcript.ts
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
// Changes: types renamed (`PiMessage` → `TranscriptMessage`, `PiMessagePart` → `TranscriptPart`), functions written as
// `const` arrow functions, `Predicate.isString` for the typeof check, and `projectMessage` builds its result in steps.
// Resets, compaction summaries, and extension entries with a `notice` title in their data project as titled notices; an
// owner's message the Session expanded (`cloudpid.user`) projects as what the owner typed, with its Skills beside it.
// Formatted for this repository.

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
import type { PageCrop } from "./annotations.ts";
import { type AttachedPage, isPageBlock } from "./attached-pages.ts";
import { reviewTitle, type ShownReviewAnnotation, shownReview } from "./review.ts";
import { skillBlocksIn, type UserEntryData, userEntryData } from "./user-entry.ts";

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

/** A Skill the Session expanded into an owner's message: its name, its `SKILL.md`, and the block the model got. */
export type TranscriptSkill = {
  readonly name: string;
  readonly location: string;
  readonly text: string;
};

/** One display-ready message projected from a pi transcript entry. */
export type TranscriptMessage = {
  /** The pi entry ID, or `live` for the message being streamed. */
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice";
  /** A notice's heading, such as `Handoff`; its parts hold the text it carried, if any. */
  readonly title?: string;
  readonly parts: readonly TranscriptPart[];
  readonly timestamp: number;
  readonly stopReason?: string;
  readonly error?: string;
  /** The Skills the Session expanded into an owner's message, which shows the typed text instead. */
  readonly skills?: readonly TranscriptSkill[];
  /** The pages attached to an owner's message, which shows a chip for each instead of the block the model got. */
  readonly pages?: readonly AttachedPage[];
  /** A Review's Annotations, each with its quote and the owner's text: the message shows its summary instead. */
  readonly review?: readonly ShownReviewAnnotation[];
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

/** The title of an entry shown as a notice, or `undefined` for an entry shown as its message. */
const noticeTitle = (entry: EntryRecord): string | undefined => {
  if (entry.kind === "pi.reset") return entry.model === undefined ? "Context reset" : "Handoff";

  if (entry.kind === "pi.compaction") {
    const reason = Predicate.hasProperty(entry.data, "reason") ? entry.data.reason : undefined;

    return Predicate.isString(reason) ? `Context compacted (${reason})` : "Context compacted";
  }

  // An extension's own entry kind asks to be a notice with a `notice` title in its data.
  const notice =
    !entry.kind.startsWith("pi.") && Predicate.hasProperty(entry.data, "notice")
      ? entry.data.notice
      : undefined;

  return Predicate.isString(notice) ? notice : undefined;
};

/**
 * `parts` without the block of attached pages the Session added (the last text part shaped like one: the owner's own
 * text comes before it).
 */
const withoutPageBlock = (parts: readonly TranscriptPart[]): TranscriptPart[] => {
  const at = parts.findLastIndex((part) => part.type === "text" && isPageBlock(part.text));

  return parts.filter((_, index) => index !== at);
};

/**
 * `parts` without the crops of a Review's page Annotations (`ReviewData.crops`: a label and an image each, the last parts
 * of the message), and the crops, in order, for the Review's chips.
 */
const withoutCrops = (
  parts: readonly TranscriptPart[],
  data: UserEntryData,
): { readonly parts: readonly TranscriptPart[]; readonly crops: readonly PageCrop[] } => {
  const count = data.review?.crops?.length ?? 0;

  if (count === 0 || parts.length < count * 2) return { parts, crops: [] };

  const at = parts.length - count * 2;

  const crops = parts.slice(at).flatMap((part): PageCrop[] => {
    if (part.type !== "image") return [];

    const { mimeType } = part;

    return mimeType === "image/jpeg" || mimeType === "image/png" || mimeType === "image/webp"
      ? [{ mimeType, data: part.data }]
      : [];
  });

  return { parts: parts.slice(0, at), crops };
};

/**
 * An owner's message the Session expanded or attached pages to, as the owner typed it: the typed text in place of the
 * expansion, which is the message's first text part (left as it is when the owner typed none), its other parts as they
 * were but for the block of page content, which a chip per page replaces, and each expanded Skill with the block the
 * model got. A Review shows its summary, or "Review: n Annotations" without one, and carries its Annotations, read from
 * the Markdown that ends the first text.
 */
const typedMessage = (entry: EntryRecord): TranscriptMessage | undefined => {
  const data = userEntryData(entry);
  const message = entry.model?.[0];

  if (data === undefined || message?.role !== "user") return undefined;

  const { parts: carried, crops } = withoutCrops(userParts(message.content), data);
  const parts = data.pages === undefined ? carried : withoutPageBlock(carried);
  const first = parts.findIndex((part) => part.type === "text");
  const expanded = parts[first];
  const text = expanded?.type === "text" ? expanded.text : "";
  const review = data.review === undefined ? undefined : shownReview(text, data.review, crops);

  // The Skills' blocks are in what comes before the Review's Markdown.
  const blocks = skillBlocksIn(
    data.review === undefined
      ? text
      : text.slice(0, Math.max(0, text.length - data.review.length)).trimEnd(),
    data,
  );

  const display =
    review !== undefined && data.display.trim() === "" ? reviewTitle(review.length) : data.display;

  const typed: TranscriptPart = { type: "text", text: display };

  const shown =
    display === ""
      ? parts
      : first === -1
        ? [typed, ...parts]
        : parts.map((part, index) => (index === first ? typed : part));

  const projected: TranscriptMessage = {
    id: String(entry.id),
    role: "user",
    parts: shown,
    timestamp: message.timestamp,
    skills: data.skills.map((skill, index) => ({ ...skill, text: blocks[index] ?? "" })),
  };

  const paged =
    data.pages === undefined || data.pages.length === 0
      ? projected
      : { ...projected, pages: data.pages };

  return review === undefined ? paged : { ...paged, review };
};

/**
 * Project one transcript entry. Entries that carry a model message become that message; a reset (with the Handoff it
 * carries), a compaction summary, and an extension's entry whose data has a `notice` title become notices; an owner's
 * message the Session expanded shows what the owner typed; system-prompt entries and other bookkeeping have no
 * projection.
 */
export const projectEntry = (entry: EntryRecord): TranscriptMessage | undefined => {
  const message = entry.model?.[0];
  const title = noticeTitle(entry);

  if (title !== undefined) {
    return {
      id: String(entry.id),
      role: "notice",
      title,
      parts: message?.role === "user" ? userParts(message.content) : [],
      timestamp: message?.timestamp ?? 0,
    };
  }

  if (entry.kind === "pi.system" || message === undefined) return undefined;

  const typed = typedMessage(entry);

  if (typed !== undefined) return typed;

  return projectMessage(message, String(entry.id));
};

/** Project a snapshot's entries. */
export const projectEntries = (entries: readonly EntryRecord[]): TranscriptMessage[] =>
  entries.flatMap((entry) => {
    const message = projectEntry(entry);

    return message === undefined ? [] : [message];
  });
