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
import {
  type McpCallContext,
  type McpInputAnswer,
  type McpInputRequest,
  ServerError,
} from "./types.ts";

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
type Offered = { elicitation?: { form: {}; url?: {} }; sampling?: { tools: {} } };

const declared = (ctx: McpCallContext | undefined) => {
  if (ctx === undefined) return { elicitation: { form: {}, url: {} }, sampling: { tools: {} } };

  const offered: Offered = {};

  if (ctx.answers?.elicitation === true) {
    offered.elicitation = ctx.answers.livePages === true ? { form: {}, url: {} } : { form: {} };
  }

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

/** A send that waits at a page, live: no resume, for 5 min and a little more. */
const PAGES: McpCallContext = {
  ...OWNER,
  answers: { elicitation: true, livePages: true, inputWaitMs: 315_000 },
};

const PAGE = "https://login.example.com/authorize?state=1";

const PAGE_PROMPT = (again?: number): FakePrompt => ({
  name: "visit",
  get: () => ({ messages: [] }),
  asks: again === undefined ? { url: PAGE } : { url: PAGE, again },
});

/** The owner was done at the page. */
const DONE: McpInputAnswer = { kind: "answered", result: { action: "accept" } };

describe("a Modern server's page during a prompt get", () => {
  it("is answered live once the owner is done there, and the get goes on", async () => {
    const asked: Array<Schema.Json> = [];
    const server = modernServer({ prompts: [PAGE_PROMPT()], asked });
    const seen: Array<McpInputRequest> = [];

    const outcome = await get(
      PAGE_PROMPT(),
      server,
      deps(server, () => Effect.succeed(DONE), seen),
      PAGES,
    );

    expect(seen).toMatchObject([
      {
        kind: "elicitation",
        mode: "deferrable",
        era: "modern",
        params: { mode: "url", url: PAGE },
      },
    ]);
    expect(asked).toMatchObject([{ round: 1, responses: { q1: { action: "accept" } } }]);
    expect(answeredOf(outcome)).toEqual({ action: "accept" });
  });

  it("asks again when the server finds the owner was not done, then goes on", async () => {
    const server = modernServer({ prompts: [PAGE_PROMPT(1)], asked: [] });
    const seen: Array<McpInputRequest> = [];

    const outcome = await get(
      PAGE_PROMPT(1),
      server,
      deps(server, () => Effect.succeed(DONE), seen),
      PAGES,
    );

    // The same question, key and address, twice: the Session reads the second as "Not finished".
    expect(seen.map((request) => request.key)).toEqual(["q1", "q1"]);
    expect(answeredOf(outcome)).toEqual({ action: "accept" });
  });

  it("asks a round of several pages one after the other, each answered by its own owner's word", async () => {
    const asked: Array<Schema.Json> = [];
    const prompt: FakePrompt = { ...PAGE_PROMPT(), asks: { url: PAGE, pages: 2 } };
    const server = modernServer({ prompts: [prompt], asked });
    const seen: Array<McpInputRequest> = [];

    // The first page is declined, and the second is not left waiting: the server is answered both, in one go.
    const outcome = await get(
      prompt,
      server,
      deps(
        server,
        (request) =>
          Effect.succeed(
            request.key === "q1" ? { kind: "answered", result: { action: "decline" } } : DONE,
          ),
        seen,
      ),
      PAGES,
    );

    expect(seen.map((request) => request.key)).toEqual(["q1", "q2"]);
    expect(asked).toMatchObject([
      { round: 1, responses: { q1: { action: "decline" }, q2: { action: "accept" } } },
    ]);
    expect(outcome).toHaveProperty("value");
  });

  it("is a decline or cancel of that page only: the get goes on", async () => {
    const server = modernServer({ prompts: [PAGE_PROMPT()] });

    const outcome = await get(
      PAGE_PROMPT(),
      server,
      deps(server, () => Effect.succeed({ kind: "answered", result: { action: "cancel" } })),
      PAGES,
    );

    expect(answeredOf(outcome)).toEqual({ action: "cancel" });
  });
});

describe("a Legacy server's -32042 during a prompt get", () => {
  const VISIT: FakePrompt = {
    name: "visit",
    get: () => ({ messages: [{ role: "assistant", content: { type: "text", text: '"opened"' } }] }),
  };

  const gated = (
    times: number,
    answer: (request: McpInputRequest) => Effect.Effect<McpInputAnswer> = () =>
      Effect.succeed(DONE),
    ctx: McpCallContext = PAGES,
    pages = 1,
  ) => {
    const gatePrompts = { times, calls: 0, pages, url: PAGE };
    const server = legacyStatefulServer({ prompts: [VISIT], gatePrompts });
    const seen: Array<McpInputRequest> = [];
    const ended: Array<string> = [];

    return {
      gatePrompts,
      seen,
      ended,
      outcome: get(
        VISIT,
        server,
        { ...deps(server, answer, seen), onInputEnded: (key) => ended.push(key) },
        ctx,
      ),
    };
  };

  it("waits for the owner at the page, then sends the get again once, which completes", async () => {
    const { gatePrompts, seen, outcome } = gated(1);

    expect(answeredOf(await outcome)).toEqual("opened");
    expect(seen).toMatchObject([
      { kind: "elicitation", key: "page-1", mode: "deferrable", era: "legacy" },
    ]);
    expect(gatePrompts.calls).toBe(2);
  });

  it("asks again when the resend is a -32042 for the same page, and sends the get again", async () => {
    const { gatePrompts, seen, outcome } = gated(2);

    expect(answeredOf(await outcome)).toEqual("opened");
    expect(seen.map((request) => request.key)).toEqual(["page-1", "page-1"]);
    expect(gatePrompts.calls).toBe(3);
  });

  it("ends with the server's error when the owner declines or cancels, with nothing sent again", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const { gatePrompts, outcome } = gated(1, () =>
        Effect.succeed({ kind: "answered", result: { action } }),
      );

      expect(await outcome).toMatchObject({
        failed: ServerError.make({ message: "Authorization needed", code: -32042 }),
      });
      expect(gatePrompts.calls).toBe(1);
    }
  });

  it("settles a round of two pages at once when either is declined or cancelled, withdrawing the other's card", async () => {
    for (const action of ["decline", "cancel"] as const) {
      // Page 1 answers a moment after both cards are up; page 2's owner never does (its card is the one to withdraw).
      const { gatePrompts, ended, outcome } = gated(
        1,
        (request) =>
          request.key === "page-1"
            ? Effect.sleep(20).pipe(Effect.as({ kind: "answered", result: { action } }))
            : Effect.never,
        PAGES,
        2,
      );

      expect(await outcome).toMatchObject({
        failed: ServerError.make({ message: "Authorization needed", code: -32042 }),
      });
      expect(ended).toEqual(["page-2"]);
      expect(gatePrompts.calls).toBe(1);
    }
  });

  it("sends the get again once when every page of a round is done", async () => {
    const { gatePrompts, seen, ended, outcome } = gated(1, () => Effect.succeed(DONE), PAGES, 2);

    expect(answeredOf(await outcome)).toEqual("opened");
    expect(seen.map((request) => request.key).toSorted()).toEqual(["page-1", "page-2"]);
    expect(ended).toEqual([]);
    expect(gatePrompts.calls).toBe(2);
  });

  it("is the server's error to a send that does not wait at pages", async () => {
    const { gatePrompts, seen, outcome } = gated(1, () => Effect.succeed(DONE), FORM);

    expect(await outcome).toMatchObject({
      failed: ServerError.make({ message: "Authorization needed", code: -32042 }),
    });
    expect(seen).toEqual([]);
    expect(gatePrompts.calls).toBe(1);
  });

  it("stops at the 11th -32042: the server kept asking for the same page", async () => {
    const { gatePrompts, seen, outcome } = gated(1000);

    expect(await outcome).toMatchObject({
      failed: ServerError.make({
        message:
          "Authorization needed. The server kept asking for the same page; stopped after 10 tries",
        code: -32042,
      }),
    });
    expect(seen).toHaveLength(10);
    expect(gatePrompts.calls).toBe(11);
  });
});
