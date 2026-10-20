// A `SessionView` as assistant-ui's thread: pi's transcript alternates assistant messages and tool results, which
// assistant-ui shows as one assistant message per turn, with each tool result on its call.
import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SessionView, TranscriptMessage, TranscriptPart } from "@cloudpid/protocol";
import * as Predicate from "effect/Predicate";

type ContentPart = Exclude<ThreadMessageLike["content"], string>[number];

type Status = NonNullable<ThreadMessageLike["status"]>;

/** What pi produced between two user messages, as one assistant message. */
interface Turn {
  readonly id: string;
  readonly createdAt: Date | undefined;
  readonly content: ContentPart[];
  status: Status;
}

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

const userContent = (parts: readonly TranscriptPart[]): ContentPart[] => {
  const content: ContentPart[] = [];

  for (const part of parts) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
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
    turn?.content.splice(index, 1, {
      ...call,
      result: textOf(result.content),
      isError: result.error,
    });
  }
};

/**
 * The thread of `view`: user messages, and one assistant message per turn holding thinking, text, and tool calls.
 * The message being streamed is part of the last turn, and a turn is running while the run is.
 */
export const toThreadMessages = (view: SessionView): ThreadMessageLike[] => {
  const thread: Array<ThreadMessageLike | Turn> = [];
  let turn: Turn | undefined;

  const addAssistant = (message: TranscriptMessage, status: Status) => {
    if (turn === undefined) {
      turn = { id: message.id, createdAt: dateOf(message.timestamp), content: [], status };
      thread.push(turn);
    }

    turn.content.push(...assistantParts(message));
    turn.status = status;
  };

  for (const message of view.messages) {
    if (message.role === "user") {
      turn = undefined;
      thread.push({
        id: message.id,
        role: "user",
        content: userContent(message.parts),
        createdAt: dateOf(message.timestamp),
      });
    } else if (message.role === "assistant") addAssistant(message, statusOf(message));
    else if (message.role === "tool") {
      for (const part of message.parts) if (part.type === "tool-result") resolveCall(turn, part);
    }
  }

  if (view.live !== null) addAssistant(view.live, { type: "running" });

  const turns = thread.filter((item): item is Turn => !("role" in item));
  const lastTurn = turns.at(-1);

  // The run goes on between messages, while a tool executes.
  if (view.running && lastTurn !== undefined && thread.at(-1) === lastTurn) {
    lastTurn.status = { type: "running" };
  }

  // A tool call without a result is running, and may have streamed output.
  for (const item of turns) {
    for (const [index, part] of item.content.entries()) {
      const tool =
        part.type === "tool-call" && !("result" in part)
          ? view.tools.find((running) => running.callId === part.toolCallId)
          : undefined;

      if (part.type === "tool-call" && tool !== undefined) {
        item.content[index] = { ...part, artifact: { output: tool.output } };
      }
    }
  }

  return thread.map((item) =>
    "role" in item
      ? item
      : {
          role: "assistant",
          id: item.id,
          createdAt: item.createdAt,
          content: item.content,
          status: item.status,
        },
  );
};
