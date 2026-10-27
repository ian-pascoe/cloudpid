// A `SessionView` as assistant-ui's thread: pi's transcript alternates assistant messages and tool results, which
// assistant-ui shows as one assistant message per turn, with each tool result on its call.

// @effect-diagnostics globalDate:off preferEffectArray:off -- plain functions over native arrays; assistant-ui's messages carry a Date.

import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  AttachedPage,
  type SessionView,
  ShownReviewAnnotation,
  type TranscriptMessage,
  type TranscriptPart,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { type CallDiff, callDiffOf } from "../call-diff.ts";
import { madeChanges, type ShownChange } from "../chat/agent-change.ts";
import { liveCalls, type NestedCall, settledCalls } from "../chat/nested-calls.ts";
import { type StartedSubagent, startedSubagent } from "../chat/subagent.ts";
import { entryIdOf } from "./tree.ts";

type ContentPart = Exclude<ThreadMessageLike["content"], string>[number];

type Status = NonNullable<ThreadMessageLike["status"]>;

/** What pi produced between two user messages, as one assistant message, while it is being put together. */
interface Turn {
  readonly id: string;
  readonly createdAt: Date | undefined;
  readonly content: ContentPart[];
  status: Status;
  /** Its last committed assistant message's ID (its pi entry's): where the Session tree's bar under it points. */
  answer?: string;
  /** The IDs of its committed messages, assistant and tool alike: where a Session branch may start in it. */
  readonly entries: string[];
}

/** The turn before any user message (a Session can start with a queued run, or have its first message compacted). */
const START = "start";

const dateOf = (timestamp: number): Date | undefined =>
  timestamp === 0 ? undefined : new Date(timestamp);

const textOf = (content: readonly TranscriptPart[]): string => {
  const lines: string[] = [];

  for (const part of content) {
    if (part.type === "text") lines.push(part.text);
    else if (part.type === "image") lines.push("[image]");
  }

  return lines.join("\n");
};

/** The image types a card shows: what a page returned is not shown as an SVG or any other type. */
const SHOWN_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

/** The images in a tool result that a card shows. */
const shownImages = (
  content: readonly TranscriptPart[],
): { readonly mimeType: string; readonly data: string }[] =>
  content.flatMap((part) =>
    part.type === "image" && SHOWN_IMAGE_TYPES.has(part.mimeType)
      ? [{ mimeType: part.mimeType, data: part.data }]
      : [],
  );

/** A user message's parts: its text parts (what was typed, then any Attachments' paths) as one text, a paragraph apart. */
const userContent = (parts: readonly TranscriptPart[]): ContentPart[] => {
  const content: ContentPart[] = [];

  for (const part of parts) {
    const last = content.at(-1);

    if (part.type === "text" && last?.type === "text") {
      content[content.length - 1] = { type: "text", text: `${last.text}\n\n${part.text}` };
    } else if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "image") {
      content.push({ type: "image", image: `data:${part.mimeType};base64,${part.data}` });
    }
  }

  return content;
};

const statusOf = (message: TranscriptMessage): Status => {
  if (message.stopReason === "error") {
    return { type: "incomplete", reason: "error", error: message.error ?? "The model failed" };
  }

  if (message.stopReason === "aborted") return { type: "incomplete", reason: "cancelled" };

  return { type: "complete", reason: "stop" };
};

const assistantParts = (message: TranscriptMessage): ContentPart[] => {
  const content: ContentPart[] = [];

  for (const part of message.parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "thinking") content.push({ type: "reasoning", text: part.text });
    else if (part.type === "tool-call") {
      content.push({
        type: "tool-call",
        toolCallId: part.id,
        toolName: part.name,
        args:
          Predicate.isObject(part.arguments) && !Array.isArray(part.arguments)
            ? part.arguments
            : {},
      });
    }
  }

  return content;
};

/** Put a tool result on its call. */
const resolveCall = (
  turn: Turn | undefined,
  result: Extract<TranscriptPart, { type: "tool-result" }>,
) => {
  const index = turn?.content.findIndex(
    (part) => part.type === "tool-call" && part.toolCallId === result.id,
  );

  const call = index === undefined ? undefined : turn?.content[index];

  if (index !== undefined && call?.type === "tool-call") {
    const nested = settledCalls(result.details);
    const subagent = result.name === "subagent" ? startedSubagent(result.details) : undefined;
    const images = shownImages(result.content);
    const changes = madeChanges(result.details);
    const diff = callDiffOf(result.name, result.details, result.error);

    const resolved = { ...call, result: textOf(result.content), isError: result.error };

    // What a tool left besides its text: the calls it made, which its result lists once it has ended, the subagent a
    // `subagent` call started, the images it returned (a browser's screenshots), the Agent change it made, and the patch an
    // `edit` or `write` recorded (its Call diff).
    const artifact: CardArtifact = {};

    if (nested.length > 0) artifact.nested = nested;

    if (subagent !== undefined) artifact.subagent = subagent;

    if (images.length > 0) artifact.images = images;

    if (changes.length > 0) artifact.changes = changes;

    if (diff !== undefined) artifact.diff = diff;

    turn?.content.splice(
      index,
      1,
      nested.length === 0 &&
        subagent === undefined &&
        images.length === 0 &&
        changes.length === 0 &&
        diff === undefined
        ? resolved
        : { ...resolved, artifact },
    );
  }
};

/** What a tool call's card shows beside its arguments and result. */
type CardArtifact = {
  nested?: NestedCall[];
  subagent?: StartedSubagent;
  images?: { readonly mimeType: string; readonly data: string }[];
  changes?: ReadonlyArray<ShownChange>;
  diff?: CallDiff;
};

const userMessage = new WeakMap<TranscriptMessage, ThreadMessageLike>();

/** A Skill an owner's message carries, as its disclosure shows it: its name, and the block the model got. */
export const ShownSkill = Schema.Struct({ name: Schema.String, text: Schema.String });

export type ShownSkill = typeof ShownSkill.Type;

const decodeSkills = Schema.decodeUnknownOption(Schema.Array(ShownSkill));

/** What a message's metadata keeps for this app: a notice's `title`, a user message's `skills` and `review`. */
type MessageCustom = NonNullable<NonNullable<ThreadMessageLike["metadata"]>["custom"]>;

/** The Skills a user message's metadata keeps; none when it has none. */
export const shownSkills = (custom: MessageCustom | undefined): readonly ShownSkill[] =>
  Option.getOrElse(decodeSkills(custom?.["skills"]), () => []);

const decodePages = Schema.decodeUnknownOption(Schema.Array(AttachedPage));

/** The pages attached to a user message, as its metadata keeps them; none when it has none. */
export const shownPages = (custom: MessageCustom | undefined): readonly AttachedPage[] =>
  Option.getOrElse(decodePages(custom?.["pages"]), () => []);

const decodeReview = Schema.decodeUnknownOption(Schema.Array(ShownReviewAnnotation));

/** The Annotations of a Review a user message's metadata keeps; none for a message that is not one. */
export const shownReview = (
  custom: MessageCustom | undefined,
): readonly ShownReviewAnnotation[] =>
  Option.getOrElse(decodeReview(custom?.["review"]), () => []);

/** A turn followed by a user message cannot change, so its message is made once and handed out again. */
const finishedTurn = new WeakMap<
  TranscriptMessage,
  {
    readonly userId: string;
    readonly sources: readonly TranscriptMessage[];
    readonly message: ThreadMessageLike;
  }
>();

const sameMessages = (a: readonly TranscriptMessage[], b: readonly TranscriptMessage[]): boolean =>
  a.length === b.length && a.every((message, index) => message === b[index]);

const toUser = (message: TranscriptMessage): ThreadMessageLike => {
  let made = userMessage.get(message);

  if (made === undefined) {
    made = {
      id: message.id,
      role: "user",
      content: userContent(message.parts),
      createdAt: dateOf(message.timestamp),
    };

    // The Skills the Session expanded into it show under the typed text, each as the block the model got, the pages
    // attached to it as chips, and a Review's Annotations as chips under its summary, each opening on the code it quoted.
    const skills: ShownSkill[] = (message.skills ?? []).map(({ name, text }) => ({ name, text }));
    const pages = message.pages ?? [];
    const review = message.review ?? [];

    if (skills.length > 0 || pages.length > 0 || review.length > 0) {
      const custom: MessageCustom = {};

      if (skills.length > 0) custom["skills"] = skills;

      if (pages.length > 0) custom["pages"] = pages.map((page) => ({ ...page }));

      if (review.length > 0) custom["review"] = review.map((annotation) => ({ ...annotation }));

      made = { ...made, metadata: { custom } };
    }

    userMessage.set(message, made);
  }

  return made;
};

const noticeMessage = new WeakMap<TranscriptMessage, ThreadMessageLike>();

/** A notice (a Handoff, a compaction, a Rollover request) as a system message, its title in the metadata. */
const toNotice = (message: TranscriptMessage): ThreadMessageLike => {
  let made = noticeMessage.get(message);

  if (made === undefined) {
    made = {
      id: message.id,
      role: "system",
      content: [{ type: "text", text: textOf(message.parts) }],
      createdAt: dateOf(message.timestamp),
      metadata: { custom: { title: message.title ?? "Notice" } },
    };
    noticeMessage.set(message, made);
  }

  return made;
};

/**
 * The turn of `group` (the assistant and tool messages after a user message, in order), then `live` if there is a
 * streaming message. Its ID comes from the user message before it, so it is the same while the answer streams and
 * after it is committed, and assistant-ui keeps the message it already renders instead of replacing it.
 */
const buildTurn = (
  userId: string,
  group: readonly TranscriptMessage[],
  live: TranscriptMessage | null,
): Turn | undefined => {
  let turn: Turn | undefined;

  const addAssistant = (message: TranscriptMessage, status: Status) => {
    turn ??= {
      id: `${userId}:reply`,
      createdAt: dateOf(message.timestamp),
      content: [],
      status,
      entries: [],
    };

    turn.content.push(...assistantParts(message));
    turn.status = status;

    if (status.type !== "running") {
      turn.answer = message.id;
      turn.entries.push(message.id);
    }
  };

  for (const message of group) {
    if (message.role === "assistant") addAssistant(message, statusOf(message));
    else if (message.role === "tool") {
      for (const part of message.parts) if (part.type === "tool-result") resolveCall(turn, part);

      turn?.entries.push(message.id);
    }
  }

  if (live !== null) addAssistant(live, { type: "running" });

  return turn;
};

const toAssistant = (turn: Turn): ThreadMessageLike => {
  const message: ThreadMessageLike = {
    role: "assistant",
    id: turn.id,
    createdAt: turn.createdAt,
    content: turn.content,
    status: turn.status,
  };

  return {
    ...message,
    metadata: {
      custom:
        turn.answer === undefined
          ? { entries: turn.entries }
          : { answer: turn.answer, entries: turn.entries },
    },
  };
};

const decodeEntries = Schema.decodeUnknownOption(Schema.Array(Schema.String));

/** The pi entry IDs of the committed messages an assistant message's turn holds, from its metadata. */
export const entriesOf = (custom: MessageCustom | undefined): readonly number[] =>
  Option.match(decodeEntries(custom?.["entries"]), {
    onNone: () => [],
    onSome: (ids) =>
      ids.flatMap((id) => {
        const entry = entryIdOf(id);

        return entry === undefined ? [] : [entry];
      }),
  });

/** The entry ID of the answer an assistant message's turn ended with, from its metadata; undefined while it runs. */
export const answerOf = (custom: MessageCustom | undefined): number | undefined => {
  const answer = custom?.["answer"];

  return Predicate.isString(answer) ? entryIdOf(answer) : undefined;
};

/** The last turn: its tool calls without a result are running, and may have streamed output. */
const withRunning = (turn: Turn, view: SessionView): Turn => {
  // The run goes on between messages, while a tool executes.
  if (view.running) turn.status = { type: "running" };

  for (const [index, part] of turn.content.entries()) {
    const tool =
      part.type === "tool-call" && !("result" in part)
        ? view.tools.find((running) => running.callId === part.toolCallId)
        : undefined;

    if (part.type === "tool-call" && tool !== undefined) {
      turn.content[index] = {
        ...part,
        artifact: { output: tool.output, nested: liveCalls(view.nestedTools, tool.callId) },
      };
    }
  }

  return turn;
};

/**
 * The thread of `view`, its earlier messages first: user messages, notices as system messages, and one assistant
 * message per turn holding thinking, text, and tool calls.
 * The message being streamed is part of the last turn, and the last turn is running while the run is. The messages
 * before the last turn are the same objects from one view to the next, so a long transcript costs only its last
 * turn when a token arrives.
 */
export const toThreadMessages = (view: SessionView): ThreadMessageLike[] => {
  const thread: ThreadMessageLike[] = [];
  let userId = START;
  let group: TranscriptMessage[] = [];

  // A turn that a user message follows.
  const endTurn = () => {
    const first = group[0];

    if (first === undefined) return;

    const sources = group;

    group = [];

    const cached = finishedTurn.get(first);

    if (cached?.userId === userId && sameMessages(cached.sources, sources)) {
      thread.push(cached.message);

      return;
    }

    const turn = buildTurn(userId, sources, null);

    if (turn === undefined) return;

    const message = toAssistant(turn);

    finishedTurn.set(first, { userId, sources, message });
    thread.push(message);
  };

  // The earlier Context Windows' messages come first: the thread is the whole History the view holds.
  for (const message of [...view.earlier, ...view.messages]) {
    if (message.role === "user" || message.role === "notice") {
      // A notice starts a turn too: what the agent does after a Handoff or a Rollover request answers it.
      endTurn();
      userId = message.id;
      thread.push(message.role === "user" ? toUser(message) : toNotice(message));
    } else if (message.role === "assistant" || message.role === "tool") group.push(message);
  }

  const last = buildTurn(userId, group, view.live);

  if (last !== undefined) thread.push(toAssistant(withRunning(last, view)));

  return thread;
};
