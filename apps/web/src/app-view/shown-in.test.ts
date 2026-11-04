// @effect-diagnostics preferEffectArray:off -- ids and commands read from native lists.
// `docs/architecture/mcp-apps.md` → App messages and App context. Where a View is shown, and what that decides of its message
// and its context: a View kept across a move of the active branch is of a call the Session records under the conversation that
// made it, and is shown in the root's thread, whose History holds the call; a call in a subagent's thread is not.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, vi } from "vitest";
import { attachmentsAtom } from "../chat/attachments-state.ts";
import { chatRegistry } from "../chat/chat.testing.ts";
import { composerMountsAtom } from "../chat/composer-mounts.ts";
import { conversationKey } from "../chat/conversation.ts";
import { sessionStatusAtom } from "../session/atoms.ts";
import { settle, type Value } from "../session/client.testing.ts";
import { appKey } from "./atoms.ts";
import { holdWhereShown, shownInAtom } from "./shown-in.ts";

beforeEach(() => {
  vi.stubGlobal("window", { location: { href: "https://example.test/sessions/s1" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROOT = conversationKey("s1", undefined);

/** An entry of a conversation: the model made tool call `call` in it. */
const madeCall = (conversationId: number, call: string) => ({
  id: 10,
  conversationId,
  kind: "pi.assistant",
  model: [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: call, name: "mcp__docs__page", arguments: {} }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 1,
    },
  ],
});

const snapshot = (conversationId: number, entries: ReadonlyArray<Value>) => ({
  type: "events",
  conversationId,
  events: [
    {
      type: "snapshot",
      entries,
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: {},
    },
  ],
});

const chip = { callId: "call-1", server: "docs", text: "Pick A" };

/**
 * A Session whose root was conversation 1 when the call was made, and whose active branch moved to conversation 2, whose
 * History holds the call (a Fork's entries include those it was forked from). The Session records the call under 1.
 */
const movedBranch = () =>
  Effect.gen(function* () {
    const chat = chatRegistry();

    chat.registry.mount(sessionStatusAtom("s1"));
    chat.registry.mount(attachmentsAtom(ROOT));
    yield* settle;

    const socket = chat.latest();

    yield* socket.open();
    yield* socket.say({ type: "hello", root: 1, appMessages: true, appContext: true });

    const first = socket.commands().find((command) => command.type === "watch");

    yield* socket.say({ type: "result", id: first?.id, result: null });
    yield* socket.say(snapshot(1, []));
    yield* socket.say({ type: "active_branch", conversationId: 2 });

    const second = socket.commands().findLast((command) => command.type === "watch");

    yield* socket.say({ type: "result", id: second?.id, result: null });
    yield* socket.say(snapshot(2, [madeCall(2, "call-1")]));
    yield* socket.say({
      type: "mcp_apps",
      conversationId: 1,
      apps: [
        { callId: "call-1", server: "docs", tool: "page", state: "kept", at: 1 },
        // Made inside a codemode script, whose call is the one the History holds.
        {
          callId: "nested-1",
          parentCall: "call-1",
          server: "docs",
          tool: "page",
          state: "kept",
          at: 2,
        },
      ],
    });

    return chat;
  });

describe("where an App View is shown", () => {
  it.effect(
    "is the root's thread when its History holds the call, whichever conversation made it",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* movedBranch();

        expect(registry.get(shownInAtom(appKey("s1", "call-1")))).toEqual({
          key: ROOT,
          conversation: 2,
        });
      }),
  );

  it.effect(
    "is the root's thread for a call nested in a script the History holds, by the script's call",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* movedBranch();

        expect(registry.get(shownInAtom(appKey("s1", "nested-1")))).toEqual({
          key: ROOT,
          conversation: 2,
        });
      }),
  );

  it.effect(
    "is nowhere for a call no loaded thread holds, such as a subagent's inline in the root's",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* movedBranch();

        expect(registry.get(shownInAtom(appKey("s1", "other")))).toBeUndefined();
      }),
  );

  it.effect(
    "puts a message in the composer of the conversation shown, not the one that made the call",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* movedBranch();

        registry.set(composerMountsAtom(ROOT), 1);

        expect(
          yield* Effect.promise(() => holdWhereShown(registry, appKey("s1", "call-1"), chip)),
        ).toBe("held");
        expect(registry.get(attachmentsAtom(ROOT)).apps).toEqual([chip]);
      }),
  );

  it.effect(
    "refuses a message when no composer of the conversation shown is mounted (an App Pane with none)",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* movedBranch();

        expect(
          yield* Effect.promise(() => holdWhereShown(registry, appKey("s1", "call-1"), chip)),
        ).toBe("refused");
        expect(registry.get(attachmentsAtom(ROOT)).apps).toEqual([]);
      }),
  );

  it.effect(
    "refuses a message of a call shown in no thread: a subagent's call inline in the root's",
    () =>
      Effect.gen(function* () {
        const { registry } = yield* movedBranch();

        registry.set(composerMountsAtom(ROOT), 1);

        expect(
          yield* Effect.promise(() =>
            holdWhereShown(registry, appKey("s1", "other"), { ...chip, callId: "other" }),
          ),
        ).toBe("refused");
        expect(registry.get(attachmentsAtom(ROOT)).apps).toEqual([]);
      }),
  );
});
