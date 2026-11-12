// What the Session does with the questions it recorded (`docs/architecture/mcp-server-requests.md` → Elicitation requests,
// Records; Telemetry and testing): a span for each question that ended, a `warning` log once per server for the ones
// cloudpid ended unseen, the lines `/export` writes, and the records a Fork or Clone copies. Never a value.
// @effect-diagnostics strictEffectProvide:off preferEffectArray:off preferEffectRecord:off anyUnknownInErrorContext:off globalJsonInEffect:off
import type { ElicitationForm } from "@cloudpid/protocol";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vite-plus/test";
import { elicitationLine, exportLinesOf, samplingLine } from "./mcp/export-lines.ts";
import { type McpSamplingRecord, samplingRecords } from "./mcp/sampling-records.ts";
import {
  createMcpQuestions,
  type McpQuestionAsk,
  type McpQuestionRecord,
  type McpQuestionStorage,
} from "./mcp/questions.ts";

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
    { kind: "text", name: "email", required: false },
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

const open = (storage: McpQuestionStorage) =>
  createMcpQuestions({
    storage,
    announce: () => Effect.void,
    redact: (shown) => Effect.succeed(shown),
    holdsSecret: () => Effect.succeed(false),
  });

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

const settle = Effect.repeat(Effect.yieldNow, { times: 5 });

const SENTINEL = "sentinel-answer-4f1c9";

const record = (over: Partial<McpQuestionRecord> = {}): McpQuestionRecord => ({
  id: "call-1:1",
  callId: "call-1",
  conversationId: ROOT_CONVERSATION_ID,
  server: "docs",
  tool: "mcp__docs__ask",
  mode: "form",
  message: "Who are you?",
  notes: [],
  action: "accept",
  by: "owner",
  fields: ["name", "email"],
  askedAt: 10,
  settledAt: 20,
  ...over,
});

const sampled = (over: Partial<McpSamplingRecord> = {}): McpSamplingRecord => ({
  id: "call-1:s1",
  server: "docs",
  tool: "mcp__docs__ask",
  origin: "agent",
  conversationId: 1,
  callId: "call-1",
  sequence: 1,
  status: "answered",
  role: "large",
  tokens: 1204,
  cost: 0.0213,
  by: "owner",
  notes: [],
  askedAt: 15,
  ...over,
});

describe("the lines /export writes", () => {
  it("says what a form came to, by the names of the fields and never a value", () => {
    expect(elicitationLine(record())).toBe("Elicitation: docs · form · submitted (name, email)");
    expect(elicitationLine(record({ fields: [] }))).toBe("Elicitation: docs · form · submitted");
    expect(elicitationLine(record({ action: "decline", fields: [] }))).toBe(
      "Elicitation: docs · form · declined",
    );
    expect(elicitationLine(record({ action: "cancel", fields: [] }))).toBe(
      "Elicitation: docs · form · cancelled",
    );
  });

  it("names a page by its host, and what cloudpid ended by why", () => {
    expect(
      elicitationLine(
        record({ mode: "url", page: { origin: "https://auth.example.com" }, fields: [] }),
      ),
    ).toBe("Elicitation: docs · page on auth.example.com · opened");
    expect(
      elicitationLine(
        record({
          action: "decline",
          by: "cloudpid",
          reason: "it asked for a credential ('API token')",
          fields: [],
        }),
      ),
    ).toBe(
      "Elicitation: docs · form · declined by cloudpid: it asked for a credential ('API token')",
    );
  });

  it("says a sample by its server, Role, tokens and cost, and a refusal by that", () => {
    expect(samplingLine(sampled())).toBe("Sampling: docs · large · 1,204 tokens · $0.02");
    expect(samplingLine(sampled({ cost: 0.0004 }))).toBe(
      "Sampling: docs · large · 1,204 tokens · $0.0004",
    );
    expect(samplingLine(sampled({ status: "refused", by: "owner" }))).toBe(
      "Sampling: docs · refused",
    );
    expect(samplingLine(sampled({ status: "waiting" }))).toBeUndefined();
  });

  it("files the lines under the call, and under the call a nested one is in, oldest first", () => {
    const lines = exportLinesOf(
      [
        record({ id: "call-1:2", askedAt: 30, action: "decline", fields: [] }),
        record({ id: "call-1/c1:1", callId: "call-1/c1", askedAt: 5 }),
        record({ id: "other:1", callId: "other" }),
      ],
      [sampled()],
    );

    expect(lines.get("call-1")).toEqual([
      "Elicitation: docs · form · submitted (name, email)",
      "Sampling: docs · large · 1,204 tokens · $0.02",
      "Elicitation: docs · form · declined",
    ]);
    expect(lines.get("call-1/c1")).toEqual(["Elicitation: docs · form · submitted (name, email)"]);
    expect(lines.get("other")).toHaveLength(1);
  });
});

describe("a question that ended", () => {
  test("says in its span that the question was an MCP task's, by its owner key", () => {
    const spans: Array<Tracer.NativeSpan> = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);

        spans.push(span);

        return span;
      },
    });

    return Effect.gen(function* () {
      const { storage } = memoryStorage();
      const questions = open(storage);

      const waiting = yield* Effect.forkChild(
        questions.ask({ ...ASK, callId: "mcp_task:mcp-task-1" }),
      );

      yield* settle;
      yield* questions.answer("mcp_task:mcp-task-1:1", { action: "decline" });
      yield* Fiber.join(waiting);

      const [span] = spans.filter((each) => each.name === "mcp.elicitation.request");

      expect(Object.fromEntries(span?.attributes ?? [])).toMatchObject({ "mcp.origin": "task" });
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  });

  test("makes a span of what it asked and how it ended, and none of what it said", () => {
    const spans: Array<Tracer.NativeSpan> = [];

    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);

        spans.push(span);

        return span;
      },
    });

    return Effect.gen(function* () {
      const { storage } = memoryStorage();
      const questions = open(storage);
      const waiting = yield* Effect.forkChild(questions.ask(ASK));

      yield* settle;
      yield* TestClock.adjust(1500);
      yield* questions.answer("call-1:1", { action: "accept", content: { name: SENTINEL } });
      yield* Fiber.join(waiting);

      const [span] = spans.filter((each) => each.name === "mcp.elicitation.request");

      expect(Object.fromEntries(span?.attributes ?? [])).toEqual({
        "mcp.server": "demo",
        "mcp.origin": "agent",
        "mcp.elicitation.mode": "form",
        "mcp.elicitation.era": "modern",
        "mcp.elicitation.action": "accept",
        "mcp.elicitation.by": "owner",
        "mcp.elicitation.fields": 1,
        "mcp.elicitation.wait_ms": 1500,
      });
      expect(JSON.stringify([...(span?.attributes ?? [])])).not.toContain(SENTINEL);
    }).pipe(Effect.provideService(Tracer.Tracer, tracer));
  });

  test("logs a warning once per server for what cloudpid ended unseen, and never a value", () =>
    Effect.gen(function* () {
      const logged: string[] = [];

      const collector = Logger.make((options) => {
        logged.push(`${options.logLevel}: ${String(Arr.ensure(options.message)[0])}`);
      });

      const { storage } = memoryStorage();
      const questions = open(storage);

      const unseen = (server: string, call: string) =>
        questions.unseen({
          callId: call,
          conversationId: ROOT_CONVERSATION_ID,
          server,
          tool: `mcp__${server}__ask`,
          message: "A token, please",
          action: "decline",
          reason: "it asked for a credential ('API token')",
        });

      yield* unseen("demo", "call-1").pipe(
        Effect.andThen(unseen("demo", "call-2")),
        Effect.andThen(unseen("other", "call-3")),
        Effect.provideService(Logger.CurrentLoggers, new Set([collector])),
      );

      expect(logged).toEqual([
        "Warn: cloudpid declined a request for input from MCP server demo unseen; later ones are recorded, not logged",
        "Warn: cloudpid declined a request for input from MCP server other unseen; later ones are recorded, not logged",
      ]);
    }));

  test("logs nothing for a cancel cloudpid made unseen", () =>
    Effect.gen(function* () {
      const logged: string[] = [];

      const collector = Logger.make((options) => {
        logged.push(String(Arr.ensure(options.message)[0]));
      });

      const questions = open(memoryStorage().storage);

      yield* questions
        .unseen({
          callId: "call-1",
          conversationId: ROOT_CONVERSATION_ID,
          server: "demo",
          tool: "mcp__demo__ask",
          message: "Open this page",
          action: "cancel",
          reason: "it asked to open a page",
        })
        .pipe(Effect.provideService(Logger.CurrentLoggers, new Set([collector])));

      expect(logged).toEqual([]);
    }));

  test("is copied to a Fork with the call's result, under the new conversation, and a copy keeps no more than the newest 100", () =>
    Effect.gen(function* () {
      const sourceStorage = memoryStorage().storage;
      const source = open(sourceStorage);

      yield* source.unseen({
        callId: "call-1",
        conversationId: ROOT_CONVERSATION_ID,
        server: "demo",
        tool: "mcp__demo__ask",
        message: "A token, please",
        action: "decline",
        reason: "it asked for a credential ('API token')",
      });
      yield* source.unseen({
        callId: "call-2/c1",
        conversationId: ROOT_CONVERSATION_ID,
        server: "demo",
        tool: "mcp__demo__ask",
        message: "A token, please",
        action: "decline",
        reason: "it asked for a credential ('API token')",
      });
      yield* source.unseen({
        callId: "call-3",
        conversationId: ROOT_CONVERSATION_ID,
        server: "demo",
        tool: "mcp__demo__ask",
        message: "A token, please",
        action: "decline",
        reason: "it asked for a credential ('API token')",
      });

      // Sampling requests of the same calls, as their own records are kept.
      const samples = samplingRecords(sourceStorage);

      for (const callId of ["call-1", "call-2/c1", "call-3"]) {
        samples.put(
          {
            id: `${callId}:s1`,
            server: "demo",
            tool: "mcp__demo__ask",
            origin: "agent",
            conversationId: 1,
            callId,
            sequence: 1,
            status: "refused",
            by: "owner",
            reason: "the owner refused",
            notes: [],
            askedAt: 1,
            settledAt: 2,
          },
          2,
        );
      }

      const copied = source.copies.copier()(["call-1", "call-2"], 1_000_000);

      expect(copied.map((each) => [each.kind, each.record.callId])).toEqual([
        ["question", "call-1"],
        ["question", "call-2/c1"],
        ["sampling", "call-1"],
        ["sampling", "call-2/c1"],
      ]);

      const target = memoryStorage();
      const forked = open(target.storage);

      // SAFETY: a plain number stands in for the branded conversation ID of the new Session's root.
      forked.copies.adopt(copied, 7 as typeof ROOT_CONVERSATION_ID);

      const records = yield* forked.records;

      expect(records.map((each) => [each.callId, each.conversationId])).toEqual([
        ["call-1", 7],
        ["call-2/c1", 7],
      ]);
      // The Sampling requests came too, as the new conversation's.
      expect(
        samplingRecords(target.storage)
          .list()
          .map((each) => [each.callId, each.conversationId]),
      ).toEqual([
        ["call-1", 7],
        ["call-2/c1", 7],
      ]);
      expect(target.dump()).not.toContain("call-3");
    }));
});

describe("what a page of a Fork carries of the Sampling requests", () => {
  /** A source whose Sampling index reads are counted, with a Sampling record of `callId` ("a" reply of 5 000 characters). */
  const sourceWith = (callIds: ReadonlyArray<string>) => {
    const { storage } = memoryStorage();
    let reads = 0;

    const counting: McpQuestionStorage = {
      ...storage,
      get: (key) => {
        if (key === "mcp-sampling:index") reads += 1;

        return storage.get(key);
      },
    };

    for (const callId of callIds) {
      samplingRecords(storage).put(
        {
          id: `${callId}:s1`,
          server: "demo",
          tool: "mcp__demo__ask",
          origin: "agent",
          conversationId: 1,
          callId,
          sequence: 1,
          status: "answered",
          by: "owner",
          notes: [],
          askedAt: 1,
          settledAt: 2,
          reply: { role: "assistant", content: { type: "text", text: "a".repeat(5000) } },
        },
        2,
      );
    }

    reads = 0;

    return { source: open(counting), reads: () => reads };
  };

  test("are not read for a page whose entries hold no call, and once for one whose entries do", () =>
    Effect.sync(() => {
      const { source, reads } = sourceWith(["call-1", "call-2"]);

      const none = source.copies.copier();

      expect(none([], 1_000_000)).toEqual([]);
      expect(none([], 1_000_000)).toEqual([]);
      expect(reads()).toBe(0);

      const page = source.copies.copier();

      expect(page(["call-1"], 1_000_000)).toHaveLength(1);
      expect(page(["call-2"], 1_000_000)).toHaveLength(1);
      expect(reads()).toBe(1);
    }));

  test("past the page's budget are carried as stubs, which keep who asked and when", () =>
    Effect.sync(() => {
      const { source } = sourceWith(["call-1", "call-2"]);

      const [whole] = source.copies.copier()(["call-1"], 1_000_000);

      // Room for the first only: the second is a stub.
      const room = JSON.stringify(whole).length + 100;
      const copied = source.copies.copier()(["call-1", "call-2"], room);

      expect(
        copied.map((each) => [
          each.record.callId,
          "stub" in each.record && each.record.stub === true,
        ]),
      ).toEqual([
        ["call-1", false],
        ["call-2", true],
      ]);
      expect(JSON.stringify(copied[1])).not.toContain("aaaa");
    }));
});

describe("what a page of a Fork carries of the questions and the Sampling requests together", () => {
  test("counts the question records in the page's budget before the Sampling records", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const source = open(storage);

      yield* source.unseen({
        callId: "call-1",
        conversationId: ROOT_CONVERSATION_ID,
        server: "demo",
        tool: "mcp__demo__ask",
        message: "m".repeat(6000),
        action: "decline",
        reason: "it asked for a credential ('API token')",
      });

      for (const callId of ["call-1", "call-2"]) {
        samplingRecords(storage).put(
          {
            id: `${callId}:s1`,
            server: "demo",
            tool: "mcp__demo__ask",
            origin: "agent",
            conversationId: 1,
            callId,
            sequence: 1,
            status: "answered",
            by: "owner",
            notes: [],
            askedAt: 1,
            settledAt: 2,
            reply: { role: "assistant", content: { type: "text", text: "a".repeat(5000) } },
          },
          2,
        );
      }

      const [question, whole] = source.copies.copier()(["call-1"], 1_000_000);
      const room = JSON.stringify(question).length + JSON.stringify(whole).length + 100;
      const copied = source.copies.copier()(["call-1", "call-2"], room);

      // The question's record takes its share first; what is left holds the first Sampling record whole and not the second.
      expect(copied.map((each) => each.kind)).toEqual(["question", "sampling", "sampling"]);
      expect(copied.map((each) => "stub" in each.record && each.record.stub === true)).toEqual([
        false,
        false,
        true,
      ]);
    }));
});

describe("Decline all and Decline in this Session", () => {
  /** Ask `ask` as call `callId` of `server`, with question `key`. */
  const asking = (questions: ReturnType<typeof open>, over: Partial<McpQuestionAsk>) =>
    Effect.forkChild(questions.ask({ ...ASK, ...over }));

  test("decline the question and the call's others, and no other call's", () =>
    Effect.gen(function* () {
      const questions = open(memoryStorage().storage);
      const first = yield* asking(questions, { key: "1" });
      const second = yield* asking(questions, { key: "2" });
      const other = yield* asking(questions, { key: "1", callId: "call-2" });

      yield* settle;
      yield* questions.declineScoped("call-1:1", "call");

      expect(yield* Fiber.join(first)).toEqual({ action: "decline", by: "owner" });
      expect(yield* Fiber.join(second)).toEqual({ action: "decline", by: "owner" });
      expect((yield* questions.pending).map((request) => request.id)).toEqual(["call-2:1"]);
      expect(questions.isDeclined("demo")).toBe(false);

      yield* questions.answer("call-2:1", { action: "cancel" });
      yield* Fiber.join(other);
    }));

  test("decline this question only, keep the choice for the server's later ones, and give it back", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();
      const questions = open(storage);
      const first = yield* asking(questions, { key: "1" });
      const other = yield* asking(questions, { key: "1", callId: "call-2" });
      const elsewhere = yield* asking(questions, { key: "1", callId: "call-3", server: "other" });

      yield* settle;
      yield* questions.declineScoped("call-1:1", "session");

      expect(yield* Fiber.join(first)).toEqual({ action: "decline", by: "owner" });
      // The questions it already waits on stay on their cards: Decline all is for those.
      expect((yield* questions.pending).map((request) => request.id)).toEqual([
        "call-2:1",
        "call-3:1",
      ]);
      expect(questions.isDeclined("demo")).toBe(true);
      expect(questions.isDeclined("other")).toBe(false);
      expect(questions.declinedServers()).toEqual(["demo"]);

      // It outlives the instance, which the storage keeps it for.
      expect(open(storage).isDeclined("demo")).toBe(true);

      yield* questions.revokeDeclined("demo");

      expect(questions.isDeclined("demo")).toBe(false);

      yield* questions.answer("call-2:1", { action: "cancel" });
      yield* questions.answer("call-3:1", { action: "cancel" });
      yield* Fiber.join(other);
      yield* Fiber.join(elsewhere);
    }));

  test("keep nothing, and decline nothing, when the choice cannot be kept or the question has ended", () =>
    Effect.gen(function* () {
      const { storage } = memoryStorage();

      const refusing: McpQuestionStorage = {
        ...storage,
        put: (key, value) => {
          if (key === "mcp-question:declined") throw new Error("storage refuses");

          storage.put(key, value);
        },
      };

      const questions = open(refusing);
      const waiting = yield* asking(questions, {});

      yield* settle;

      const refused = yield* questions.declineScoped("call-1:1", "session").pipe(Effect.flip);

      expect(refused.message).toBe("The choice could not be kept; try again");
      expect(yield* questions.pending).toHaveLength(1);

      const gone = yield* questions.declineScoped("call-9:1", "call").pipe(Effect.flip);

      expect(gone.message).toBe("This request ended");

      yield* questions.answer("call-1:1", { action: "cancel" });
      yield* Fiber.join(waiting);
    }));
});
