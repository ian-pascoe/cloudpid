/**
 * A Legacy server's Sampling request during a call (`docs/architecture/mcp-server-requests.md` → Questions, Sampling
 * requests; ADR-0039): the core ties it to the `tools/call` whose POST stream carried it, passes it to `onInput` while
 * the call's timeout stops, and answers the server with the reply `onInput` gives; a request that belongs to no such
 * call is refused `-1` "no conversation to sample in". A Modern connection declares no sampling.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { AGENT, completed, memoryStore, run, TARGET, testDeps } from "./core.fixture.ts";
import {
  type FakeServer,
  fetchTo,
  legacyStatefulServer,
  modernServer,
  rpcMethods,
  SAMPLE_TOOL,
} from "./fakes.fixture.ts";
import { connect, type McpDeps } from "./index.ts";
import type { McpCallContext, McpInputAnswer, McpInputRequest } from "./types.ts";

const SAMPLING: McpCallContext = {
  ...AGENT,
  answers: { sampling: true, inputWaitMs: 720_000 },
};

const DECLARES = { sampling: { tools: {} } };

const REPLY: McpInputAnswer = {
  kind: "sampled",
  result: {
    role: "assistant",
    content: { type: "text", text: "Hi there" },
    model: "claude-haiku",
    stopReason: "endTurn",
  },
};

/** Deps declaring sampling, answering each request with `answer`. */
const sampling = (
  server: FakeServer,
  answer: (request: McpInputRequest) => Effect.Effect<McpInputAnswer>,
  more: Partial<McpDeps> = {},
): McpDeps => ({
  ...testDeps(fetchTo(server)),
  capabilities: () => DECLARES,
  onInput: answer,
  ...more,
});

const call = (
  deps: McpDeps,
  ctx: McpCallContext,
  args: { readonly [key: string]: Schema.Json } = {},
  timeoutMs?: number,
) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(
        timeoutMs === undefined ? TARGET : { ...TARGET, timeoutMs },
        deps,
      );

      return yield* connection
        .callTool({ tool: SAMPLE_TOOL, arguments: args }, ctx)
        .pipe(Effect.result);
    }),
  );

const textOf = (outcome: Awaited<ReturnType<typeof call>>) =>
  Result.isSuccess(outcome)
    ? completed(outcome.success).value.content.map((block) =>
        block.type === "text" ? block.text : "",
      )
    : [];

describe("a Legacy server's Sampling request", () => {
  it("is answered with the reply onInput gives, and carries the server's parameters to it", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    const server = legacyStatefulServer(options);
    const seen: Array<McpInputRequest> = [];

    const outcome = await call(
      sampling(server, (request) => {
        seen.push(request);

        return Effect.succeed(REPLY);
      }),
      SAMPLING,
      { params: { systemPrompt: "Be brief", modelPreferences: { hints: [{ name: "haiku" }] } } },
    );

    expect(JSON.parse(textOf(outcome)[0] ?? "null")).toMatchObject({
      role: "assistant",
      content: { type: "text", text: "Hi there" },
      model: "claude-haiku",
      stopReason: "endTurn",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "sampling",
      mode: "live",
      params: {
        systemPrompt: "Be brief",
        maxTokens: 100,
        messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        modelPreferences: { hints: [{ name: "haiku" }] },
      },
    });
  });

  it("is asked once for each request of a tool loop, in the call that carried it", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    const server = legacyStatefulServer(options);
    let asked = 0;

    const outcome = await call(
      sampling(server, () => {
        asked += 1;

        return Effect.succeed(REPLY);
      }),
      SAMPLING,
      { rounds: 3 },
    );

    expect(Result.isSuccess(outcome)).toBe(true);
    expect(asked).toBe(3);
    expect(options.sampled).toHaveLength(3);
  });

  it.each([
    [{ kind: "refused" as const, message: "refused by you" }, -1, "refused by you"],
    [
      { kind: "refused" as const, message: "invalid sampling messages: x", code: -32602 },
      -32602,
      "invalid sampling messages: x",
    ],
    [{ kind: "refused" as const, message: "model failed", code: -32603 }, -32603, "model failed"],
  ])("is the server's error %#, as the Session refuses it", async (answer, code, message) => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    const server = legacyStatefulServer(options);

    const outcome = await call(
      sampling(server, () => Effect.succeed(answer)),
      SAMPLING,
    );

    expect(textOf(outcome)[0]).toContain(message);
    expect(options.sampled).toEqual([{ error: expect.stringContaining(message), code }]);
  });

  it("is refused `-1`, and never handed to onInput, on a call that offered only to answer forms", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    const server = legacyStatefulServer(options);
    let asked = 0;

    const outcome = await call(
      sampling(server, () => {
        asked += 1;

        return Effect.succeed(REPLY);
      }),
      { ...AGENT, answers: { elicitation: true, inputWaitMs: 600_000 } },
    );

    expect(asked).toBe(0);
    expect(textOf(outcome)[0]).toContain("did not offer to answer a sampling request");
    expect(options.sampled).toEqual([
      { error: expect.stringContaining("did not offer"), code: -1 },
    ]);
  });

  it("is refused, whatever the Session answers, when it was answered as a form or kept for later", async () => {
    for (const answer of [
      { kind: "defer" as const },
      { kind: "answered" as const, result: { action: "accept" as const } },
    ]) {
      const options = { moreTools: [SAMPLE_TOOL], sampled: [] };

      await call(
        sampling(legacyStatefulServer(options), () => Effect.succeed(answer)),
        SAMPLING,
      );

      expect(options.sampled).toHaveLength(1);
      expect(options.sampled[0]).toMatchObject({ code: expect.any(Number) });
    }
  });

  it("is refused 'no conversation to sample in' when the server asks on its standalone stream", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    let asked = 0;

    await call(
      sampling(legacyStatefulServer(options), () => {
        asked += 1;

        return Effect.succeed(REPLY);
      }),
      SAMPLING,
      { standalone: true },
    );

    expect(asked).toBe(0);
    expect(options.sampled).toEqual([
      { error: expect.stringContaining("no conversation to sample in"), code: -1 },
    ]);
  });

  it.each([
    ["on the call's own stream", SAMPLING, {}],
    ["on the standalone stream", SAMPLING, { standalone: true }],
    ["on a call that cannot answer it", AGENT, {}],
    ["on a call that offered only forms", { ...AGENT, answers: { elicitation: true } }, {}],
  ])("is noted as deprecated %s, however it ends", async (_name, ctx, args) => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    const noted: string[] = [];

    await call(
      sampling(legacyStatefulServer(options), () => Effect.succeed(REPLY), {
        onDeprecated: (feature) => {
          noted.push(feature);
        },
      }),
      ctx,
      args,
    );

    expect(noted).toEqual(["sampling"]);
  });

  it("is refused without asking when the call cannot answer it", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    let asked = 0;

    await call(
      sampling(legacyStatefulServer(options), () => {
        asked += 1;

        return Effect.succeed(REPLY);
      }),
      AGENT,
    );

    expect(asked).toBe(0);
    expect(options.sampled).toEqual([
      { error: expect.stringContaining("no conversation to sample in"), code: -1 },
    ]);
  });

  it("is refused when no onInput is given, though the connection declares sampling", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };

    const { onInput: _none, ...without } = sampling(
      legacyStatefulServer(options),
      () => Effect.never,
    );

    await call(without, SAMPLING);

    expect(options.sampled).toEqual([
      { error: expect.stringContaining("no conversation to sample in"), code: -1 },
    ]);
  });

  it("is refused once the wait ends, whatever onInput does", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };

    await call(
      sampling(legacyStatefulServer(options), () => Effect.never),
      { ...SAMPLING, answers: { sampling: true, inputWaitMs: 80 } },
    );

    expect(options.sampled).toEqual([
      { error: expect.stringContaining("did not answer in time"), code: -1 },
    ]);
  });

  it("pauses the call's timeout while it waits, up to the wait of its kind", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };

    // The call's timeout is 150 ms and the sample takes 500 ms: the call still ends well.
    const slow = await call(
      sampling(legacyStatefulServer(options), () => Effect.sleep(500).pipe(Effect.as(REPLY))),
      SAMPLING,
      {},
      150,
    );

    expect(Result.isSuccess(slow)).toBe(true);
    expect(options.sampled).toHaveLength(1);
    expect(options.sampled[0]).toMatchObject({ role: "assistant" });
  });

  it("is withdrawn, the caller told, when the server stops waiting for it", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    const server = legacyStatefulServer(options);
    const ended: Array<string> = [];

    const outcome = await run(
      Effect.gen(function* () {
        const connection = yield* connect(
          TARGET,
          sampling(server, () => Effect.never, {
            onInputEnded: (key) => {
              ended.push(key);
            },
          }),
        );

        return yield* connection
          .callTool(
            {
              tool: SAMPLE_TOOL,
              arguments: { giveUpMs: 100 },
            },
            SAMPLING,
          )
          .pipe(Effect.result);
      }),
    );

    expect(Result.isSuccess(outcome)).toBe(true);
    expect(ended).toHaveLength(1);
    expect(options.sampled).toHaveLength(1);
  });

  it("is never sent a call header, which the tap strips", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    const server = legacyStatefulServer(options);

    await call(
      sampling(server, () => Effect.succeed(REPLY)),
      SAMPLING,
    );

    expect(server.received.every((received) => !received.headers.has("x-cloudpid-call"))).toBe(
      true,
    );
  });

  it("is declared at initialize, and initializes again a session that was opened without it", async () => {
    const server = legacyStatefulServer({ moreTools: [SAMPLE_TOOL], sampled: [] });
    const sessions = memoryStore();

    await run(connect(TARGET, testDeps(fetchTo(server), { sessions: sessions.store })));

    expect(rpcMethods(server).filter((method) => method === "initialize")).toHaveLength(1);

    await run(
      connect(TARGET, { ...sampling(server, () => Effect.never), sessions: sessions.store }),
    );

    const initializes = server.received.filter((received) => received.rpc?.method === "initialize");

    expect(initializes).toHaveLength(2);
    expect(initializes[1]?.rpc?.params).toMatchObject({ capabilities: DECLARES });

    // And the session now kept is used as it is by one declaring the same.
    await run(
      connect(TARGET, { ...sampling(server, () => Effect.never), sessions: sessions.store }),
    );

    expect(rpcMethods(server).filter((method) => method === "initialize")).toHaveLength(2);
  });

  it("is not asked of a connection that declares no sampling", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    let asked = 0;

    await call(
      {
        ...sampling(legacyStatefulServer(options), () => {
          asked += 1;

          return Effect.succeed(REPLY);
        }),
        capabilities: () => ({}),
      },
      SAMPLING,
    );

    expect(asked).toBe(0);
    expect(options.sampled).toHaveLength(1);
    expect(options.sampled[0]).toHaveProperty("error");
  });
});

describe("a Modern server", () => {
  it("is declared no sampling, whatever the deps' declaration for a connection with no call", async () => {
    const server = modernServer({ moreTools: [SAMPLE_TOOL], sampled: [] });

    // The engine's declaration is for `ctx === undefined` (a Legacy `initialize`); every Modern request has its own.
    await call(
      {
        ...testDeps(fetchTo(server)),
        capabilities: (ctx) => (ctx === undefined ? DECLARES : {}),
        onInput: () => Effect.succeed(REPLY),
      },
      SAMPLING,
    );

    // Only the probe (`server/discover`, which no server can answer with a request) carries the connection-wide
    // declaration, as it carries a form's; no call or list does.
    const sent = server.received.flatMap((received) =>
      received.rpc === undefined || received.rpc.method === "server/discover"
        ? []
        : [JSON.stringify(received.rpc)],
    );

    expect(sent.some((rpc) => rpc.includes("clientCapabilities"))).toBe(true);
    expect(sent.every((rpc) => !rpc.includes('"sampling"'))).toBe(true);
  });
});
