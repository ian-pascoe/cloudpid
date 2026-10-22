// What assistant-ui's runtime of a conversation is built from, as atoms: the messages it renders and its queue lanes,
// each new only when the part of the conversation it comes from changes.

import type { ExternalThreadQueueAdapter, ThreadMessageLike } from "@assistant-ui/react";
import * as Atom from "effect/reactivity/Atom";
import {
  sessionQueueAtom,
  sessionViewAtom,
  submitAtom,
  threadAtom,
  type ThreadKey,
} from "../session/atoms.ts";
import type { QueueLanes, ThreadState } from "../session/state.ts";
import { toThreadMessages } from "../session/thread-messages.ts";
import type { ConversationKey } from "./conversation.ts";
import { queueAdapter } from "./queue-adapter.ts";

/** A subagent's thread, picked apart: each field is new only when it changes. */
const threadFieldAtom = <A>(pick: (thread: ThreadState) => A) =>
  Atom.family((key: ThreadKey) =>
    Atom.map(threadAtom(key), (thread) => (thread === null ? null : pick(thread))),
  );

const childViewAtom = threadFieldAtom((thread) => thread.view);
const childQueueAtom = threadFieldAtom((thread) => thread.queue);

const NO_LANES: QueueLanes = { steer: [], followUp: [] };

/** A conversation's messages, as assistant-ui takes them: the root's, or a subagent's once it is watched. */
export const threadMessagesAtom = Atom.family((key: ConversationKey) =>
  Atom.make((get): readonly ThreadMessageLike[] => {
    const { sessionId, conversationId } = key;

    if (conversationId === undefined) return toThreadMessages(get(sessionViewAtom(sessionId)));

    const view = get(childViewAtom({ sessionId, conversationId }));

    return view === null ? [] : toThreadMessages(view);
  }),
);

/** A conversation's queue lanes as assistant-ui's queue: what is sent through them is submitted to that conversation. */
export const threadQueueAtom = Atom.family((key: ConversationKey) =>
  Atom.make((get): ExternalThreadQueueAdapter => {
    const { sessionId, conversationId } = key;
    const submit = submitAtom(sessionId);

    // Written from assistant-ui's handlers, after this was read: mounted, so a write runs it.
    get.mount(submit);

    const lanes =
      conversationId === undefined
        ? get(sessionQueueAtom(sessionId))
        : (get(childQueueAtom({ sessionId, conversationId })) ?? NO_LANES);

    return queueAdapter(
      {
        submit: (text, whenBusy) => {
          get.registry.set(
            submit,
            conversationId === undefined
              ? { message: text, whenBusy }
              : { message: text, whenBusy, conversationId },
          );
        },
      },
      lanes,
    );
  }),
);
