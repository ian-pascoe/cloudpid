// The questions a server asks during a prompt send's `prompts/get` (`docs/architecture/mcp-server-requests.md` → Questions,
// Sampling requests; `docs/architecture/mcp-in-a-session.md` → Getting a prompt at send): a form or a Sampling request
// waits live on a card that names the prompt, in both eras, tells the owner nothing, stops the get's clock while it waits,
// and ends in `cancel` (or a refusal) after its own 5 min; Stop withdraws the card.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import {
  type JsonObject,
  MCP_HOST_FEATURES,
  MCP_PROMPT_QUESTION_WAIT_MS,
} from "@cloudpid/mcp/types";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import type { Mutable } from "effect/Types";
import { describe, expect, it, vi } from "vitest";
import { build, DOCS, startOf } from "./mcp.fixture.ts";
import { makeMcpTools, MCP_SAMPLING_FEATURE, type McpToolOptions, type PromptAsk } from "./mcp.ts";
import { fakeMcpHost } from "./mcp.testing.ts";
import { createMcpQuestions } from "./mcp/questions.ts";
import { createMcpSampling } from "./mcp/sampling.ts";

const memory = () => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the questions and the sampler read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      map.set(key, structuredClone(value));
    },
    delete: (key: string) => map.delete(key),
  };
};

const FORM: JsonObject = {
  type: "object",
  properties: { team: { type: "string", title: "Team" } },
  required: ["team"],
};

const formAsk = (mode: "live" | "deferrable" = "live") => ({
  key: "7",
  kind: "elicitation" as const,
  params: { message: "Which team?", requestedSchema: FORM },
  mode,
});

const sampleAsk = (era: "legacy" | "modern" = "legacy") => ({
  key: "9",
  kind: "sampling" as const,
  params: {
    messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
    maxTokens: 100,
  },
  mode: era === "modern" ? ("deferrable" as const) : ("live" as const),
  era,
});

/** Servers that may sample (`allow`, `ask`) and one that may not (`off`). */
const ASKING = { ...DOCS, entry: { sampling: "ask" } };
const ALLOWING = { ...DOCS, entry: { sampling: "allow" } };
const OFF = { ...DOCS, entry: { sampling: "off" } };

const setup = async (
  options: {
    readonly server?: typeof DOCS;
    readonly features?: ReadonlyArray<string>;
    readonly promptWaitMs?: number;
    readonly sampler?: boolean;
    readonly questions?: boolean;
    readonly over?: string;
  } = {},
) => {
  const host = fakeMcpHost([options.server ?? ASKING]);
  const storage = memory();
  const told: string[] = [];

  host.features(options.features ?? MCP_HOST_FEATURES);

  const questions = createMcpQuestions({
    storage,
    announce: () => Effect.void,
    announceSampling: () => Effect.void,
    notify: ({ server }) =>
      Effect.sync(() => {
        told.push(server);
      }),
    redact: Effect.succeed,
    holdsSecret: () => Effect.succeed(false),
    promptWaitMs: options.promptWaitMs,
  });

  const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-haiku-5-5" }] });
  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("a summary")]);

  const sampling = createMcpSampling({ storage, redact: Effect.succeed, questions });

  sampling.bind({
    models,
    roles: () => ({ small: { provider: "anthropic", modelId: "claude-haiku-5-5" } }),
    overLimit: () => Promise.resolve(options.over),
    usage: () => undefined,
  });

  const toolOptions: Mutable<McpToolOptions> = { slackMs: 0 };

  if (options.questions !== false) toolOptions.questions = questions;

  if (options.sampler !== false) toolOptions.sampling = sampling;

  const tools = makeMcpTools(host.client, undefined, toolOptions);

  await build(tools, startOf(1));

  /** The clock's stops and starts, in order. */
  const clock: string[] = [];
  const controller = new AbortController();

  const ask = (over: Partial<PromptAsk> = {}): PromptAsk => ({
    server: DOCS.name,
    callId: "prompt-1",
    command: "/mcp__Docs-Site__review",
    title: "Review PR",
    conversationId: ROOT_CONVERSATION_ID,
    signal: controller.signal,
    hold: {
      pause: Effect.sync(() => {
        clock.push("pause");
      }),
      resume: Effect.sync(() => {
        clock.push("resume");
      }),
    },
    ...over,
  });

  return { tools, questions, sampling, told, clock, controller, ask };
};

describe("the hooks of a prompt send's get", () => {
  it("say the get can answer a form, live, and offer nothing to keep for later", async () => {
    const { tools, ask } = await setup({ server: OFF });

    const asking = tools.promptAsking(ask());

    expect(asking?.answers).toEqual({
      elicitation: true,
      inputWaitMs: MCP_PROMPT_QUESTION_WAIT_MS + 15_000,
    });
  });

  it("add Sampling for a server that may sample, on a host that lists it", async () => {
    const { tools, ask } = await setup();

    expect(tools.promptAsking(ask())?.answers).toMatchObject({ elicitation: true, sampling: true });
    expect(tools.promptAsking(ask())?.answers.defer).toBeUndefined();

    const bare = await setup({
      features: MCP_HOST_FEATURES.filter((f) => f !== MCP_SAMPLING_FEATURE),
    });

    expect(bare.tools.promptAsking(bare.ask())?.answers.sampling).toBeUndefined();
  });

  it("are none for a server the tools were not built from, and for a Session with no questions", async () => {
    const { tools, ask } = await setup();
    const bare = await setup({ questions: false });

    expect(tools.promptAsking(ask({ server: "nowhere" }))).toBeUndefined();
    expect(bare.tools.promptAsking(bare.ask())).toBeUndefined();
  });
});

describe.each([
  ["Legacy", "live"],
  ["Modern", "deferrable"],
] as const)("a %s server's form during a get", (_era, mode) => {
  it("waits live on a card that names the prompt, with the clock stopped and nobody told, and is answered", async () => {
    const { tools, questions, told, clock, ask } = await setup();
    const asking = tools.promptAsking(ask());

    const answered = asking?.hooks.onInput?.(formAsk(mode));

    await vi.waitFor(async () => {
      expect(await Effect.runPromise(questions.pending)).toHaveLength(1);
    });

    const [card] = await Effect.runPromise(questions.pending);

    expect(card).toMatchObject({
      prompt: "Review PR",
      tool: "/mcp__Docs-Site__review",
      callId: "prompt-1",
      server: DOCS.name,
    });
    expect(card?.waits).toBeUndefined();
    expect(clock).toEqual(["pause"]);

    await Effect.runPromise(
      questions.answer(card?.id ?? "", { action: "accept", content: { team: "core" } }),
    );

    expect(await answered).toEqual({
      kind: "answered",
      result: { action: "accept", content: { team: "core" } },
    });
    expect(clock).toEqual(["pause", "resume"]);
    expect(told).toEqual([]);
  });

  it("is cancelled when the owner has not answered after its own wait, and the get goes on", async () => {
    const { tools, questions, clock, ask } = await setup({ promptWaitMs: 40 });

    const answered = await tools.promptAsking(ask())?.hooks.onInput?.(formAsk(mode));

    expect(answered).toEqual({ kind: "answered", result: { action: "cancel" } });
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(clock).toEqual(["pause", "resume"]);
  });

  it("is withdrawn with its card when Stop aborts the send", async () => {
    const { tools, questions, controller, ask } = await setup();

    const answered = tools.promptAsking(ask())?.hooks.onInput?.(formAsk(mode));

    await vi.waitFor(async () => {
      expect(await Effect.runPromise(questions.pending)).toHaveLength(1);
    });

    controller.abort();

    expect(await answered).toEqual({ kind: "answered", result: { action: "cancel" } });
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
  });

  it("is withdrawn when the get ends with the card still up", async () => {
    const { tools, questions, ask } = await setup();
    const asking = tools.promptAsking(ask());

    void asking?.hooks.onInput?.(formAsk(mode));

    await vi.waitFor(async () => {
      expect(await Effect.runPromise(questions.pending)).toHaveLength(1);
    });

    await asking?.settle();

    expect(await Effect.runPromise(questions.pending)).toEqual([]);
  });
});

describe("a server's Sampling request during a get", () => {
  it("waits live on a card that names the prompt, tells nobody, and runs once the owner allows it", async () => {
    const { tools, questions, told, clock, ask } = await setup();
    const asking = tools.promptAsking(ask());

    const answered = asking?.hooks.onInput?.(sampleAsk());

    await vi.waitFor(async () => {
      expect(await Effect.runPromise(questions.pendingSampling)).toHaveLength(1);
    });

    const [card] = await Effect.runPromise(questions.pendingSampling);

    expect(card).toMatchObject({ prompt: "Review PR", tool: "/mcp__Docs-Site__review" });
    expect(card?.waits).toBeUndefined();
    expect(told).toEqual([]);

    await Effect.runPromise(questions.answerSampling(card?.id ?? "", { choice: "allow_call" }));

    expect(await answered).toMatchObject({ kind: "sampled", result: { role: "assistant" } });
    // The clock stood still for the card and for the sample after it, and is running again at the end.
    expect(clock.filter((each) => each === "pause")).toHaveLength(
      clock.filter((each) => each === "resume").length,
    );
    expect(clock.at(-1)).toBe("resume");
  });

  it("is refused after its own wait, and a Modern server's refusal ends the send in words that name no content", async () => {
    const { tools, ask } = await setup({ promptWaitMs: 40 });
    const asking = tools.promptAsking(ask());

    const answered = await asking?.hooks.onInput?.(sampleAsk("modern"));

    expect(answered).toMatchObject({ kind: "refused" });
    expect(asking?.sunk()).toMatch(/^Docs-Site asked for a model reply, which was refused: /);
  });

  it("is run with no card for a server whose definition says allow", async () => {
    const { tools, questions, ask } = await setup({ server: ALLOWING });

    const answered = await tools.promptAsking(ask())?.hooks.onInput?.(sampleAsk());

    expect(answered).toMatchObject({ kind: "sampled" });
    expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]);
  });

  it("is withdrawn with its card when Stop aborts the send", async () => {
    const { tools, questions, controller, ask } = await setup();

    const answered = tools.promptAsking(ask())?.hooks.onInput?.(sampleAsk());

    await vi.waitFor(async () => {
      expect(await Effect.runPromise(questions.pendingSampling)).toHaveLength(1);
    });

    controller.abort();

    expect(await answered).toMatchObject({ kind: "refused" });
    expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]);
  });
});
