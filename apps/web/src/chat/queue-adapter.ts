// The Session's inbox as assistant-ui's queue lanes: steers are its steer lane, follow-ups its queue lane. The inbox
// lives in the Session, so sending is a `submit` with `whenBusy`, and an item leaves its lane when pi places it.

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over assistant-ui's native arrays, not combinators.

import type {
  AppendMessage,
  ExternalThreadQueueAdapter,
  QueueItemState,
} from "@assistant-ui/react";
import type { WhenBusy } from "@cloudpid/protocol";
import type { QueuedEntry, QueueLanes } from "../session/state.ts";

/** Where the lanes send what is typed: a submit to the conversation (`submitAtom`). */
export interface QueueTarget {
  readonly submit: (text: string, whenBusy: WhenBusy) => void;
}

/** What the user typed, as text. */
export const textOf = (message: AppendMessage): string => {
  const lines: string[] = [];

  for (const part of message.content) if (part.type === "text") lines.push(part.text);

  return lines.join("\n");
};

/** Shown for an input this page did not send, as it cannot know its text. */
export const UNKNOWN_QUEUED_TEXT = "Message sent from another page";

const queueItem = (entry: QueuedEntry): QueueItemState => {
  const text = entry.text ?? UNKNOWN_QUEUED_TEXT;

  return { id: entry.id, prompt: text, parts: [{ type: "text", text }] };
};

/**
 * pi cannot move, edit, or withdraw one queued input (an abort withdraws them all), so `move`, `edit`, and
 * `remove` do nothing and the UI offers none of them.
 */
export const queueAdapter = (
  target: QueueTarget,
  lanes: QueueLanes,
): ExternalThreadQueueAdapter => ({
  items: lanes.followUp.map(queueItem),
  steerItems: lanes.steer.map(queueItem),
  enqueue: (message) => {
    target.submit(textOf(message), "followUp");
  },
  steer: (message) => {
    target.submit(textOf(message), "steer");
  },
  move: () => {},
  edit: () => {},
  remove: () => {},
});
