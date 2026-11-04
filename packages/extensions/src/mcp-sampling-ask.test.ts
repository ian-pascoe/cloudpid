// A Legacy server whose definition says `ask` has its Sampling request shown to the owner on a card before it runs
// (`docs/architecture/mcp-server-requests.md` → Sampling requests, The card, Waiting): the sampler checks the request, asks
// through the Session's questions, and runs it on the Role the owner picked, or refuses it. The grants of *Allow for this
// call* and *Allow in this Session* skip the card; *Always allow* and *Never* write the definition.
// @effect-diagnostics strictEffectProvide:off preferEffectArray:off preferEffectRecord:off anyUnknownInErrorContext:off preferSchemaOverJson:off
import type { JsonObject } from "@cloudpid/mcp/types";
import type {
  McpElicitationSource,
  McpSamplingRequest,
  McpSamplingSessionGrant,
} from "@cloudpid/protocol";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it, vi } from "vitest";
import { MCP_RUN_STOPPED_REASON } from "./mcp/question-records.ts";
import { createMcpQuestions, McpQuestionsError } from "./mcp/questions.ts";
import { createMcpSampling, type McpSamplingAsk, type McpSamplingOutcome } from "./mcp/sampling.ts";

const memory = () => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the sampler and the questions read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      map.set(key, structuredClone(value));
    },
    delete: (key: string) => map.delete(key),
  };
};

const ROLES = {
  small: { provider: "anthropic", modelId: "claude-haiku-5-5" },
  medium: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
  large: { provider: "anthropic", modelId: "claude-opus-5-5" },
};

const HI: JsonObject = {
  messages: [{ role: "user", content: { type: "text", text: "Summarize the file" } }],
  systemPrompt: "You are terse",
  maxTokens: 100,
};

const open = (
  options: {
    readonly storage?: ReturnType<typeof memory>;
    readonly remember?: (input: {
      readonly server: string;
      readonly value: "allow" | "off";
    }) => Effect.Effect<void, McpQuestionsError>;
    /** Whether the write of a definition at the source can succeed (true unless a test says it cannot). */
    readonly writable?: (source: McpElicitationSource | undefined) => boolean;
    readonly over?: () => string | undefined;
    readonly waitMs?: number;
  } = {},
) => {
  const storage = options.storage ?? memory();

  const announced: Array<{
    requests: ReadonlyArray<McpSamplingRequest>;
    grants: ReadonlyArray<McpSamplingSessionGrant>;
  }> = [];

  const told: Array<{ server: string; page?: true; sampling?: true }> = [];
  const written: Array<{ server: string; value: string; source: unknown }> = [];

  const questions = createMcpQuestions({
    storage,
    announce: () => Effect.void,
    announceSampling: (message) =>
      Effect.sync(() => {
        announced.push(message);
      }),
    notify: (who) =>
      Effect.sync(() => {
        told.push(who);
      }),
    redact: Effect.succeed,
    holdsSecret: () => Effect.succeed(false),
    samplingWaitMs: options.waitMs,
    remember: {
      writable: (source) => Effect.succeed(options.writable?.(source) ?? true),
      write: (input) =>
        Effect.sync(() => {
          written.push({ server: input.server, value: input.value, source: input.source });
        }).pipe(Effect.andThen(options.remember?.(input) ?? Effect.void)),
    },
  });

  const faux = fauxProvider({
    provider: "anthropic",
    models: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }, { id: "claude-opus-5-5" }],
  });

  const models = createModels();

  models.setProvider(faux.provider);

  const sampler = createMcpSampling({ storage, redact: Effect.succeed, questions });

  sampler.bind({
    models,
    roles: () => ROLES,
    overLimit: () => Promise.resolve(options.over?.()),
    usage: () => undefined,
  });

  return { questions, sampler, faux, announced, told, written, storage };
};

const ask = (over: Partial<McpSamplingAsk> = {}): McpSamplingAsk => ({
  server: "demo",
  tool: "mcp__demo__loop",
  callId: "call-1",
  conversationId: ROOT_CONVERSATION_ID,
  key: "1",
  params: HI,
  decision: "ask",
  source: { kind: "global" },
  ...over,
});

const test = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

/** A moment for the fibers forked so far to run. */
const settle = Effect.repeat(Effect.yieldNow, { times: 8 });

/** Wait, in real time, until `check` stops throwing. */
const eventually = (check: () => void) => Effect.promise(() => vi.waitFor(check));

const refusedWith = (outcome: McpSamplingOutcome) =>
  outcome.kind === "refused" ? { code: outcome.code, message: outcome.message } : undefined;

describe("MCP sampling on a definition that says ask", () => {
  test("shows a card with the Role, the model and what was asked, tells the owner, and runs it on the owner's yes", () =>
    Effect.gen(function* () {
      const { sampler, questions, faux, announced, told } = open();

      faux.setResponses([fauxAssistantMessage("a summary")]);

      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));

      const [request] = yield* questions.pendingSampling;

      expect(request).toMatchObject({
        id: "call-1:1",
        callId: "call-1",
        server: "demo",
        tool: "mcp__demo__loop",
        role: "small",
        model: "claude-haiku-5-5",
        roles: [
          { role: "small", model: "claude-haiku-5-5" },
          { role: "medium", model: "claude-sonnet-5-5" },
          { role: "large", model: "claude-opus-5-5" },
        ],
        systemPrompt: "You are terse",
        messages: [{ role: "user", text: "Summarize the file" }],
        writable: true,
        source: { kind: "global" },
        deadline: 10 * 60 * 1000,
      });
      expect(told).toEqual([{ server: "demo", sampling: true }]);

      yield* questions.answerSampling("call-1:1", { choice: "allow_call" });

      const outcome = yield* Fiber.join(sampling);

      expect(outcome).toMatchObject({
        kind: "sampled",
        detail: { id: "call-1:1", status: "answered", by: "owner", role: "small" },
      });
      expect(announced.at(-1)?.requests).toEqual([]);

      const record = yield* sampler.view("call-1:1");

      expect(record).toMatchObject({ status: "answered", by: "owner", reply: "a summary" });
    }));

  test("runs the owner's Role, not the card's, when they pick another", () =>
    Effect.gen(function* () {
      const { sampler, questions, faux, announced } = open();

      faux.setResponses([fauxAssistantMessage("from the big one")]);

      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.answerSampling("call-1:1", { choice: "allow_call", role: "large" });

      expect(yield* Fiber.join(sampling)).toMatchObject({
        kind: "sampled",
        detail: { role: "large", model: "claude-opus-5-5" },
      });
    }));

  test("refuses an answer that names a Role the card did not offer, and keeps waiting", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced } = open();
      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));

      const failed = yield* questions
        .answerSampling("call-1:1", { choice: "allow_call", role: "xlarge" })
        .pipe(Effect.flip);

      expect(failed).toBeInstanceOf(McpQuestionsError);
      expect(yield* questions.pendingSampling).toHaveLength(1);

      yield* questions.answerSampling("call-1:1", { choice: "refuse" });
      yield* Fiber.join(sampling);
    }));

  test("answers the server -1 and records the owner's refusal, which the call's line says is theirs", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced, faux } = open();
      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.answerSampling("call-1:1", { choice: "refuse" });

      const outcome = yield* Fiber.join(sampling);

      expect(refusedWith(outcome)).toEqual({ code: -1, message: "refused by the owner" });
      expect(outcome.detail).toMatchObject({ status: "refused", by: "owner" });
      expect(faux.state.callCount).toBe(0);
    }));

  test("lets the call's later requests through on Allow for this call, with no card", () =>
    Effect.gen(function* () {
      const { sampler, questions, faux, announced } = open();

      faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

      const first = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.answerSampling("call-1:1", { choice: "allow_call" });
      yield* Fiber.join(first);

      const second = yield* sampler.sample(ask({ key: "2" }));

      expect(second).toMatchObject({
        kind: "sampled",
        detail: { by: "grant", status: "answered" },
      });
      expect(yield* sampler.view("call-1:2")).toMatchObject({ by: "grant" });

      // Another call asks again.
      yield* Effect.forkChild(sampler.sample(ask({ callId: "call-2" })));
      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      expect((yield* questions.pendingSampling)[0]?.callId).toBe("call-2");
    }));

  test("keeps Allow in this Session for every call of the server until the owner takes it back", () =>
    Effect.gen(function* () {
      const { sampler, questions, faux, announced } = open();

      faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

      const first = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.answerSampling("call-1:1", { choice: "allow_session" });
      yield* Fiber.join(first);

      expect(yield* questions.samplingGrants).toEqual([{ server: "demo", action: "allow" }]);
      expect(announced.at(-1)?.grants).toEqual([{ server: "demo", action: "allow" }]);

      expect(
        yield* sampler.sample(ask({ callId: "call-2", conversationId: ROOT_CONVERSATION_ID })),
      ).toMatchObject({ kind: "sampled", detail: { by: "grant" } });

      yield* questions.revokeSampling("demo");

      expect(yield* questions.samplingGrants).toEqual([]);
      expect(announced.at(-1)?.grants).toEqual([]);

      const third = yield* Effect.forkChild(sampler.sample(ask({ callId: "call-3" })));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.answerSampling("call-3:1", { choice: "refuse" });
      yield* Fiber.join(third);
    }));

  test("refuses at once, with no card, on Refuse in this Session, and refuses its other waiting requests", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced, faux } = open();

      const first = yield* Effect.forkChild(sampler.sample(ask()));
      const second = yield* Effect.forkChild(sampler.sample(ask({ key: "2" })));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(2));
      yield* questions.answerSampling("call-1:1", { choice: "refuse_session" });

      expect(refusedWith(yield* Fiber.join(first))?.code).toBe(-1);
      expect(refusedWith(yield* Fiber.join(second))?.code).toBe(-1);

      const later = yield* sampler.sample(ask({ callId: "call-2" }));

      expect(later).toMatchObject({
        kind: "refused",
        code: -1,
        detail: { by: "grant", status: "refused" },
      });
      expect(yield* questions.pendingSampling).toEqual([]);
      expect(faux.state.callCount).toBe(0);
    }));

  test("allows the call's other waiting requests with the one answered", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced, faux } = open();

      faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

      const first = yield* Effect.forkChild(sampler.sample(ask()));
      const second = yield* Effect.forkChild(sampler.sample(ask({ key: "2" })));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(2));
      yield* questions.answerSampling("call-1:1", { choice: "allow_call" });

      expect((yield* Fiber.join(first)).kind).toBe("sampled");
      expect(yield* Fiber.join(second)).toMatchObject({
        kind: "sampled",
        detail: { by: "owner", status: "answered" },
      });
    }));

  test("writes the definition on Always allow, then runs the request and the server's other waiting ones", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced, faux, written } = open();

      faux.setResponses([fauxAssistantMessage("always"), fauxAssistantMessage("also")]);

      const first = yield* Effect.forkChild(sampler.sample(ask()));
      const other = yield* Effect.forkChild(sampler.sample(ask({ callId: "call-2" })));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(2));
      yield* questions.answerSampling("call-1:1", { choice: "allow_always" });

      expect(yield* Fiber.join(first)).toMatchObject({ kind: "sampled", detail: { by: "owner" } });
      expect(yield* Fiber.join(other)).toMatchObject({ kind: "sampled" });
      expect(written).toEqual([{ server: "demo", value: "allow", source: { kind: "global" } }]);
      expect((yield* sampler.records).find((each) => each.id === "call-1:1")).toMatchObject({
        status: "answered",
        grant: "always",
      });
    }));

  test("allows for this call alone, and says so in the record, when Always allow cannot be written", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced, faux } = open({
        remember: () => McpQuestionsError.make({ message: "The definition changed meanwhile" }),
      });

      faux.setResponses([fauxAssistantMessage("once"), fauxAssistantMessage("twice")]);

      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.answerSampling("call-1:1", { choice: "allow_always" });

      expect(yield* Fiber.join(sampling)).toMatchObject({
        kind: "sampled",
        detail: { by: "owner" },
      });
      expect(yield* questions.pendingSampling).toEqual([]);

      const record = (yield* sampler.records).find((each) => each.id === "call-1:1");

      expect(record).toMatchObject({ status: "answered", grant: "call" });
      expect(record?.notes).toContain(
        "Always allow could not be saved (The definition changed meanwhile); allowed for this call only",
      );

      // The call's next request is let through; another call's asks again.
      expect(yield* sampler.sample(ask({ key: "2" }))).toMatchObject({ kind: "sampled" });
    }));

  test("lets the first answer win: a second Always or a Refuse finds the request taken, and writes once", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();

      const { sampler, questions, announced, faux, written } = open({
        remember: () => Deferred.await(held),
      });

      faux.setResponses([fauxAssistantMessage("always")]);

      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));

      const always = yield* Effect.forkChild(
        questions.answerSampling("call-1:1", { choice: "allow_always" }),
      );

      yield* eventually(() => expect(written).toHaveLength(1));

      const second = yield* questions
        .answerSampling("call-1:1", { choice: "allow_always" })
        .pipe(Effect.flip);

      const refuse = yield* questions
        .answerSampling("call-1:1", { choice: "refuse" })
        .pipe(Effect.flip);

      expect(second.message).toBe("This request is being answered");
      expect(refuse.message).toBe("This request is being answered");
      expect(written).toHaveLength(1);

      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(always);

      expect(yield* Fiber.join(sampling)).toMatchObject({
        kind: "sampled",
        detail: { by: "owner" },
      });
    }));

  test("does not let the clock end a request an Always is writing", () =>
    Effect.gen(function* () {
      const held = yield* Deferred.make<void>();

      const { sampler, questions, announced, faux } = open({
        waitMs: 1000,
        remember: () => Deferred.await(held),
      });

      faux.setResponses([fauxAssistantMessage("always")]);

      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));

      const always = yield* Effect.forkChild(
        questions.answerSampling("call-1:1", { choice: "allow_always" }),
      );

      yield* settle;
      yield* TestClock.adjust(2000);
      yield* settle;
      yield* Deferred.succeed(held, undefined);
      yield* Fiber.join(always);

      expect(yield* Fiber.join(sampling)).toMatchObject({
        kind: "sampled",
        detail: { by: "owner", status: "answered" },
      });
    }));

  test("Never refuses the request, the call's later requests and the server's other waiting ones, without asking", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced, faux, written } = open();
      const first = yield* Effect.forkChild(sampler.sample(ask()));
      const other = yield* Effect.forkChild(sampler.sample(ask({ callId: "call-2" })));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(2));
      yield* questions.answerSampling("call-1:1", { choice: "refuse_never" });

      expect(refusedWith(yield* Fiber.join(first))?.code).toBe(-1);
      expect(refusedWith(yield* Fiber.join(other))?.code).toBe(-1);
      expect(written).toEqual([{ server: "demo", value: "off", source: { kind: "global" } }]);

      // The same call's next request is refused with no card; the Session keeps no grant, so another call asks.
      const later = yield* sampler.sample(ask({ key: "2" }));

      expect(later).toMatchObject({ kind: "refused", detail: { by: "grant", status: "refused" } });
      expect(yield* questions.pendingSampling).toEqual([]);
      expect(yield* questions.samplingGrants).toEqual([]);
      expect(faux.state.callCount).toBe(0);
    }));

  test("Never still refuses when the definition cannot be written", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced } = open({
        remember: () => McpQuestionsError.make({ message: "no" }),
      });

      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.answerSampling("call-1:1", { choice: "refuse_never" });

      expect(refusedWith(yield* Fiber.join(sampling))?.code).toBe(-1);
    }));

  test("does not offer Always allow or Never when the write cannot succeed here, and refuses it", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced, written } = open({ writable: () => false });
      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      expect((yield* questions.pendingSampling)[0]?.writable).toBe(false);

      for (const choice of ["allow_always", "refuse_never"] as const) {
        const failed = yield* questions.answerSampling("call-1:1", { choice }).pipe(Effect.flip);

        expect(failed.message).toBe("This server's definition cannot be changed from here");
      }

      expect(written).toEqual([]);
      expect(yield* questions.pendingSampling).toHaveLength(1);
      yield* questions.answerSampling("call-1:1", { choice: "refuse" });
      yield* Fiber.join(sampling);
    }));

  test("does not offer Always allow or Never for a Repo's definition, and refuses to write it", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced, written } = open();

      const sampling = yield* Effect.forkChild(
        sampler.sample(ask({ source: { kind: "repo", slug: "acme/app" } })),
      );

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      expect((yield* questions.pendingSampling)[0]?.writable).toBe(false);

      const failed = yield* questions
        .answerSampling("call-1:1", { choice: "refuse_never" })
        .pipe(Effect.flip);

      expect(failed).toBeInstanceOf(McpQuestionsError);
      expect(written).toEqual([]);

      yield* questions.answerSampling("call-1:1", { choice: "refuse" });
      yield* Fiber.join(sampling);
    }));

  test("refuses a request the owner did not answer in time, as unanswered", () =>
    Effect.gen(function* () {
      const { sampler, announced } = open({ waitMs: 1000 });
      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* TestClock.adjust(1001);

      const outcome = yield* Fiber.join(sampling);

      expect(refusedWith(outcome)).toEqual({
        code: -1,
        message: "the owner did not answer in time",
      });
      expect(outcome.detail).toMatchObject({ why: "unanswered", by: "cloudpid" });
      expect(announced.at(-1)?.requests).toEqual([]);
    }));

  test("withdraws a waiting request when its call ends, and forgets the call's grant", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced } = open();
      const sampling = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.settleCall("call-1");

      expect(refusedWith(yield* Fiber.join(sampling))?.code).toBe(-1);
      expect(yield* questions.pendingSampling).toEqual([]);
    }));

  test("withdraws a waiting request when the server is switched off, and when the server cancels it", () =>
    Effect.gen(function* () {
      const { sampler, questions, announced } = open();
      const first = yield* Effect.forkChild(sampler.sample(ask()));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.withdrawServer("demo", "the server was switched off");

      expect(refusedWith(yield* Fiber.join(first))?.message).toBe("the server was switched off");

      const second = yield* Effect.forkChild(sampler.sample(ask({ key: "7", callId: "call-2" })));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      yield* questions.withdraw("call-2", "7", "the server stopped waiting");

      expect(refusedWith(yield* Fiber.join(second))?.message).toBe("the server stopped waiting");
    }));

  test("withdraws a waiting request when the Run is stopped, through the call's signal, and records why", () =>
    Effect.gen(function* () {
      const { sampler, announced, questions } = open();
      const stop = yield* Effect.sync(() => new AbortController());
      const sampling = yield* Effect.forkChild(sampler.sample(ask({ signal: stop.signal })));

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      stop.abort();

      const outcome = yield* Fiber.join(sampling);

      expect(refusedWith(outcome)).toEqual({ code: -1, message: MCP_RUN_STOPPED_REASON });
      expect(outcome.detail).toMatchObject({ by: "cloudpid", why: "unanswered" });
      expect(announced.at(-1)?.requests).toEqual([]);
      expect(yield* questions.pendingSampling).toEqual([]);
      expect(yield* sampler.view("call-1:1")).toMatchObject({
        status: "refused",
        reason: MCP_RUN_STOPPED_REASON,
      });
    }));

  test("refuses a request at once when the Run was stopped already", () =>
    Effect.gen(function* () {
      const { sampler, announced } = open();
      const stop = yield* Effect.sync(() => new AbortController());

      stop.abort();

      const outcome = yield* sampler.sample(ask({ signal: stop.signal }));

      expect(refusedWith(outcome)?.message).toBe(MCP_RUN_STOPPED_REASON);
      expect(announced.at(-1)?.requests ?? []).toEqual([]);
    }));

  test("asks nobody about a request it cannot serve or that is over the limit", () =>
    Effect.gen(function* () {
      const over = open({ over: () => "it has spent 2 of 1" });

      expect(refusedWith(yield* over.sampler.sample(ask()))).toMatchObject({ code: -1 });
      expect(over.announced).toEqual([]);
      expect(over.told).toEqual([]);

      const { sampler, announced, told } = open();

      expect(
        refusedWith(yield* sampler.sample(ask({ params: { messages: "none", maxTokens: 5 } }))),
      ).toMatchObject({ code: -32602 });
      expect(announced).toEqual([]);
      expect(told).toEqual([]);
    }));

  test("stops the call's clock while the owner decides", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const { sampler, questions, announced, faux } = open();

      faux.setResponses([fauxAssistantMessage("ok")]);

      const sampling = yield* Effect.forkChild(
        sampler.sample(
          ask({
            hold: {
              pause: Effect.sync(() => {
                calls.push("pause");
              }),
              resume: Effect.sync(() => {
                calls.push("resume");
              }),
            },
          }),
        ),
      );

      yield* eventually(() => expect(announced.at(-1)?.requests).toHaveLength(1));
      expect(calls).toEqual(["pause"]);
      yield* questions.answerSampling("call-1:1", { choice: "allow_call" });
      yield* Fiber.join(sampling);
      expect(calls).toEqual(["pause", "resume"]);
    }));

  test("settles the record an earlier instance left waiting, as refused and expired", () =>
    Effect.gen(function* () {
      const storage = memory();
      const earlier = open({ storage });
      const sampling = yield* Effect.forkChild(earlier.sampler.sample(ask()));

      yield* eventually(() => expect(earlier.announced.at(-1)?.requests).toHaveLength(1));

      // A new instance over the same storage: nothing waits for the record any longer.
      const later = open({ storage });

      yield* later.questions.expireStale;

      expect(yield* later.sampler.view("call-1:1")).toMatchObject({
        status: "refused",
        by: "cloudpid",
        reason: "expired: the server's call ended",
      });
      yield* Fiber.interrupt(sampling);
    }));

  test("a definition that says allow never asks", () =>
    Effect.gen(function* () {
      const { sampler, faux, announced, told } = open();

      faux.setResponses([fauxAssistantMessage("ok")]);

      expect(yield* sampler.sample(ask({ decision: "allow" }))).toMatchObject({
        kind: "sampled",
        detail: { by: "definition" },
      });
      expect(announced).toEqual([]);
      expect(told).toEqual([]);
    }));
});
