/**
 * A Legacy server's elicitation during a call (`docs/architecture/mcp-server-requests.md` → Questions; ADR-0037): the
 * core ties the question to the `tools/call` whose POST stream carried it, passes it to `onInput`, and answers the server
 * with what `onInput` gives (the owner's answer, decline or cancel, or the server's -32602 when the Session refuses the
 * form); a question that belongs to no such call, or that the call can answer nothing to, is cancelled.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "vitest";
import { AGENT, completed, run, TARGET, testDeps } from "./core.fixture.ts";
import { ASK_TOOL, type FakeServer, fetchTo, legacyStatefulServer } from "./fakes.fixture.ts";
import { connect, type McpDeps } from "./index.ts";
import type { McpCallContext, McpInputAnswer, McpInputRequest } from "./types.ts";

const FORM = {
  type: "object" as const,
  properties: { name: { type: "string" }, newsletter: { type: "boolean" } },
  required: ["name"],
};

const ASKING: McpCallContext = {
  ...AGENT,
  answers: { elicitation: true, inputWaitMs: 600_000 },
};

const ASKS_FORM = { form: {} };

/** Deps declaring `elicitation: { form: {} }`, answering each question with `answer`. */
const asking = (
  server: FakeServer,
  answer: (request: McpInputRequest) => Effect.Effect<McpInputAnswer>,
  more: Partial<McpDeps> = {},
): McpDeps => ({
  ...testDeps(fetchTo(server)),
  capabilities: () => ({ elicitation: ASKS_FORM }),
  onInput: answer,
  ...more,
});

const call = (deps: McpDeps, ctx: McpCallContext, timeoutMs?: number) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(
        timeoutMs === undefined ? TARGET : { ...TARGET, timeoutMs },
        deps,
      );

      return yield* connection
        .callTool(
          {
            tool: ASK_TOOL,
            arguments: { message: "Who are you?", requestedSchema: FORM },
          },
          ctx,
        )
        .pipe(Effect.result);
    }),
  );

const textOf = (outcome: Awaited<ReturnType<typeof call>>) =>
  Result.isSuccess(outcome)
    ? completed(outcome.success).value.content.map((block) =>
        block.type === "text" ? block.text : "",
      )
    : [];

describe("a Legacy server's elicitation", () => {
  it("is answered with what onInput gives, and carries the server's message and schema to it", async () => {
    const asked: Array<string> = [];
    const seen: Array<McpInputRequest> = [];
    const server = legacyStatefulServer({ moreTools: [ASK_TOOL], asked: [] });

    const outcome = await call(
      asking(server, (request) => {
        seen.push(request);

        return Effect.succeed({
          kind: "answered" as const,
          result: { action: "accept" as const, content: { name: "Ada" } },
        });
      }),
      ASKING,
    );

    asked.push(...textOf(outcome));

    expect(JSON.parse(asked[0] ?? "null")).toEqual({ action: "accept", content: { name: "Ada" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      kind: "elicitation",
      mode: "live",
      params: { message: "Who are you?", requestedSchema: FORM },
    });
  });

  it.each([
    ["declined", "decline"],
    ["cancelled", "cancel"],
  ] as const)("is %s when the owner says so", async (_name, action) => {
    const server = legacyStatefulServer({ moreTools: [ASK_TOOL] });

    const outcome = await call(
      asking(server, () => Effect.succeed({ kind: "answered" as const, result: { action } })),
      ASKING,
    );

    expect(JSON.parse(textOf(outcome)[0] ?? "null")).toEqual({ action });
  });

  it("is the server's -32602 when the Session refuses the form", async () => {
    const options = { listMore: true, asked: [] };
    const server = legacyStatefulServer(options);

    const outcome = await call(
      asking(server, () =>
        Effect.succeed({ kind: "refused" as const, message: "unsupported elicitation form: x" }),
      ),
      ASKING,
    );

    expect(textOf(outcome)[0]).toContain("unsupported elicitation form: x");
    expect(options.asked).toEqual([{ error: "unsupported elicitation form: x" }]);
  });

  it("is cancelled without asking when the server asks on its standalone stream, not the call's", async () => {
    const server = legacyStatefulServer({ moreTools: [ASK_TOOL] });
    let asked = 0;

    const outcome = await run(
      Effect.gen(function* () {
        const connection = yield* connect(
          TARGET,
          asking(server, () => {
            asked += 1;

            return Effect.succeed({
              kind: "answered" as const,
              result: { action: "accept" as const },
            });
          }),
        );

        return yield* connection
          .callTool(
            {
              tool: ASK_TOOL,
              arguments: { message: "Who?", requestedSchema: FORM, standalone: true },
            },
            ASKING,
          )
          .pipe(Effect.result);
      }),
    );

    expect(JSON.parse(textOf(outcome)[0] ?? "null")).toEqual({ action: "cancel" });
    expect(asked).toBe(0);
  });

  it("is cancelled without asking when the call can answer nothing", async () => {
    const server = legacyStatefulServer({ moreTools: [ASK_TOOL] });
    let asked = 0;

    const outcome = await call(
      asking(server, () => {
        asked += 1;

        return Effect.succeed({ kind: "answered" as const, result: { action: "accept" as const } });
      }),
      AGENT,
    );

    expect(JSON.parse(textOf(outcome)[0] ?? "null")).toEqual({ action: "cancel" });
    expect(asked).toBe(0);
  });
});
