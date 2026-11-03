// The Session's MCP questions (`docs/architecture/mcp-server-requests.md` → Questions, The waiting-question record,
// Elicitation requests): asked by a call, answered by the owner, and never kept as a value.
// @effect-diagnostics strictEffectProvide:off preferEffectArray:off preferEffectRecord:off anyUnknownInErrorContext:off preferSchemaOverJson:off
import type { ElicitationForm, McpElicitationRequest } from "@cloudpid/protocol";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import {
  createMcpQuestions,
  MCP_QUESTION_RECORDS,
  MCP_QUESTION_RENOTIFY_MS,
  type McpQuestionAsk,
  type McpQuestionStorage,
} from "./mcp/questions.ts";

/** A Durable Object's key-value storage, in memory, that can show everything it holds. */
const memoryStorage = () => {
  const map = new Map<string, unknown>();

  const storage: McpQuestionStorage = {
    // SAFETY: the questions read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };

  return { storage, dump: () => JSON.stringify([...map]) };
};

const FORM: ElicitationForm = {
  fields: [
    { kind: "text", name: "name", title: "Your name", required: true },
    { kind: "integer", name: "count", required: false },
  ],
};

const ASK: McpQuestionAsk = {
  key: "1",
  callId: "call-1",
  conversationId: ROOT_CONVERSATION_ID,
  server: "demo",
  tool: "mcp__demo__ask",
  message: "Who are you?",
  form: FORM,
  notes: [],
};

const SENTINEL = "sentinel-answer-4f1c9";

const open = (storage: McpQuestionStorage, options: { readonly secret?: string } = {}) => {
  const announced: Array<ReadonlyArray<McpElicitationRequest>> = [];
  const told: string[] = [];

  const questions = createMcpQuestions({
    storage,
    announce: (requests) =>
      Effect.sync(() => {
        announced.push(requests);
      }),
    notify: ({ server }) =>
      Effect.sync(() => {
        told.push(server);
      }),
    redact: (shown) => Effect.succeed(shown),
    holdsSecret: (text) => Effect.succeed(options.secret !== undefined && text === options.secret),
  });

  return { questions, announced, told };
};

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

/** A moment for the fibers forked so far to run. */
const settle = Effect.repeat(Effect.yieldNow, { times: 5 });

describe("MCP questions", () => {
  test("show the form to every client, tell the owner once, and hand the call the owner's answer", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { questions, announced, told } = open(storage);
      const waiting = yield* Effect.forkChild(questions.ask(ASK));

      yield* settle;

      const [request] = yield* questions.pending;

      expect(request).toMatchObject({
        id: "call-1:1",
        callId: "call-1",
        server: "demo",
        message: "Who are you?",
        deadline: 10 * 60 * 1000,
      });
      expect(told).toEqual(["demo"]);

      yield* questions.answer("call-1:1", {
        action: "accept",
        content: { name: SENTINEL, count: 3 },
      });

      expect(yield* Fiber.join(waiting)).toEqual({
        action: "accept",
        by: "owner",
        content: { name: SENTINEL, count: 3 },
      });
      expect(announced.at(-1)).toEqual([]);

      // The record names the fields answered, never what was entered.
      const [record] = yield* questions.records;

      expect(record).toMatchObject({ action: "accept", by: "owner", fields: ["name", "count"] });
      expect(dump()).not.toContain(SENTINEL);
      expect(JSON.stringify(announced)).not.toContain(SENTINEL);
    }));

  test("take a decline and a cancel from the owner, and refuse a second answer", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { questions } = open(storage);
      const declined = yield* Effect.forkChild(questions.ask(ASK));
      const cancelled = yield* Effect.forkChild(questions.ask({ ...ASK, key: "2" }));

      yield* settle;
      yield* questions.answer("call-1:1", { action: "decline" });
      yield* questions.answer("call-1:2", { action: "cancel" });

      expect(yield* Fiber.join(declined)).toEqual({ action: "decline", by: "owner" });
      expect(yield* Fiber.join(cancelled)).toEqual({ action: "cancel", by: "owner" });

      const late = yield* Effect.exit(questions.answer("call-1:1", { action: "decline" }));

      expect(Exit.isFailure(late)).toBe(true);
    }));

  test("cancel a question the owner has not answered in 10 minutes", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { questions, announced } = open(storage);
      const waiting = yield* Effect.forkChild(questions.ask(ASK));

      yield* settle;
      yield* TestClock.adjust(10 * 60 * 1000 - 1);
      expect(yield* questions.pending).toHaveLength(1);

      yield* TestClock.adjust(1);

      expect(yield* Fiber.join(waiting)).toMatchObject({ action: "cancel", by: "cloudpid" });
      expect(announced.at(-1)).toEqual([]);
      expect((yield* questions.records)[0]).toMatchObject({ action: "cancel", by: "cloudpid" });
    }));

  test("bounce an answer that does not fit the form or holds a Secret, and keep waiting", () =>
    Effect.gen(function* () {
      const { storage, dump } = memoryStorage();
      const { questions } = open(storage, { secret: SENTINEL });
      const waiting = yield* Effect.forkChild(questions.ask(ASK));

      yield* settle;

      const missing = yield* Effect.flip(
        questions.answer("call-1:1", { action: "accept", content: {} }),
      );

      expect(missing.message).toBe("name: is required");

      const secret = yield* Effect.flip(
        questions.answer("call-1:1", { action: "accept", content: { name: SENTINEL } }),
      );

      expect(secret.message).toBe("name: matches one of your Secrets");
      expect(secret.message).not.toContain(SENTINEL);
      expect(yield* questions.pending).toHaveLength(1);
      expect(dump()).not.toContain(SENTINEL);

      yield* questions.answer("call-1:1", { action: "accept", content: { name: "Ada" } });
      expect((yield* Fiber.join(waiting)).action).toBe("accept");
    }));

  test("cancel the eleventh question of a call, saying why", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { questions } = open(storage);

      for (let key = 1; key <= 10; key++) {
        yield* Effect.forkChild(questions.ask({ ...ASK, key: String(key) }));
      }

      yield* settle;

      const eleventh = yield* questions.ask({ ...ASK, key: "11" });

      expect(eleventh).toEqual({
        action: "cancel",
        by: "cloudpid",
        reason: "elicitation limit for this call reached",
      });
      expect(yield* questions.pending).toHaveLength(10);
    }));

  test("withdraw a question when its wait is interrupted, its call ends, or its server stops waiting", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { questions, announced } = open(storage);
      const stopped = yield* Effect.forkChild(questions.ask(ASK));

      yield* settle;
      yield* Fiber.interrupt(stopped);
      expect(yield* questions.pending).toEqual([]);
      expect((yield* questions.records)[0]).toMatchObject({ reason: "Run stopped" });

      const ended = yield* Effect.forkChild(questions.ask({ ...ASK, key: "2" }));
      const gone = yield* Effect.forkChild(questions.ask({ ...ASK, key: "3" }));

      yield* settle;
      yield* questions.withdraw("call-1", "3", "demo stopped waiting");
      expect(yield* Fiber.join(gone)).toMatchObject({ reason: "demo stopped waiting" });

      yield* questions.settleCall("call-1");
      expect(yield* Fiber.join(ended)).toMatchObject({
        action: "cancel",
        by: "cloudpid",
        reason: "the server's call ended",
      });
      expect(announced.at(-1)).toEqual([]);
    }));

  test("expire what an earlier instance left waiting", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const first = open(storage);

      yield* Effect.forkChild(first.questions.ask(ASK));
      yield* settle;

      // An eviction: a new instance over the same storage.
      const second = open(storage);

      yield* second.questions.expireStale;

      expect(yield* second.questions.pending).toEqual([]);
      expect((yield* second.questions.records)[0]).toMatchObject({
        id: "call-1:1",
        action: "cancel",
        by: "cloudpid",
        reason: "expired: the server's call ended",
      });
    }));

  test("tell the owner of a call's first question, and of a later one only after 2 minutes with none waiting", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { questions, told } = open(storage);

      yield* Effect.forkChild(questions.ask(ASK));
      yield* Effect.forkChild(questions.ask({ ...ASK, key: "2" }));
      yield* settle;
      expect(told).toEqual(["demo"]);

      yield* questions.answer("call-1:1", { action: "decline" });
      yield* questions.answer("call-1:2", { action: "decline" });

      // A later round of the same call, soon after: no new notification.
      yield* Effect.forkChild(questions.ask({ ...ASK, key: "3" }));
      yield* settle;
      expect(told).toEqual(["demo"]);
      yield* questions.answer("call-1:3", { action: "decline" });

      yield* TestClock.adjust(MCP_QUESTION_RENOTIFY_MS);
      yield* Effect.forkChild(questions.ask({ ...ASK, key: "4" }));
      yield* settle;
      expect(told).toEqual(["demo", "demo"]);
    }));

  test("keep the newest settled records, and the form's refusals as records too", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const { questions } = open(storage);

      for (let call = 0; call < MCP_QUESTION_RECORDS + 5; call++) {
        yield* questions.unseen({
          callId: `call-${call}`,
          conversationId: ROOT_CONVERSATION_ID,
          server: "demo",
          tool: "mcp__demo__ask",
          message: "A token, please",
          action: "decline",
          reason: "it asked for a credential ('API token')",
        });
      }

      const records = yield* questions.records;

      expect(records).toHaveLength(MCP_QUESTION_RECORDS);
      expect(records.at(-1)).toMatchObject({ callId: `call-${MCP_QUESTION_RECORDS + 4}` });
    }));
});
