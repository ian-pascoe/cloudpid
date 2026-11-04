// The Session's sampler (`docs/architecture/mcp-server-requests.md` → Sampling requests): a Legacy server's request run
// through the Session's `Models`, with its cap, its pace, its refusals, its Usage and its redacted record.
// @effect-diagnostics strictEffectProvide:off preferEffectArray:off preferEffectRecord:off asyncFunction:off anyUnknownInErrorContext:off runEffectInsideEffect:off missedPipeableOpportunity:off preferSchemaOverJson:off
import type { JsonObject } from "@cloudpid/mcp/types";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type FauxResponseFactory,
  fauxToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpSampling,
  MCP_SAMPLINGS_PER_CALL,
  SAMPLING_CONCURRENT,
  SAMPLING_PER_MINUTE,
  type McpSamplingAsk,
  type McpSamplingRoles,
  type McpSamplingOutcome,
} from "./mcp/sampling.ts";

const memory = () => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the sampler reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      map.set(key, structuredClone(value));
    },
    delete: (key: string) => map.delete(key),
    dump: () => JSON.stringify([...map]),
  };
};

const ref = (modelId: string) => ({ provider: "anthropic", modelId });

const ROLES: McpSamplingRoles = {
  small: ref("claude-haiku-5-5"),
  medium: ref("claude-sonnet-5-5"),
  large: ref("claude-opus-5-5"),
};

type Seen = { messages: number; system: string | undefined; tools: string[]; model: string };

const open = (
  options: {
    readonly over?: () => string | undefined;
    readonly redact?: (text: string) => string;
    readonly roles?: McpSamplingRoles;
    readonly input?: Array<"text" | "image">;
  } = {},
) => {
  const storage = memory();

  const faux = fauxProvider({
    provider: "anthropic",
    models: [
      { id: "claude-haiku-5-5", input: options.input ?? ["text"] },
      { id: "claude-sonnet-5-5" },
      { id: "claude-opus-5-5" },
    ],
  });

  const models = createModels();
  const usages: Array<{ who: { conversationId: number; server: string }; usage: Usage }> = [];
  const seen: Seen[] = [];

  models.setProvider(faux.provider);

  const sampler = createMcpSampling({
    storage,
    redact: (value) =>
      Effect.succeed(
        options.redact === undefined ? value : JSON.parse(options.redact(JSON.stringify(value))),
      ),
  });

  sampler.bind({
    models,
    roles: () => options.roles ?? ROLES,
    overLimit: () => Promise.resolve(options.over?.()),
    usage: (who, usage) => {
      usages.push({ who, usage });
    },
  });

  /** A response that notes what it was asked and gives `reply`. */
  const observe =
    (reply: AssistantMessage): FauxResponseFactory =>
    (context, _options, _state, model) => {
      const first = context.messages[0];
      const leading = first?.role === "system" ? first : undefined;

      seen.push({
        messages: context.messages.length - (leading === undefined ? 0 : 1),
        system: leading === undefined ? undefined : textOf(leading.content),
        tools: (leading?.toolsAdded ?? []).map((tool) => tool.name),
        model: model.id,
      });

      return reply;
    };

  const answer = (text: string) => observe(fauxAssistantMessage(text));

  return { sampler, storage, faux, usages, seen, answer, observe };
};

const ask = (params: JsonObject, over: Partial<McpSamplingAsk> = {}): McpSamplingAsk => ({
  server: "demo",
  tool: "mcp__demo__loop",
  callId: "call-1",
  conversationId: 1,
  key: "1",
  params,
  ...over,
});

const HI: JsonObject = {
  messages: [{ role: "user", content: { type: "text", text: "hi" } }],
  maxTokens: 100,
};

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

const textOf = (content: string | ReadonlyArray<{ readonly text: string }>): string =>
  Predicate.isString(content)
    ? content
    : Arr.join(
        Arr.map(content, (part) => part.text),
        "",
      );

/** Wait, in real time, until `check` stops throwing. */
const eventually = (check: () => void) => Effect.promise(() => vi.waitFor(check));

const refusedWith = (outcome: McpSamplingOutcome) =>
  outcome.kind === "refused" ? { code: outcome.code, message: outcome.message } : undefined;

describe("MCP sampling", () => {
  test("makes a span of each sample with who decided, the Role, the model, the tokens, the cost and the outcome", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];

      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);

          spans.push(span);

          return span;
        },
      });

      const { sampler, faux, answer } = open();

      faux.setResponses([answer("hello")]);
      yield* sampler.sample(ask(HI)).pipe(Effect.provideService(Tracer.Tracer, tracer));

      const [span] = spans.filter((each) => each.name === "mcp.sampling.sample");

      expect(Object.fromEntries(span?.attributes ?? [])).toMatchObject({
        "mcp.server": "demo",
        "mcp.origin": "agent",
        "mcp.sampling.outcome": "answered",
        "mcp.sampling.by": "definition",
        "mcp.sampling.role": "small",
        "mcp.sampling.model": "claude-haiku-5-5",
        "mcp.sampling.tokens": expect.any(Number),
        "mcp.sampling.cost": expect.any(Number),
      });
    }));

  test("tags why it refused, in a field of its own, never in the words alone", () =>
    Effect.gen(function* () {
      const { sampler } = open({ over: () => "it has spent 2 of 1" });
      const outcome = yield* sampler.sample(ask(HI));

      expect(outcome.detail).toMatchObject({ status: "refused", by: "cloudpid", why: "budget" });
    }));

  test("never puts an id or text the server wrote into the reason of a mispaired request", () =>
    Effect.gen(function* () {
      const { sampler } = open();

      const outcome = yield* sampler.sample(
        ask({
          maxTokens: 5,
          messages: [
            {
              role: "assistant",
              content: { type: "tool_use", id: "toolu_SERVER_ID_77", name: "x", input: {} },
            },
          ],
        }),
      );

      expect(JSON.stringify(outcome)).not.toContain("SERVER_ID_77");
      expect((yield* sampler.records)[0]?.reason).not.toContain("SERVER_ID_77");
    }));

  test("answers a request from the smallest Role's model, counts its Usage, and records it", () =>
    Effect.gen(function* () {
      const { sampler, faux, usages, seen, answer } = open();

      faux.setResponses([answer("hello back")]);

      const outcome = yield* sampler.sample(ask(HI));

      expect(outcome).toMatchObject({
        kind: "sampled",
        result: {
          role: "assistant",
          content: { type: "text", text: "hello back" },
          stopReason: "endTurn",
        },
        detail: { server: "demo", status: "answered", role: "small", by: "definition" },
      });
      expect(seen).toEqual([
        { messages: 1, system: undefined, tools: [], model: "claude-haiku-5-5" },
      ]);
      expect(usages).toHaveLength(1);
      expect(usages[0]?.who).toEqual({ conversationId: 1, server: "demo" });
      expect(usages[0]?.usage.totalTokens).toBeGreaterThan(0);

      const [record] = yield* sampler.records;

      expect(record).toMatchObject({
        id: "call-1:1",
        status: "answered",
        role: "small",
        origin: "agent",
        by: "definition",
        reply: { type: "text", text: "hello back" },
        stopReason: "endTurn",
      });
    }));

  test("asks the Role the server's preferences name, never above medium, and tells the clamp", () =>
    Effect.gen(function* () {
      const { sampler, faux, seen, answer } = open();

      faux.setResponses([answer("a"), answer("b")]);
      yield* sampler.sample(
        ask(
          { ...HI, modelPreferences: { hints: [{ name: "claude-sonnet-5-5" }] } },
          { callId: "c1" },
        ),
      );
      yield* sampler.sample(
        ask({ ...HI, modelPreferences: { hints: [{ name: "opus" }] } }, { callId: "c2" }),
      );

      expect(seen.map((each) => each.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
      expect((yield* sampler.records).map((each) => each.notes.length)).toEqual([0, 1]);
    }));

  test("falls to a lower Role when the Session has no model for the one chosen, and refuses with none", () =>
    Effect.gen(function* () {
      const lacking = open({ roles: { small: ref("claude-haiku-5-5") } });

      lacking.faux.setResponses([lacking.answer("a")]);
      yield* lacking.sampler.sample(
        ask({ ...HI, modelPreferences: { intelligencePriority: 0.9 } }),
      );
      expect(lacking.seen.map((each) => each.model)).toEqual(["claude-haiku-5-5"]);

      const none = open({ roles: {} });

      expect(refusedWith(yield* none.sampler.sample(ask(HI)))).toEqual({
        code: -32602,
        message: "no model is available for this request",
      });
      expect(none.usages).toEqual([]);
    }));

  test("passes the system prompt and offered tools, and answers tool_use blocks when tools are offered", () =>
    Effect.gen(function* () {
      const { sampler, faux, seen, observe } = open();

      faux.setResponses([
        observe(
          fauxAssistantMessage([fauxToolCall("lookup", { q: "x" }, { id: "t1" })], {
            stopReason: "toolUse",
          }),
        ),
      ]);

      const outcome = yield* sampler.sample(
        ask({
          ...HI,
          systemPrompt: "be brief",
          tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} } }],
        }),
      );

      expect(seen).toMatchObject([{ system: "be brief", tools: ["lookup"] }]);
      expect(outcome).toMatchObject({
        kind: "sampled",
        result: {
          stopReason: "toolUse",
          content: [{ type: "tool_use", id: "t1", name: "lookup", input: { q: "x" } }],
        },
      });
    }));

  test("notes what it could not keep: stop sequences, context, a required tool on an API without one", () =>
    Effect.gen(function* () {
      const { sampler, faux, answer } = open();

      faux.setResponses([answer("ok")]);
      yield* sampler.sample(
        ask({
          ...HI,
          stopSequences: ["END"],
          includeContext: "thisServer",
          toolChoice: { mode: "required" },
          tools: [{ name: "t", inputSchema: { type: "object" } }],
        }),
      );

      const [record] = yield* sampler.records;

      expect(record?.notes).toEqual([
        "asked to include context; none given",
        "stopSequences were not passed",
        "the model was not required to use a tool",
      ]);
    }));

  test("refuses the 21st request of a call with -1, and the next call starts again", () =>
    Effect.gen(function* () {
      const { sampler, faux, answer } = open();

      faux.setResponses(Array.from({ length: MCP_SAMPLINGS_PER_CALL + 1 }, () => answer("ok")));

      // Spaced over minutes: the pace is not what this test is about.
      for (let index = 1; index <= MCP_SAMPLINGS_PER_CALL; index += 1) {
        expect((yield* sampler.sample(ask(HI, { key: String(index) }))).kind).toBe("sampled");
        yield* TestClock.adjust(10_000);
      }

      const over = yield* sampler.sample(ask(HI, { key: "21" }));

      expect(refusedWith(over)).toEqual({
        code: -1,
        message: "sampling limit for this call reached",
      });
      expect((yield* sampler.records).at(-1)).toMatchObject({ status: "refused", by: "cloudpid" });

      yield* sampler.settleCall("call-1");
      expect((yield* sampler.sample(ask(HI, { key: "22" }))).kind).toBe("sampled");
    }));

  test("refuses with -1 at the Spend limit before it costs anything", () =>
    Effect.gen(function* () {
      const { sampler, usages, seen } = open({ over: () => "Spend limit of $1 reached" });
      const outcome = yield* sampler.sample(ask(HI));

      expect(refusedWith(outcome)).toEqual({
        code: -1,
        message: "out of budget: Spend limit of $1 reached",
      });
      expect(seen).toEqual([]);
      expect(usages).toEqual([]);
    }));

  test("refuses an invalid request with -32602: malformed, mispaired, or with tools over the bounds", () =>
    Effect.gen(function* () {
      const { sampler } = open();

      expect(refusedWith(yield* sampler.sample(ask({ messages: "no" })))).toMatchObject({
        code: -32602,
      });
      expect(
        refusedWith(
          yield* sampler.sample(
            ask({
              maxTokens: 5,
              messages: [
                {
                  role: "assistant",
                  content: { type: "tool_use", id: "a", name: "x", input: {} },
                },
              ],
            }),
          ),
        ),
      ).toMatchObject({
        code: -32602,
        message: expect.stringContaining("invalid sampling messages"),
      });
      expect(
        refusedWith(
          yield* sampler.sample(
            ask({
              ...HI,
              tools: Array.from({ length: 65 }, (_, index) => ({
                name: `t${index}`,
                inputSchema: {},
              })),
            }),
          ),
        ),
      ).toMatchObject({ code: -32602, message: expect.stringContaining("more than 64 tools") });
    }));

  test("refuses an image for a model that takes none with -32602", () =>
    Effect.gen(function* () {
      const { sampler } = open();

      expect(
        refusedWith(
          yield* sampler.sample(
            ask({
              ...HI,
              messages: [
                { role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } },
              ],
            }),
          ),
        ),
      ).toEqual({
        code: -32602,
        message: "unservable sampling request: the model takes no images",
      });
    }));

  test("answers -32603 when the model fails, and still counts what it cost", () =>
    Effect.gen(function* () {
      const { sampler, faux, usages } = open();

      faux.setResponses([
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
      ]);

      const outcome = yield* sampler.sample(ask(HI));

      expect(refusedWith(outcome)).toEqual({ code: -32603, message: "overloaded" });
      expect(outcome.detail).toMatchObject({ status: "failed" });
      expect(usages).toHaveLength(1);
    }));

  test("refuses -32603 before the Session's models are bound", () =>
    Effect.gen(function* () {
      const sampler = createMcpSampling({ storage: memory(), redact: Effect.succeed });

      expect(refusedWith(yield* sampler.sample(ask(HI)))).toMatchObject({ code: -32603 });
    }));

  test("keeps the Session's Secrets out of the record and out of what the model is given", () =>
    Effect.gen(function* () {
      const { sampler, faux, storage, seen, answer } = open({
        redact: (text) => text.replaceAll("sk-live-1234", "[SECRET:KEY]"),
      });

      faux.setResponses([answer("saw sk-live-1234")]);
      yield* sampler.sample(
        ask({
          ...HI,
          systemPrompt: "key is sk-live-1234",
          messages: [{ role: "user", content: { type: "text", text: "use sk-live-1234" } }],
          tools: [{ name: "t", description: "uses sk-live-1234", inputSchema: {} }],
        }),
      );

      expect(storage.dump()).not.toContain("sk-live-1234");
      expect(storage.dump()).toContain("[SECRET:KEY]");
      expect(seen[0]?.system).toBe("key is [SECRET:KEY]");
    }));

  test("keeps only the messages a call's later request adds, naming where they start", () =>
    Effect.gen(function* () {
      const { sampler, faux, answer } = open();

      faux.setResponses([answer("one"), answer("two")]);

      const first = { role: "user", content: { type: "text", text: "hi" } };
      const reply = { role: "assistant", content: { type: "text", text: "one" } };
      const more = { role: "user", content: { type: "text", text: "again" } };

      yield* sampler.sample(ask({ ...HI, messages: [first] }));
      yield* TestClock.adjust(1);
      yield* sampler.sample(ask({ ...HI, messages: [first, reply, more] }, { key: "2" }));

      const records = yield* sampler.records;

      expect(records[0]?.messages).toHaveLength(1);
      expect(records[1]).toMatchObject({ messagesFrom: 1 });
      expect(records[1]?.messages).toHaveLength(2);
    }));

  test("runs at most two samples of a server at once", () =>
    Effect.gen(function* () {
      const { sampler, faux } = open();
      const gates = yield* Effect.forEach([1, 2, 3, 4], () => Deferred.make<void>());
      let active = 0;
      let most = 0;
      let started = 0;

      faux.setResponses(
        gates.map((gate) => async () => {
          started += 1;
          active += 1;
          most = Math.max(most, active);
          await Effect.runPromise(Deferred.await(gate));
          active -= 1;

          return fauxAssistantMessage("ok");
        }),
      );

      const fibers = yield* Effect.forEach([1, 2, 3, 4], (index) =>
        Effect.forkChild(sampler.sample(ask(HI, { callId: `c${index}` }))),
      );

      yield* eventually(() => expect(started).toBe(SAMPLING_CONCURRENT));
      yield* Deferred.succeed(gates[0] ?? gates[1]!, undefined);
      yield* eventually(() => expect(started).toBe(SAMPLING_CONCURRENT + 1));
      expect(most).toBe(SAMPLING_CONCURRENT);

      for (const gate of gates) yield* Deferred.succeed(gate, undefined);

      for (const fiber of fibers) expect((yield* Fiber.join(fiber)).kind).toBe("sampled");
      expect(most).toBe(SAMPLING_CONCURRENT);
    }));

  test("delays, never refuses, the 31st sample of a server in a minute", () =>
    Effect.gen(function* () {
      const { sampler, faux, answer } = open();

      faux.setResponses(Array.from({ length: SAMPLING_PER_MINUTE + 1 }, () => answer("ok")));

      for (let index = 0; index < SAMPLING_PER_MINUTE; index += 1) {
        expect((yield* sampler.sample(ask(HI, { callId: `c${index}` }))).kind).toBe("sampled");
      }

      const late = yield* Effect.forkChild(sampler.sample(ask(HI, { callId: "late" })));

      yield* Effect.repeat(Effect.yieldNow, { times: 20 });
      expect(faux.state.callCount).toBe(SAMPLING_PER_MINUTE);

      yield* TestClock.adjust(60_000);
      expect((yield* Fiber.join(late)).kind).toBe("sampled");
      expect(faux.state.callCount).toBe(SAMPLING_PER_MINUTE + 1);
    }));
});
