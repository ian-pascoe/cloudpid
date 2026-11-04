/**
 * A Modern server's questions (`docs/architecture/mcp-server-requests.md` → Questions; ADR-0037): a `tools/call` the
 * server answers `input_required` is answered by the core's own rounds. When `onInput` answers everything at once, the
 * core sends the call again itself (a new id, `requestState` byte for byte, at most 10 rounds, the result not
 * cacheable); when the caller defers a question, the call ends as `input_required` with a `ResumeState`, and `resume`
 * sends it again with the answers, never a partial round.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off schemaSync:off
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AGENT, completed, failedWith, run, settled, TARGET, testDeps } from "./core.fixture.ts";
import {
  ASK_TOOL,
  type FakeServer,
  fetchTo,
  modernServer,
  TASKS_EXTENSION,
  VISIT_TOOL,
} from "./fakes.fixture.ts";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { connect, type InputRequired, type McpDeps, type Outcome } from "./index.ts";
import {
  MCP_RESUME_STATE_EXPIRED,
  type McpCallContext,
  type McpInputAnswer,
  type McpInputRequest,
  ProtocolViolation,
  ServerError,
  Unsupported,
} from "./types.ts";

const ROOTS = [{ uri: "file:///workspace/app", name: "ian/app" }];

const FORM = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };

/** A call whose caller answers elicitations and keeps them for later. */
const DEFERRING: McpCallContext = { ...AGENT, answers: { elicitation: true, defer: true } };

/** A call whose caller answers elicitations, but only at once. */
const ANSWERING: McpCallContext = { ...AGENT, answers: { elicitation: true } };

const ACCEPTED: McpInputAnswer = {
  kind: "answered",
  result: { action: "accept", content: { name: "Ada" } },
};

/** Deps that declare a form elicitation on a call that offers one, and answer each question with `answer`. */
const deps = (
  server: FakeServer,
  answer: (request: McpInputRequest) => McpInputAnswer,
  seen: Array<McpInputRequest> = [],
  extra: Partial<McpDeps> = {},
): McpDeps =>
  testDeps(fetchTo(server), {
    capabilities: (ctx) =>
      ctx?.answers?.elicitation === true ? { elicitation: { form: {} } } : {},
    onInput: (request) =>
      Effect.sync(() => {
        seen.push(request);

        return answer(request);
      }),
    ...extra,
  });

type Args = Readonly<Record<string, Schema.Json>>;

/** Calls `ask` with `args` once. */
const ask = (server: FakeServer, given: McpDeps, ctx: McpCallContext, args: Args = {}) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(TARGET, given);

      return yield* settled(
        connection.callTool(
          {
            tool: ASK_TOOL,
            arguments: { message: "Who are you?", requestedSchema: FORM, ...args },
          },
          ctx,
        ),
      );
    }),
  );

/** Resumes `state` with `answers`, on a new connection, as a later engine call does. */
const resume = (
  given: McpDeps,
  state: Schema.Json,
  answers: Readonly<Record<string, Schema.Json>>,
  ctx: McpCallContext = DEFERRING,
) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(TARGET, given);

      // SAFETY: each answer is a JSON object, as `inputResponses` carries.
      return yield* settled(connection.resume(state, answers as never, ASK_TOOL, ctx));
    }),
  );

/** The `tools/call` requests the server received, with their ids and the params of each. */
const calls = (server: FakeServer) =>
  server.received.flatMap((received) =>
    received.rpc?.method === "tools/call" ? [received.rpc] : [],
  );

const valueOf = <A>(outcome: { readonly value: A } | { readonly failed: unknown }): A => {
  if (!("value" in outcome)) throw new Error(`Expected a value, got ${JSON.stringify(outcome)}`);

  return outcome.value;
};

const inputRequired = (outcome: Outcome<unknown>): InputRequired => {
  if (outcome.kind !== "input_required") {
    throw new Error(`Expected input_required, got ${outcome.kind}`);
  }

  return outcome;
};

const decodeText = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));

/** The JSON text the `ask` tool answered with. */
const answeredText = (outcome: Outcome<CallToolResult>): Schema.Json => {
  const [first] = completed(outcome).value.content;

  return first?.type === "text" ? decodeText(first.text) : null;
};

describe("A Modern server's questions", () => {
  it("are answered at once and the call sent again on a new id, with the server's state byte for byte", async () => {
    const options = { moreTools: [ASK_TOOL], asked: [] };
    const server = modernServer(options);
    const seen: Array<McpInputRequest> = [];

    const outcome = valueOf(
      await ask(
        server,
        deps(server, () => ACCEPTED, seen),
        ANSWERING,
      ),
    );

    expect(answeredText(outcome)).toEqual({ q1: { action: "accept", content: { name: "Ada" } } });
    // A result that came from answered questions is never cached.
    expect(completed(outcome).cacheable).toBe(false);
    expect(seen).toEqual([
      {
        key: "q1",
        kind: "elicitation",
        mode: "deferrable",
        era: "modern",
        params: expect.objectContaining({ message: "Who are you?", requestedSchema: FORM }),
      },
    ]);

    const [first, second] = calls(server);

    expect(calls(server)).toHaveLength(2);
    expect(second?.id).not.toEqual(first?.id);
    expect(second?.params?.["requestState"]).toBe("round-1");
    expect(options.asked).toEqual([expect.objectContaining({ round: 1, state: "round-1" })]);
  });

  it("declares the form elicitation only on a call that offers it", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });
    const asked: Array<McpCallContext | undefined> = [];

    await ask(
      server,
      deps(server, () => ACCEPTED, [], {
        capabilities: (ctx) => {
          asked.push(ctx);

          return ctx?.answers?.elicitation === true ? { elicitation: { form: {} } } : {};
        },
      }),
      ANSWERING,
    );

    expect(asked).toContainEqual(ANSWERING);
  });

  it("cancels a question on a call that offers no elicitation, without asking", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });
    const seen: Array<McpInputRequest> = [];

    // Declared to every request, so the server asks a call whose caller answers nothing.
    const outcome = valueOf(
      await ask(
        server,
        deps(server, () => ACCEPTED, seen, { capabilities: () => ({ elicitation: { form: {} } }) }),
        AGENT,
      ),
    );

    expect(answeredText(outcome)).toEqual({ q1: { action: "cancel" } });
    expect(seen).toEqual([]);
  });

  it("is never asked on a call that declares no elicitation", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });

    const outcome = await ask(
      server,
      deps(server, () => ACCEPTED),
      AGENT,
    );

    expect(outcome).toEqual(failedWith(ServerError, { code: -32021 }));
  });

  it("reads a deferral as a cancel on a call that keeps no questions", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });

    const outcome = valueOf(
      await ask(
        server,
        deps(server, () => ({ kind: "defer" })),
        ANSWERING,
      ),
    );

    expect(answeredText(outcome)).toEqual({ q1: { action: "cancel" } });
  });

  it("ends the call locally when the caller refuses a question, telling the server nothing", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });

    const outcome = await ask(
      server,
      deps(server, () => ({ kind: "refused", message: "sampling refused" })),
      DEFERRING,
    );

    expect(outcome).toEqual(failedWith(Unsupported, { message: "sampling refused" }));
    expect(calls(server)).toHaveLength(1);
  });

  it("returns a deferred round as input_required, then resumes it once with the answers", async () => {
    const options = { moreTools: [ASK_TOOL], asked: [] };
    const server = modernServer(options);

    const deferred = inputRequired(
      valueOf(
        await ask(
          server,
          deps(server, () => ({ kind: "defer" })),
          DEFERRING,
        ),
      ),
    );

    expect(deferred.requests).toEqual([expect.objectContaining({ key: "q1", mode: "deferrable" })]);
    expect(deferred.resume).toMatchObject({
      v: 1,
      method: "tools/call",
      name: "ask",
      requestState: "round-1",
      deferred: ["q1"],
      round: 1,
    });
    // The server got the call once, and nothing more while the question waits.
    expect(calls(server)).toHaveLength(1);

    // The state is JSON: it crosses RPC and Session storage as it is.
    const kept: Schema.Json = JSON.parse(JSON.stringify(deferred.resume));

    const resumed = valueOf(
      await resume(
        deps(server, () => ({ kind: "defer" })),
        kept,
        {
          q1: { action: "accept", content: { name: "Ada" } },
        },
      ),
    );

    expect(answeredText(resumed)).toEqual({ q1: { action: "accept", content: { name: "Ada" } } });
    expect(completed(resumed).cacheable).toBe(false);
    expect(calls(server)).toHaveLength(2);
    expect(calls(server)[1]?.params?.["requestState"]).toBe("round-1");
  });

  it("keeps the round's answers given at once, and sends them with the deferred ones, never a partial round", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });

    const deferred = inputRequired(
      valueOf(
        await ask(
          server,
          deps(
            server,
            (request: McpInputRequest) => (request.key === "q1" ? ACCEPTED : { kind: "defer" }),
            [],
            { roots: ROOTS },
          ),
          DEFERRING,
          { forms: 2, roots: true },
        ),
      ),
    );

    expect(deferred.requests.map((request) => request.key)).toEqual(["q2"]);
    // Roots are the core's own answer, kept with the round.
    expect(deferred.resume.answered).toEqual({
      q1: { action: "accept", content: { name: "Ada" } },
      roots: { roots: ROOTS },
    });

    const later = deps(server, () => ACCEPTED, [], { roots: ROOTS });
    const partial = await resume(later, deferred.resume, {});

    // The caller's fault, not the server's: nothing was sent.
    expect(partial).toEqual(failedWith(Unsupported));
    expect(calls(server)).toHaveLength(1);

    const resumed = valueOf(await resume(later, deferred.resume, { q2: { action: "decline" } }));

    expect(answeredText(resumed)).toEqual({
      q1: { action: "accept", content: { name: "Ada" } },
      q2: { action: "decline" },
      roots: { roots: ROOTS },
    });
  });

  it("keeps a page the server asks the owner to open, and resumes the call with an accept once it is done", async () => {
    const options = { moreTools: [VISIT_TOOL], asked: [] };
    const server = modernServer(options);
    const seen: Array<McpInputRequest> = [];
    const declared: Array<McpCallContext | undefined> = [];
    const PAGING: McpCallContext = { ...DEFERRING, answers: { ...DEFERRING.answers, pages: true } };

    const given = deps(server, () => ({ kind: "defer" }), seen, {
      capabilities: (ctx) => {
        declared.push(ctx);

        return { elicitation: { form: {}, url: {} } };
      },
    });

    const deferred = inputRequired(
      valueOf(
        await run(
          Effect.gen(function* () {
            const connection = yield* connect(TARGET, given);

            return yield* settled(
              connection.callTool(
                {
                  tool: VISIT_TOOL,
                  arguments: { url: "https://login.example.com/go", message: "Sign in" },
                },
                PAGING,
              ),
            );
          }),
        ),
      ),
    );

    // A page is a question to keep like a form, told apart by its params, and says the era that asked.
    expect(seen).toEqual([
      {
        key: "page",
        kind: "elicitation",
        mode: "deferrable",
        era: "modern",
        params: expect.objectContaining({
          mode: "url",
          url: "https://login.example.com/go",
          message: "Sign in",
        }),
      },
    ]);
    expect(deferred.resume).toMatchObject({ requestState: "visit-1", deferred: ["page"] });
    expect(declared).toContainEqual(PAGING);

    const resumed = valueOf(
      await resume(
        given,
        JSON.parse(JSON.stringify(deferred.resume)),
        { page: { action: "accept" } },
        PAGING,
      ),
    );

    expect(answeredText(resumed)).toEqual({ page: { action: "accept" } });
    expect(options.asked).toEqual([{ round: 1, responses: { page: { action: "accept" } } }]);
  });

  it("answers a round on the MCP task wire too, for a call offered a task", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL], extensions: { [TASKS_EXTENSION]: {} } });
    const deferring = deps(server, () => ({ kind: "defer" }));
    const offered: McpCallContext = { ...DEFERRING, allowTask: true };

    const deferred = inputRequired(valueOf(await ask(server, deferring, offered)));

    const resumed = valueOf(
      await resume(deferring, deferred.resume, { q1: { action: "decline" } }, offered),
    );

    expect(answeredText(resumed)).toEqual({ q1: { action: "decline" } });
    expect(calls(server)).toHaveLength(2);
    // Both declared the tasks extension: they went on the task wire.
    expect(
      calls(server).map((call) => JSON.stringify(call.params?.["_meta"]).includes(TASKS_EXTENSION)),
    ).toEqual([true, true]);
  });

  it("goes round by round: a resume answered with another round is input_required again", async () => {
    const options = { moreTools: [ASK_TOOL], asked: [] };
    const server = modernServer(options);
    const deferring = deps(server, () => ({ kind: "defer" }));

    const first = inputRequired(valueOf(await ask(server, deferring, DEFERRING, { rounds: 2 })));

    const second = inputRequired(
      valueOf(await resume(deferring, first.resume, { q1: { action: "decline" } })),
    );

    expect(second.resume).toMatchObject({ round: 2, requestState: "round-2" });

    const done = valueOf(await resume(deferring, second.resume, { q1: { action: "cancel" } }));

    expect(answeredText(done)).toEqual({ q1: { action: "cancel" } });
    expect(calls(server)).toHaveLength(3);
    expect(options.asked).toEqual([
      expect.objectContaining({ round: 1 }),
      expect.objectContaining({ round: 2 }),
    ]);
  });

  it("fails a call whose server asks for more than 10 rounds", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });

    const outcome = await ask(
      server,
      deps(server, () => ACCEPTED),
      ANSWERING,
      { rounds: 11 },
    );

    expect(outcome).toEqual(failedWith(ProtocolViolation));
    expect(calls(server)).toHaveLength(11);
  });

  it.each([
    ["a format it does not know", { v: 2, method: "tools/call" }],
    ["no state at all", "nothing"],
  ])("refuses to resume %s, sending nothing", async (_name, state) => {
    const server = modernServer({ moreTools: [ASK_TOOL] });

    const outcome = await resume(
      deps(server, () => ACCEPTED),
      state,
      { q1: { action: "cancel" } },
    );

    expect(outcome).toEqual(failedWith(Unsupported, { message: MCP_RESUME_STATE_EXPIRED }));
    expect(calls(server)).toHaveLength(0);
  });

  it("answers a read's questions at once, deferring none, and reads again with the answers, not cacheable", async () => {
    const asked: Array<Schema.Json> = [];

    const server = modernServer({
      asked,
      resources: [
        { uri: "file:///notes", name: "notes", contents: [], asks: { message: "Go on?" } },
      ],
    });

    const seen: Array<McpInputRequest> = [];

    // The caller would keep it for later, but a read has no resume: its deferral is a `cancel`.
    const deferring = deps(server, () => ({ kind: "defer" }), seen);

    const outcome = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, deferring);

        return yield* settled(connection.readResource("file:///notes", DEFERRING));
      }),
    );

    expect(seen).toEqual([expect.objectContaining({ key: "q1", kind: "elicitation" })]);
    expect(asked).toEqual([{ round: 1, state: "read-1", responses: { q1: { action: "cancel" } } }]);
    expect(outcome).toMatchObject({
      value: {
        kind: "complete",
        cacheable: false,
        value: { contents: [{ text: JSON.stringify({ action: "cancel" }) }] },
      },
    });

    // Answered at once, the answer goes with the second read.
    const answering = deps(server, () => ACCEPTED);

    const read = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, answering);

        return yield* settled(connection.readResource("file:///notes", ANSWERING));
      }),
    );

    expect(read).toMatchObject({
      value: { value: { contents: [{ text: JSON.stringify(ACCEPTED.result) }] } },
    });
  });
});

/** A call whose caller answers Sampling requests and keeps questions for later. */
const SAMPLING_DEFERRING: McpCallContext = {
  ...AGENT,
  answers: { elicitation: true, sampling: true, defer: true },
};

/** A call whose caller answers Sampling requests, but only at once. */
const SAMPLING: McpCallContext = { ...AGENT, answers: { sampling: true } };

const SAMPLED: McpInputAnswer = {
  kind: "sampled",
  result: { role: "assistant", content: { type: "text", text: "A reply" }, model: "small-1" },
};

/** Deps that declare sampling on a call that offers to answer it. */
const sampler = (
  server: FakeServer,
  answer: (request: McpInputRequest) => McpInputAnswer,
  seen: Array<McpInputRequest> = [],
) =>
  deps(server, answer, seen, {
    capabilities: (ctx) => {
      const elicits = ctx?.answers?.elicitation === true;
      const samples = ctx?.answers?.sampling === true;

      if (elicits && samples) return { elicitation: { form: {} }, sampling: { tools: {} } };

      if (elicits) return { elicitation: { form: {} } };

      return samples ? { sampling: { tools: {} } } : {};
    },
  });

describe("A Modern server's Sampling requests", () => {
  it("are run through onInput, and the call is sent again with the reply as the answer", async () => {
    const options = { moreTools: [ASK_TOOL], asked: [] };
    const server = modernServer(options);
    const seen: Array<McpInputRequest> = [];

    const outcome = valueOf(
      await ask(
        server,
        sampler(server, () => SAMPLED, seen),
        SAMPLING,
        {
          forms: 0,
          samples: 1,
        },
      ),
    );

    expect(seen).toEqual([
      {
        key: "s1",
        kind: "sampling",
        mode: "deferrable",
        era: "modern",
        params: expect.objectContaining({ maxTokens: 100 }),
      },
    ]);
    expect(answeredText(outcome)).toEqual({
      s1: { role: "assistant", content: { type: "text", text: "A reply" }, model: "small-1" },
    });
    expect(calls(server)).toHaveLength(2);
    expect(completed(outcome).cacheable).toBe(false);
  });

  it("are kept for later by a call that defers: input_required, then one resume with the reply", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL], asked: [] });

    const deferred = inputRequired(
      valueOf(
        await ask(
          server,
          sampler(server, () => ({ kind: "defer" })),
          SAMPLING_DEFERRING,
          { forms: 0, samples: 1 },
        ),
      ),
    );

    expect(deferred.requests).toEqual([
      expect.objectContaining({ key: "s1", kind: "sampling", mode: "deferrable" }),
    ]);
    expect(deferred.resume).toMatchObject({ requestState: "round-1", deferred: ["s1"] });
    expect(calls(server)).toHaveLength(1);

    const resumed = valueOf(
      await resume(
        sampler(server, () => ({ kind: "defer" })),
        JSON.parse(JSON.stringify(deferred.resume)),
        { s1: { ...SAMPLED.result } },
        SAMPLING_DEFERRING,
      ),
    );

    expect(answeredText(resumed)).toEqual({
      s1: { role: "assistant", content: { type: "text", text: "A reply" }, model: "small-1" },
    });
    expect(calls(server)).toHaveLength(2);
  });

  it("sink the round when the caller refuses one: the call ends locally and the server is told nothing", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });
    const seen: Array<McpInputRequest> = [];

    const outcome = await ask(
      server,
      sampler(
        server,
        (request) =>
          request.kind === "sampling"
            ? { kind: "refused", message: "out of budget", code: -1 }
            : { kind: "defer" },
        seen,
      ),
      SAMPLING_DEFERRING,
      { forms: 1, samples: 1 },
    );

    expect(outcome).toEqual(failedWith(Unsupported, { message: "out of budget" }));
    // The form came first and was kept; the round is never sent, whole or in part.
    expect(seen.map((request) => request.key)).toEqual(["q1", "s1"]);
    expect(calls(server)).toHaveLength(1);
  });

  it("end the call when a caller that keeps nothing defers one: a Sampling request has no cancel", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });

    const outcome = await ask(
      server,
      sampler(server, () => ({ kind: "defer" })),
      SAMPLING,
      { forms: 0, samples: 1 },
    );

    expect(outcome).toEqual(
      failedWith(Unsupported, { message: "cloudpid could not answer the sampling request" }),
    );
    expect(calls(server)).toHaveLength(1);
  });

  it("fail the call when the caller never offered to answer one", async () => {
    const server = modernServer({ moreTools: [ASK_TOOL] });
    const seen: Array<McpInputRequest> = [];

    // Declared to every request, so the server asks a call whose caller answers no Sampling request.
    const outcome = await ask(
      server,
      deps(server, () => SAMPLED, seen, { capabilities: () => ({ sampling: { tools: {} } }) }),
      ANSWERING,
      { forms: 0, samples: 1 },
    );

    expect(outcome).toEqual(failedWith(ProtocolViolation));
    expect(seen).toEqual([]);
    expect(calls(server)).toHaveLength(1);
  });
});
