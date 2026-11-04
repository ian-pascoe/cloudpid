/**
 * A server's question during a prompt send's `prompts/get` (`docs/architecture/mcp-server-requests.md` → Questions;
 * `docs/architecture/mcp-in-a-session.md` → Getting a prompt at send), in both eras: a Legacy server asks on the get's own
 * stream, with the get's timeout stopped while the owner decides; a Modern one answers `input_required`, and the core
 * answers the round at once through `onInput` and sends the get again, as a read's rounds are.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { OWNER, run, settled, TARGET, testDeps } from "./core.fixture.ts";
import {
  type FakePrompt,
  type FakeServer,
  fetchTo,
  legacyStatefulServer,
  modernServer,
} from "./fakes.fixture.ts";
import { connect, type McpDeps } from "./index.ts";
import type { McpCallContext, McpInputAnswer, McpInputRequest } from "./types.ts";

const FORM_PROMPT: FakePrompt = {
  name: "who",
  get: () => ({ messages: [] }),
  asks: { message: "Which team?" },
};

const SAMPLE_PROMPT: FakePrompt = {
  name: "summary",
  get: () => ({ messages: [] }),
  asks: { sample: "Summarize" },
};

/** A prompt send that can answer a form, kept for later by nobody (a send keeps nothing), for 5 min and a little more. */
const FORM: McpCallContext = {
  ...OWNER,
  answers: { elicitation: true, defer: true, inputWaitMs: 315_000 },
};

const SAMPLES: McpCallContext = { ...OWNER, answers: { sampling: true, inputWaitMs: 315_000 } };

const ACCEPTED: McpInputAnswer = {
  kind: "answered",
  result: { action: "accept", content: { team: "core" } },
};

const SAMPLED: McpInputAnswer = {
  kind: "sampled",
  result: { role: "assistant", content: { type: "text", text: "A summary" }, model: "small-1" },
};

/** What the connection declares: both kinds at a Legacy `initialize` (no call yet), what the call offers on a Modern request. */
type Offered = { elicitation?: { form: {} }; sampling?: { tools: {} } };

const declared = (ctx: McpCallContext | undefined) => {
  if (ctx === undefined) return { elicitation: { form: {} }, sampling: { tools: {} } };

  const offered: Offered = {};

  if (ctx.answers?.elicitation === true) offered.elicitation = { form: {} };

  if (ctx.answers?.sampling === true) offered.sampling = { tools: {} };

  return offered;
};

const deps = (
  server: FakeServer,
  answer: (request: McpInputRequest) => Effect.Effect<McpInputAnswer>,
  seen: Array<McpInputRequest> = [],
): McpDeps => ({
  ...testDeps(fetchTo(server)),
  capabilities: declared,
  onInput: (request) => Effect.tap(answer(request), () => Effect.sync(() => seen.push(request))),
});

const get = (
  prompt: FakePrompt,
  server: FakeServer,
  given: McpDeps,
  ctx: McpCallContext,
  timeoutMs?: number,
) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(
        timeoutMs === undefined ? TARGET : { ...TARGET, timeoutMs },
        given,
      );

      return yield* settled(connection.getPrompt(prompt.name, {}, ctx));
    }),
  );

/** The text of the prompt's one message: the server's question's answer as JSON. */
const answeredOf = (outcome: Awaited<ReturnType<typeof get>>): Schema.Json => {
  if (!("value" in outcome)) throw new Error(`Expected a prompt, got ${JSON.stringify(outcome)}`);

  const [message] = outcome.value.value.messages;
  const text = message?.content.type === "text" ? message.content.text : "";

  return JSON.parse(text);
};

const eras = [
  ["Legacy", legacyStatefulServer],
  ["Modern", modernServer],
] as const;

describe.each(eras)("a %s server's question during a prompt get", (_name, makeServer) => {
  it("is a form answered with what onInput gives, and the get completes", async () => {
    const server = makeServer({ prompts: [FORM_PROMPT] });
    const seen: Array<McpInputRequest> = [];

    const outcome = await get(
      FORM_PROMPT,
      server,
      deps(server, () => Effect.succeed(ACCEPTED), seen),
      FORM,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "elicitation", params: { message: "Which team?" } });
    expect(answeredOf(outcome)).toEqual(ACCEPTED.kind === "answered" ? ACCEPTED.result : null);
  });

  it("is cancelled when the owner's answer is a deferral: a get keeps nothing for later", async () => {
    const server = makeServer({ prompts: [FORM_PROMPT] });

    const outcome = await get(
      FORM_PROMPT,
      server,
      deps(server, () => Effect.succeed({ kind: "defer" })),
      FORM,
    );

    expect(answeredOf(outcome)).toEqual({ action: "cancel" });
  });

  it("is a Sampling request answered with the reply onInput gives", async () => {
    const server = makeServer({ prompts: [SAMPLE_PROMPT] });
    const seen: Array<McpInputRequest> = [];

    const outcome = await get(
      SAMPLE_PROMPT,
      server,
      deps(server, () => Effect.succeed(SAMPLED), seen),
      SAMPLES,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "sampling" });
    expect(answeredOf(outcome)).toMatchObject({ role: "assistant", model: "small-1" });
  });
});

describe("a Legacy server's question during a prompt get", () => {
  it("is cancelled, and the get goes on, for a send that offers no question", async () => {
    const server = legacyStatefulServer({ prompts: [FORM_PROMPT] });
    const seen: Array<McpInputRequest> = [];

    const outcome = await get(
      FORM_PROMPT,
      server,
      deps(server, () => Effect.succeed(ACCEPTED), seen),
      OWNER,
    );

    expect(seen).toEqual([]);
    expect(answeredOf(outcome)).toEqual({ action: "cancel" });
  });

  it("stops the get's timeout while it waits", async () => {
    const server = legacyStatefulServer({ prompts: [FORM_PROMPT] });

    // The get's timeout is 150 ms and the owner takes 500 ms: the get still completes.
    const outcome = await get(
      FORM_PROMPT,
      server,
      deps(server, () => Effect.sleep(500).pipe(Effect.as(ACCEPTED))),
      FORM,
      150,
    );

    expect(answeredOf(outcome)).toEqual(ACCEPTED.kind === "answered" ? ACCEPTED.result : null);
  });

  it("is cancelled once the send's wait ends, and the get goes on", async () => {
    const server = legacyStatefulServer({ prompts: [FORM_PROMPT] });

    const outcome = await get(
      FORM_PROMPT,
      server,
      deps(server, () => Effect.never),
      { ...FORM, answers: { elicitation: true, inputWaitMs: 80 } },
    );

    expect(answeredOf(outcome)).toEqual({ action: "cancel" });
  });
});

describe("a Modern server's question during a prompt get", () => {
  it("makes a get that is not cacheable, sent again with the server's state", async () => {
    const asked: Array<Schema.Json> = [];
    const server = modernServer({ prompts: [FORM_PROMPT], asked });

    const outcome = await get(
      FORM_PROMPT,
      server,
      deps(server, () => Effect.succeed(ACCEPTED)),
      FORM,
    );

    expect(asked).toEqual([
      {
        round: 1,
        state: "prompt-1",
        responses: { q1: ACCEPTED.kind === "answered" ? ACCEPTED.result : null },
      },
    ]);
    expect(outcome).toMatchObject({ value: { kind: "complete", cacheable: false } });
  });
});
