/**
 * A Legacy server's URL-mode elicitation (`docs/architecture/mcp-server-requests.md` → Questions, Elicitation
 * requests): a page the server asks the owner to open during a call, whose clock stays stopped until the owner has
 * finished there; and `-32042` (URL elicitation required), which refuses the call before it runs, so it is kept for
 * the owner and sent again, at most ten times.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { AGENT, completed, run, TARGET, testDeps } from "./core.fixture.ts";
import {
  type FakeServer,
  fetchTo,
  GATED_TOOL,
  legacyStatefulServer,
  VISIT_TOOL,
} from "./fakes.fixture.ts";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { connect, type McpConnection, type McpDeps } from "./index.ts";
import {
  MCP_INPUT_ROUNDS,
  type McpCallContext,
  type McpError,
  type McpInputAnswer,
  type McpInputRequest,
  ServerError,
} from "./types.ts";

const ASKING: McpCallContext = {
  ...AGENT,
  answers: { elicitation: true, inputWaitMs: 600_000 },
};

const DEFERRING: McpCallContext = { ...ASKING, answers: { ...ASKING.answers, defer: true } };

const KEEPING: McpCallContext = { ...DEFERRING, answers: { ...DEFERRING.answers, pages: true } };

const ASKS = { elicitation: { form: {}, url: {} } };

const ACCEPT: McpInputAnswer = { kind: "answered", result: { action: "accept" } };

/** Deps declaring `url`, answering each question with `answer`. */
const asking = (
  server: FakeServer,
  answer: (request: McpInputRequest) => Effect.Effect<McpInputAnswer>,
  more: Partial<McpDeps> = {},
): McpDeps => ({
  ...testDeps(fetchTo(server)),
  capabilities: () => ASKS,
  onInput: answer,
  ...more,
});

const PAGE = { url: "https://example.com/authorize", message: "Authorize the app" };

const visit = (
  deps: McpDeps,
  args: Record<string, string | number | boolean>,
  ctx: McpCallContext = ASKING,
  timeoutMs?: number,
) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(
        timeoutMs === undefined ? TARGET : { ...TARGET, timeoutMs },
        deps,
      );

      return yield* connection
        .callTool({ tool: VISIT_TOOL, arguments: { ...PAGE, ...args } }, ctx)
        .pipe(Effect.result);
    }),
  );

const textOf = (outcome: Awaited<ReturnType<typeof visit>>) =>
  Result.isSuccess(outcome)
    ? completed(outcome.success).value.content.map((block) =>
        block.type === "text" ? block.text : "",
      )
    : [];

describe("a Legacy server's URL-mode elicitation", () => {
  it("reaches onInput as a live question with the page, and the server gets the owner's accept", async () => {
    const server = legacyStatefulServer({ moreTools: [VISIT_TOOL] });
    const seen: Array<McpInputRequest> = [];

    const outcome = await visit(
      asking(server, (request) => {
        seen.push(request);

        return Effect.succeed(ACCEPT);
      }),
      { elicitationId: "e-7" },
    );

    expect(JSON.parse(textOf(outcome)[0] ?? "null")).toEqual({ action: "accept" });
    expect(seen).toEqual([
      {
        key: expect.any(String),
        kind: "elicitation",
        mode: "live",
        era: "legacy",
        params: { mode: "url", elicitationId: "e-7", ...PAGE },
      },
    ]);
  });

  it("tells the caller when the server says the owner finished, and keeps the call's clock stopped until then", async () => {
    const server = legacyStatefulServer({ moreTools: [VISIT_TOOL] });
    const finished: Array<string> = [];
    const seen: Array<McpInputRequest> = [];

    // The call's timeout is 150 ms and the owner takes 500 ms at the page: the call still ends well.
    const outcome = await visit(
      asking(
        server,
        (request) => {
          seen.push(request);

          return Effect.succeed(ACCEPT);
        },
        { onInputComplete: (key) => finished.push(key) },
      ),
      { completeAfterMs: 500 },
      ASKING,
      150,
    );

    expect(JSON.parse(textOf(outcome)[0] ?? "null")).toEqual({ action: "accept" });
    expect(finished).toEqual([seen[0]?.key]);
  });

  it("starts the call's clock again once the page is finished", async () => {
    const server = legacyStatefulServer({ moreTools: [VISIT_TOOL] });
    const finished: Array<string> = [];

    // Finished at 100 ms, then the server stays quiet for 600 ms: past the call's timeout of 150 ms.
    const outcome = await visit(
      asking(server, () => Effect.succeed(ACCEPT), {
        onInputComplete: (key) => finished.push(key),
      }),
      { completeAfterMs: 100, holdMs: 600 },
      ASKING,
      150,
    );

    expect(finished).toHaveLength(1);
    expect(Result.isFailure(outcome)).toBe(true);
  });

  it("withdraws the question when the bound passes with the page unfinished, and then the clock runs", async () => {
    const server = legacyStatefulServer({ moreTools: [VISIT_TOOL] });
    const ended: Array<string> = [];
    const finished: Array<string> = [];

    const outcome = await visit(
      asking(server, () => Effect.succeed(ACCEPT), {
        onInputEnded: (key) => ended.push(key),
        onInputComplete: (key) => finished.push(key),
      }),
      { holdMs: 700 },
      { ...ASKING, answers: { elicitation: true, inputWaitMs: 250 } },
      150,
    );

    expect(ended).toHaveLength(1);
    expect(finished).toEqual([]);
    expect(Result.isFailure(outcome)).toBe(true);
  });

  it("ignores a completion on the server's standalone stream", async () => {
    const server = legacyStatefulServer({ moreTools: [VISIT_TOOL] });
    const ended: Array<string> = [];
    const finished: Array<string> = [];

    await visit(
      asking(server, () => Effect.succeed(ACCEPT), {
        onInputEnded: (key) => ended.push(key),
        onInputComplete: (key) => finished.push(key),
      }),
      { completeAfterMs: 20, completeOnStandalone: true, holdMs: 400 },
      { ...ASKING, answers: { elicitation: true, inputWaitMs: 250 } },
      5000,
    );

    expect(finished).toEqual([]);
    expect(ended).toHaveLength(1);
  });

  it("is cancelled without asking when the call can answer nothing", async () => {
    const server = legacyStatefulServer({ moreTools: [VISIT_TOOL] });
    let asked = 0;

    const outcome = await visit(
      asking(server, () => {
        asked += 1;

        return Effect.succeed(ACCEPT);
      }),
      {},
      AGENT,
    );

    expect(asked).toBe(0);
    expect(JSON.parse(textOf(outcome)[0] ?? "null")).toEqual({ action: "cancel" });
  });
});

const gated = <A>(
  server: FakeServer,
  answer: (request: McpInputRequest) => Effect.Effect<McpInputAnswer>,
  use: (connection: McpConnection) => Effect.Effect<A, McpError>,
  deps: Partial<McpDeps> = {},
  name?: string,
) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(
        name === undefined ? TARGET : { ...TARGET, name },
        asking(server, answer, deps),
      );

      return yield* use(connection).pipe(Effect.result);
    }),
  );

const DEFER: McpInputAnswer = { kind: "defer" };

const tools = (server: FakeServer) =>
  server.received.filter((received) => received.rpc?.method === "tools/call");

const failureOf = <A>(result: Result.Result<A, McpError>) =>
  Result.isFailure(result) ? result.failure : undefined;

const textsOf = (value: CallToolResult) =>
  value.content.map((block) => (block.type === "text" ? block.text : ""));

describe("a Legacy server's -32042", () => {
  it("is kept for the owner as pages_required with a state that sends the call again, as it was", async () => {
    const gate = { times: 1, calls: 0, pages: 2 };
    const server = legacyStatefulServer({ moreTools: [GATED_TOOL], gate });
    const seen: Array<McpInputRequest> = [];

    const kept = await gated(
      server,
      (request) => {
        seen.push(request);

        return Effect.succeed(DEFER);
      },
      (connection) => connection.callTool({ tool: GATED_TOOL, arguments: { n: 1 } }, KEEPING),
    );

    expect(Result.isSuccess(kept) && kept.success.kind).toBe("pages_required");
    expect(seen.map((request) => [request.key, request.mode, request.params["mode"]])).toEqual([
      ["page-1", "deferrable", "url"],
      ["page-2", "deferrable", "url"],
    ]);
    expect(seen[0]?.params).toEqual({
      mode: "url",
      elicitationId: "page-1",
      url: "https://example.com/authorize",
      message: "Authorize first",
    });

    const state =
      Result.isSuccess(kept) && kept.success.kind === "pages_required" ? kept.success : undefined;

    expect(state?.requests.map((request) => request.key)).toEqual(["page-1", "page-2"]);

    const again = await gated(
      server,
      () => Effect.succeed(DEFER),
      (connection) =>
        connection.resend(
          state?.resend ?? null,
          { "page-1": { action: "accept" }, "page-2": { action: "accept" } },
          GATED_TOOL,
          KEEPING,
        ),
    );

    expect(Result.isSuccess(again) ? textsOf(completed(again.success).value) : []).toEqual([
      "opened",
    ]);

    // The call was sent twice, the second time as the first, with nothing added.
    const sent = tools(server);

    expect(gate.calls).toBe(2);
    expect(sent.map((each) => each.rpc?.params)).toEqual([
      expect.objectContaining({ name: "gated", arguments: { n: 1 } }),
      expect.objectContaining({ name: "gated", arguments: { n: 1 } }),
    ]);
    expect(sent[1]?.rpc?.params).toEqual(sent[0]?.rpc?.params);
  });

  it.each([["decline"], ["cancel"]] as const)(
    "ends the call with the server's own error when a page is answered %s, sending nothing",
    async (action) => {
      const gate = { times: 1, calls: 0, pages: 2 };
      const server = legacyStatefulServer({ moreTools: [GATED_TOOL], gate });

      const resumed = await gated(
        server,
        () => Effect.succeed(DEFER),
        (connection) =>
          Effect.gen(function* () {
            const first = yield* connection.callTool({ tool: GATED_TOOL }, KEEPING);

            return yield* connection.resend(
              first.kind === "pages_required" ? (first.resend ?? null) : null,
              { "page-1": { action: "accept" }, "page-2": { action } },
              GATED_TOOL,
              KEEPING,
            );
          }),
      );

      expect(failureOf(resumed)).toEqual(
        ServerError.make({ message: "Authorization needed", code: -32042 }),
      );
      expect(gate.calls).toBe(1);
    },
  );

  it("is the server's error when the caller keeps no pages, or a page is not kept", async () => {
    let asked = 0;

    // A caller from before pages (it defers, but sets no `pages`) is never answered the shape it cannot read.
    for (const ctx of [ASKING, DEFERRING]) {
      const without = await gated(
        legacyStatefulServer({ moreTools: [GATED_TOOL], gate: { times: 1, calls: 0 } }),
        () => {
          asked += 1;

          return Effect.succeed(DEFER);
        },
        (connection) => connection.callTool({ tool: GATED_TOOL }, ctx),
      );

      expect(failureOf(without)).toEqual(
        ServerError.make({ message: "Authorization needed", code: -32042 }),
      );
    }

    expect(asked).toBe(0);

    const declined = await gated(
      legacyStatefulServer({ moreTools: [GATED_TOOL], gate: { times: 1, calls: 0 } }),
      () => Effect.succeed({ kind: "answered" as const, result: { action: "decline" as const } }),
      (connection) => connection.callTool({ tool: GATED_TOOL }, KEEPING),
    );

    expect(failureOf(declined)).toEqual(
      ServerError.make({ message: "Authorization needed", code: -32042 }),
    );
  });

  it("stops at the eleventh -32042 with the server's error and says it kept asking", async () => {
    const gate = { times: 1000, calls: 0 };
    const server = legacyStatefulServer({ moreTools: [GATED_TOOL], gate });

    const outcome = await gated(
      server,
      () => Effect.succeed(DEFER),
      (connection) =>
        Effect.gen(function* () {
          let step = yield* connection.callTool({ tool: GATED_TOOL }, KEEPING);

          // Each resend is answered `-32042` again, until the eleventh attempt.
          for (let resends = 1; step.kind === "pages_required"; resends += 1) {
            expect(resends).toBeLessThanOrEqual(MCP_INPUT_ROUNDS);
            step = yield* connection.resend(
              step.resend ?? null,
              { "page-1": { action: "accept" } },
              GATED_TOOL,
              KEEPING,
            );
          }

          return step;
        }),
      {},
      "docs",
    );

    expect(failureOf(outcome)).toEqual(
      ServerError.make({
        message: "Authorization needed. docs kept asking for the same page; stopped after 10 tries",
        code: -32042,
      }),
    );
    // The call was sent once, and again after each of the ten Dones: eleven sends, never a twelfth.
    expect(gate.calls).toBe(11);
  });
});

describe("a ResendState and a ResumeState", () => {
  it("are each refused by the other's op, as a state the core cannot read", async () => {
    const server = legacyStatefulServer({
      moreTools: [GATED_TOOL],
      gate: { times: 1, calls: 0 },
    });

    const outcome = await gated(
      server,
      () => Effect.succeed(DEFER),
      (connection) =>
        Effect.gen(function* () {
          const first = yield* connection.callTool({ tool: GATED_TOOL }, KEEPING);
          const answers = { "page-1": { action: "accept" as const } };

          return {
            resumed: yield* Effect.result(
              connection.resume(
                first.kind === "pages_required" ? (first.resend ?? null) : null,
                answers,
                GATED_TOOL,
                KEEPING,
              ),
            ),
            resent: yield* Effect.result(
              connection.resend(
                {
                  v: 1,
                  method: "tools/call",
                  name: "gated",
                  arguments: {},
                  answered: {},
                  deferred: ["page-1"],
                  round: 1,
                },
                answers,
                GATED_TOOL,
                KEEPING,
              ),
            ),
          };
        }),
    );

    expect(Result.isSuccess(outcome) && failureOf(outcome.success.resumed)?._tag).toBe(
      "Unsupported",
    );
    expect(Result.isSuccess(outcome) && failureOf(outcome.success.resent)?._tag).toBe(
      "Unsupported",
    );
    expect(server.received.filter((r) => r.rpc?.method === "tools/call")).toHaveLength(1);
  });
});

describe("a Legacy server's -32042 on a read", () => {
  const NOTES = {
    uri: "file:///notes",
    name: "notes",
    contents: [{ uri: "file:///notes", text: "# Notes" }],
  };

  const read = (server: FakeServer, ctx: McpCallContext) =>
    gated(
      server,
      () => Effect.succeed(DEFER),
      (connection) => connection.readResource(NOTES.uri, ctx),
    );

  it("is kept for the owner as pages_required with no state: the caller sends the read again as it was", async () => {
    const gateReads = { times: 1, calls: 0 };
    const server = legacyStatefulServer({ resources: [NOTES], gateReads });
    const kept = await read(server, KEEPING);

    expect(
      Result.isSuccess(kept) && kept.success.kind === "pages_required"
        ? [kept.success.requests.map((each) => each.key), kept.success.message, kept.success.resend]
        : undefined,
    ).toEqual([["page-1"], "Authorization needed", undefined]);

    const again = await read(server, KEEPING);

    expect(Result.isSuccess(again) && again.success.kind).toBe("complete");
    expect(gateReads.calls).toBe(2);
  });

  it("is the server's error to a read whose caller keeps no pages", async () => {
    const server = legacyStatefulServer({
      resources: [NOTES],
      gateReads: { times: 1, calls: 0 },
    });

    expect(failureOf(await read(server, DEFERRING))).toEqual(
      ServerError.make({ message: "Authorization needed", code: -32042 }),
    );
  });
});
