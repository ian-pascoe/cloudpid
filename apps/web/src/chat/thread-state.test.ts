// @effect-diagnostics globalDate:off preferEffectArray:off -- assistant-ui's messages carry a Date; what the fake
// socket recorded is a native array.

import type { AppendMessage } from "@assistant-ui/react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vitest";
import { sessionStatusAtom } from "../session/atoms.ts";
import { settle } from "../session/client.testing.ts";
import { chatRegistry, live, sent } from "./chat.testing.ts";
import { conversationKey } from "./conversation.ts";
import { threadMessagesAtom, threadQueueAtom } from "./thread-state.ts";

const ROOT = conversationKey("s1", undefined);

/** What the owner typed, as assistant-ui hands it to a queue lane. */
const typed = (text: string): AppendMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  attachments: [],
  metadata: { custom: {} },
  createdAt: new Date(0),
  parentId: null,
  sourceId: null,
  runConfig: undefined,
});

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a conversation's runtime atoms", () => {
  it.effect("give new messages only when the conversation's view changes", () =>
    Effect.gen(function* () {
      const chat = chatRegistry();
      const { registry } = chat;

      registry.mount(sessionStatusAtom("s1"));
      registry.mount(threadMessagesAtom(ROOT));
      yield* settle;
      yield* live(chat.latest());

      const before = registry.get(threadMessagesAtom(ROOT));

      yield* chat.latest().say({ type: "picked", model: true, thinkingLevel: false });

      expect(registry.get(threadMessagesAtom(ROOT))).toBe(before);

      yield* chat.latest().say({
        type: "events",
        conversationId: 1,
        events: [{ type: "run_start", inputs: [1] }],
      });

      expect(registry.get(threadMessagesAtom(ROOT))).not.toBe(before);
    }),
  );

  it.effect("submit what goes through a subagent's lanes to its conversation", () =>
    Effect.gen(function* () {
      const chat = chatRegistry();
      const { registry } = chat;
      const child = conversationKey("s1", 2);

      registry.mount(sessionStatusAtom("s1"));
      registry.mount(threadQueueAtom(child));
      registry.mount(threadQueueAtom(ROOT));
      yield* settle;
      yield* live(chat.latest());

      registry.get(threadQueueAtom(child)).steer(typed("this way"));
      registry.get(threadQueueAtom(ROOT)).enqueue(typed("then this"));
      yield* settle;

      // A submit to a subagent waits for its watch's answer.
      const watch = sent(chat.latest(), "watch").find((command) => command.conversationId === 2);

      yield* chat.latest().say({ type: "result", id: watch?.id, result: null });

      expect(sent(chat.latest(), "submit")).toMatchObject([
        { input: "then this", whenBusy: "followUp" },
        { input: "this way", whenBusy: "steer", conversationId: 2 },
      ]);
      expect(sent(chat.latest(), "submit")[0]).not.toHaveProperty("conversationId");
    }),
  );
});
