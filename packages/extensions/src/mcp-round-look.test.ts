// @effect-diagnostics anyUnknownInErrorContext:off strictEffectProvide:off preferEffectArray:off
// The look at the servers of the rounds kept for later (`docs/architecture/mcp-server-requests.md` → The waiting-question
// record, #569): made only for a round the owner is shown, and only when one waits; a look the host does not answer
// within its bound, or fails, leaves every round waiting.
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { DOCS } from "./mcp.fixture.ts";
import { fakeMcpHost } from "./mcp.testing.ts";
import { MCP_ROUND_LOOK_TIMEOUT, lookAtRounds } from "./mcp/round-look.ts";
import { createMcpQuestions, McpRoundState, type McpQuestionStorage } from "./mcp/questions.ts";
import { openKeptVault } from "./secrets/vault.ts";

const storage = (): McpQuestionStorage => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the questions read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };
};

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

/** A Session's questions, and the fake host the look asks (the server `Docs-Site`, on `conn-Docs-Site`). */
const setup = Effect.gen(function* () {
  const kept = yield* openKeptVault(
    "test-master-key-0123456789abcdef0123456789",
    "mcp-elicitation",
  );

  const questions = createMcpQuestions({
    storage: storage(),
    announce: () => Effect.void,
    redact: (shown) => Effect.succeed(shown),
    holdsSecret: () => Effect.succeed(false),
    vault: {
      seal: (id, text) => kept.seal({ owner: "s1", name: id }, text),
      open: (id, sealed) => kept.open({ owner: "s1", name: id }, sealed),
    },
  });

  const host = fakeMcpHost([DOCS]);

  /** A round of `callId` that asked on `conn`, shown to the owner or not yet. */
  const keep = (callId: string, conn: string, shown: boolean) =>
    Effect.gen(function* () {
      yield* questions.defer({
        key: "q1",
        callId,
        conversationId: ROOT_CONVERSATION_ID,
        server: "Docs-Site",
        tool: "mcp__docs_site__search",
        message: "Who are you?",
        form: { fields: [{ kind: "text", name: "name", required: true }] },
        notes: [],
      });
      yield* questions.commitRound({
        callId,
        round: 1,
        conn,
        tool: "search",
        state: McpRoundState.Resume({ state: { v: 1 } }),
        asked: [],
      });

      if (shown) yield* questions.showRound(callId);
    });

  const looks = () => host.calls.filter((each) => each.method === "servers").length;

  return { questions, host, keep, looks };
});

describe("the look at the servers of the rounds kept for later", () => {
  test("asks the host nothing when no round waits", () =>
    Effect.gen(function* () {
      const { questions, host, looks } = yield* setup;

      yield* lookAtRounds(host.client, questions);

      expect(looks()).toBe(0);
    }));

  test("is made for a round the owner is shown, and not for one that is not shown yet", () =>
    Effect.gen(function* () {
      const { questions, host, keep, looks } = yield* setup;

      // On another connection than the server's, so a look at it would withdraw it.
      yield* keep("call-1", "conn-old", false);
      yield* lookAtRounds(host.client, questions);

      expect(looks()).toBe(0);
      expect(yield* questions.waitingRounds).toEqual([]);

      yield* questions.showRound("call-1");
      expect(yield* questions.pending).toHaveLength(1);
      yield* lookAtRounds(host.client, questions);

      // The question is answered `cancel` for the call that waits to read (none does here), so it is not shown any more.
      expect(looks()).toBe(1);
      expect(yield* questions.pending).toEqual([]);
    }));

  test("leaves a round on its server's connection waiting", () =>
    Effect.gen(function* () {
      const { questions, host, keep, looks } = yield* setup;

      yield* keep("call-1", "conn-Docs-Site", true);
      yield* lookAtRounds(host.client, questions);

      expect(looks()).toBe(1);
      expect(yield* questions.waitingRounds).toEqual([
        { callId: "call-1", server: "Docs-Site", conn: "conn-Docs-Site" },
      ]);
    }));

  test("gives up on a host that does not answer, after its bound, and leaves the rounds waiting", () =>
    Effect.gen(function* () {
      const { questions, host, keep } = yield* setup;

      yield* keep("call-1", "conn-old", true);

      const silent = { ...host.client, servers: () => Effect.never };
      const look = yield* Effect.forkChild(lookAtRounds(silent, questions));

      yield* TestClock.adjust(MCP_ROUND_LOOK_TIMEOUT);
      yield* Fiber.join(look);

      expect(yield* questions.pending).toHaveLength(1);
    }));

  test("takes a host that fails for no word about the server", () =>
    Effect.gen(function* () {
      const { questions, host, keep } = yield* setup;

      yield* keep("call-1", "conn-old", true);
      host.fail(true);
      yield* lookAtRounds(host.client, questions);

      expect(yield* questions.pending).toHaveLength(1);
    }));
});
