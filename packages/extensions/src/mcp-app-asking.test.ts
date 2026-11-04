// What an App View's `tools/call` does with the questions and MCP tasks its server offers (`docs/architecture/mcp-apps.md` →
// Server requests from an App View's calls): the request says it can answer a form and a Sampling request live, a form waits
// on a card that names the app for 5 minutes and tells nobody, the View's one elicitation slot turns a second away, a hidden
// page withdraws a Sampling card and not a form, and a task is offered only with the Session's task store.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off missingPipeableSignature:off
import {
  type JsonObject,
  MCP_HOST_FEATURES,
  MCP_PROMPT_QUESTION_WAIT_MS,
  McpHostCallFailed,
  McpHostCompleted,
  ServerError,
} from "@cloudpid/mcp/types";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import type { Mutable } from "effect/Types";
import { describe, expect, it, vi } from "vitest";
import { build, DOCS, startOf } from "./mcp.fixture.ts";
import {
  makeMcpTools,
  type McpAppRequestInput,
  type McpAppView,
  type McpToolOptions,
} from "./mcp.ts";
import { fakeMcpHost } from "./mcp.testing.ts";
import { createMcpQuestions } from "./mcp/questions.ts";
import { createMcpSampling } from "./mcp/sampling.ts";
import { viewTaskStore } from "./mcp/task-view-store.ts";

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

const FORM: JsonObject = { type: "object", properties: { team: { type: "string" } } };

const formAsk = (key = "7") => ({
  key,
  kind: "elicitation" as const,
  params: { message: "Which team?", requestedSchema: FORM },
  mode: "live" as const,
});

const sampleAsk = {
  key: "9",
  kind: "sampling" as const,
  params: {
    messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
    maxTokens: 100,
  },
  mode: "live" as const,
  era: "legacy" as const,
};

const NAME = "Docs-Site";

const completed = McpHostCompleted.make({
  result: { kind: "inline", value: { content: [] } },
});

const setup = async (
  options: { readonly tasking?: boolean; readonly promptWaitMs?: number } = {},
) => {
  const server = { ...DOCS, tools: [{ name: "go", _meta: { ui: { visibility: ["app"] } } }] };
  const host = fakeMcpHost([server]);
  const storage = memory();
  const told: string[] = [];

  host.features(MCP_HOST_FEATURES);

  const questions = createMcpQuestions({
    storage,
    announce: () => Effect.void,
    announceSampling: () => Effect.void,
    notify: ({ server: name }) =>
      Effect.sync(() => {
        told.push(name);
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
    overLimit: () => Promise.resolve(undefined),
    usage: () => undefined,
  });

  const toolOptions: Mutable<McpToolOptions> = { slackMs: 0, questions, sampling };

  if (options.tasking === true) toolOptions.tasks = { storage, timing: {} };

  const tools = makeMcpTools(host.client, undefined, toolOptions);

  await build(tools, startOf(1));

  /** The page is visible until `hide` aborts it. */
  let page = new AbortController();
  let waiting = false;

  const view: McpAppView = {
    hidden: () => page.signal,
    takeSlot: () => {
      if (waiting) return undefined;

      waiting = true;

      return () => {
        waiting = false;
      };
    },
  };

  const stop = new AbortController();
  const notes: string[] = [];

  const call = (name = "go", requestId = "r1"): McpAppRequestInput => ({
    method: "tools/call",
    name,
    arguments: {},
    server: NAME,
    callId: `c-${requestId}`,
    conversation: "1",
    signal: stop.signal,
    view,
    notes,
  });

  return {
    host,
    tools,
    questions,
    told,
    notes,
    stop,
    call,
    hide: () => {
      page.abort();
      page = new AbortController();
    },
    run: (input: McpAppRequestInput) => Effect.runPromise(tools.appRequest(input)),
  };
};

const sent = (host: Awaited<ReturnType<typeof setup>>["host"]) =>
  host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

const pending = (questions: Awaited<ReturnType<typeof setup>>["questions"]) =>
  Effect.runPromise(questions.pending);

describe("an App View's tools/call", () => {
  it("says it can answer a form and a Sampling request live, keeps nothing for later, and offers no task without the Session's store", async () => {
    const { host, run, call } = await setup();

    host.answer(async () => completed);

    await run(call());

    expect(sent(host)[0]).toMatchObject({
      ctx: {
        origin: "app",
        answers: {
          elicitation: true,
          sampling: true,
          livePages: true,
          inputWaitMs: expect.any(Number),
        },
      },
    });
    expect(sent(host)[0]?.ctx.answers?.defer).toBeUndefined();
    expect(sent(host)[0]?.ctx.allowTask).toBeUndefined();
    expect(sent(host)[0]?.ctx.answers?.inputWaitMs).toBeGreaterThan(MCP_PROMPT_QUESTION_WAIT_MS);
  });

  it("is offered an MCP task when the Session follows them, and a read never is", async () => {
    const { host, run, call, tools } = await setup({ tasking: true });

    host.answer(async () => completed);

    await run(call());
    await Effect.runPromise(
      tools.appRequest({
        method: "resources/read",
        uri: "ui://docs/page",
        server: NAME,
        callId: "c-r",
        conversation: "1",
        signal: new AbortController().signal,
      }),
    );

    expect(sent(host)[0]?.ctx.allowTask).toBe(true);
    expect(sent(host)[1]?.ctx.allowTask).toBeUndefined();
    expect(sent(host)[1]?.ctx.answers).toBeUndefined();
  });

  it("waits a form on a card that names the app, with nobody told, and the answer goes to the server", async () => {
    const { host, run, call, questions, told, notes } = await setup();
    let given: unknown;

    host.answer(async (_input, hooks) => {
      given = await hooks.onInput?.(formAsk());

      return completed;
    });

    const calling = run(call());

    await vi.waitFor(async () => expect(await pending(questions)).toHaveLength(1));

    const [card] = await pending(questions);

    expect(card).toMatchObject({ app: true, server: DOCS.name, tool: "mcp__Docs-Site__go" });
    expect(card?.prompt).toBeUndefined();
    expect(card?.waits).toBeUndefined();

    await Effect.runPromise(
      questions.answer(card?.id ?? "", { action: "accept", content: { team: "core" } }),
    );
    await calling;

    expect(given).toEqual({
      kind: "answered",
      result: { action: "accept", content: { team: "core" } },
    });
    expect(told).toEqual([]);
    expect(notes).toEqual(["form answered"]);
  });

  it("cancels a second form while one waits for the View, and says so in its notes", async () => {
    const { host, run, call, questions, notes } = await setup();
    const answers: unknown[] = [];

    host.answer(async (_input, hooks) => {
      answers.push(await hooks.onInput?.(formAsk(`k${answers.length}`)));

      return completed;
    });

    const first = run(call("go", "r1"));

    await vi.waitFor(async () => expect(await pending(questions)).toHaveLength(1));

    await run(call("go", "r2"));

    expect(answers).toEqual([{ kind: "answered", result: { action: "cancel" } }]);
    expect(await pending(questions)).toHaveLength(1);
    expect(notes.join("\n")).toContain("already has one waiting");

    const [card] = await pending(questions);

    await Effect.runPromise(questions.answer(card?.id ?? "", { action: "decline" }));
    await first;
  });

  it("withdraws a Sampling card when the page is hidden, and leaves a form", async () => {
    const { host, run, call, questions, hide } = await setup();
    const answers: unknown[] = [];

    host.answer(async (_input, hooks) => {
      const form = hooks.onInput?.(formAsk());
      const sample = hooks.onInput?.(sampleAsk);

      answers.push(await sample);
      answers.push(await form);

      return completed;
    });

    const calling = run(call());

    await vi.waitFor(async () => {
      expect(await pending(questions)).toHaveLength(1);
      expect(await Effect.runPromise(questions.pendingSampling)).toHaveLength(1);
    });

    hide();

    await vi.waitFor(async () =>
      expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]),
    );
    expect(await pending(questions)).toHaveLength(1);
    await vi.waitFor(() => expect(answers[0]).toMatchObject({ kind: "refused" }));

    const [card] = await pending(questions);

    await Effect.runPromise(questions.answer(card?.id ?? "", { action: "decline" }));
    await calling;
  });

  it("withdraws every card when the View is torn down, and answers cancelled", async () => {
    const { host, run, call, questions, stop } = await setup();

    host.answer(async (_input, hooks) => {
      void hooks.onInput?.(formAsk());
      void hooks.onInput?.(sampleAsk);

      return new Promise<never>(() => undefined);
    });

    const calling = run(call());

    await vi.waitFor(async () => expect(await pending(questions)).toHaveLength(1));
    stop.abort();

    expect(await calling).toMatchObject({ status: "error", reason: "cancelled" });
    expect(await pending(questions)).toEqual([]);
    expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]);
  });

  it("answers a Modern server's refused Sampling request as an error that ends the call", async () => {
    const { host, run, call } = await setup();

    host.answer(async (_input, hooks) => {
      // The owner's Session refuses at once: no model is available for the Role the card offers.
      await hooks.onInput?.({ ...sampleAsk, params: { messages: [] }, era: "modern" as const });

      return McpHostCallFailed.make({
        error: ServerError.make({ message: "unsupported", code: -32_603 }),
      });
    });

    expect(await run(call())).toMatchObject({ status: "error", reason: "refused" });
  });
});

describe("the View tasks' store", () => {
  it("holds an entry while the task's request is in flight, which another instance's sweep would cancel", () => {
    const storage = memory();
    const store = viewTaskStore(storage);

    const entry = {
      id: "a",
      server: "docs",
      tool: "t",
      taskId: "x",
      conn: "c",
      callId: "1",
      conversation: "1",
    };

    store.begin(entry);

    expect(store.orphans()).toEqual([]);
    expect(viewTaskStore(storage).orphans()).toEqual([entry]);

    store.end("a");
    expect(viewTaskStore(storage).orphans()).toEqual([]);
  });

  it("stops offering a task at the Session's or the server's cap", () => {
    const store = viewTaskStore(memory());

    for (let each = 0; each < 8; each += 1) {
      store.begin({
        id: `${each}`,
        server: "docs",
        tool: "t",
        taskId: "x",
        conn: "c",
        callId: "1",
        conversation: "1",
      });
    }

    expect(store.offers("docs")).toBe(false);
    expect(store.offers("other")).toBe(true);
  });
});
