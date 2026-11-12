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
  McpHostTaskAck,
  McpHostTaskStarted,
  McpHostTaskState,
  ServerError,
} from "@cloudpid/mcp/types";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import type { Mutable } from "effect/Types";
import { describe, expect, it, vi } from "vite-plus/test";
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
import { followsTasks, type Exchange, type TaskOffer } from "./mcp/exchange.ts";
import { MCP_TASKS_PER_SERVER, MCP_TASKS_PER_SESSION } from "./mcp/task-state.ts";
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
  options: {
    readonly tasking?: boolean;
    readonly promptWaitMs?: number;
    readonly allowing?: boolean;
  } = {},
) => {
  const viewTools = [{ name: "go", _meta: { ui: { visibility: ["app"] } } }];

  const server =
    options.allowing === true
      ? { ...DOCS, entry: { sampling: "allow" }, tools: viewTools }
      : { ...DOCS, tools: viewTools };

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
  });

  return {
    host,
    tools,
    storage,
    questions,
    told,
    notes,
    stop,
    call,
    hide: () => {
      page.abort();
      page = new AbortController();
    },
    /** The View's answer; what the questions came to is kept in `notes`. */
    run: async (input: McpAppRequestInput) => {
      const reply = await Effect.runPromise(tools.appRequest(input));

      notes.push(...reply.notes);

      return reply.answer;
    },
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
          inputWaitMs: expect.any(Number),
        },
      },
    });
    expect(sent(host)[0]?.ctx.answers?.defer).toBeUndefined();
    // A live caller declares no `url` mode: only a prompt send's get waits at a page.
    expect(sent(host)[0]?.ctx.answers?.livePages).toBeUndefined();
    expect(sent(host)[0]?.ctx.answers?.pages).toBeUndefined();
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

    expect(card).toMatchObject({ app: true, server: DOCS.name, tool: "mcp__docs_site__go" });
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

  it("lets a Sampling request that needs no card run when the page is hidden", async () => {
    const { host, run, call, hide } = await setup({ allowing: true });
    let given: unknown;

    host.answer(async (_input, hooks) => {
      hide();
      given = await hooks.onInput?.(sampleAsk);

      return completed;
    });

    await run(call());

    expect(given).toMatchObject({ kind: "sampled" });
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

describe("an App View's place among the task caps", () => {
  const FIELDS = {
    taskId: "t1",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUpdatedAt: "2026-01-01T00:00:00.000Z",
    ttlMs: 60_000,
  };

  /** A server that answers every `tools/call` with a task that completes at its first poll. */
  const tasked = (host: Awaited<ReturnType<typeof setup>>["host"]) =>
    host.answer(async (input) => {
      if (input.op === "tools/call") {
        return McpHostTaskStarted.make({ task: { ...FIELDS, status: "working" }, conn: "c" });
      }

      return input.op === "tasks/get"
        ? McpHostTaskState.make({
            task: { ...FIELDS, status: "completed" },
            result: { kind: "inline", value: { content: [] } },
          })
        : McpHostTaskAck.make({});
    });

  /** The agent's live tasks as the Session's Harness would say. */
  const bindAgent = (tools: Awaited<ReturnType<typeof setup>>["tools"], servers: string[]) =>
    tools.bindNotices({
      check: () => Promise.resolve([]),
      conversations: () => Promise.resolve([]),
      taskServers: () => Promise.resolve(servers),
    });

  it("is given back when the call came to no task, so the ninth call to a server is offered one too", async () => {
    const { host, run, call, storage } = await setup({ tasking: true });

    host.answer(async () => completed);

    for (let each = 0; each < 9; each += 1) await run(call("go", `r${each}`));

    expect(sent(host).map((input) => input.ctx.allowTask)).toEqual(Array(9).fill(true));
    expect(storage.get("mcp-task:app")).toBeUndefined();
  });

  it("is given back when the task ends, and its entry for the sweep goes", async () => {
    const { host, run, call, storage } = await setup({ tasking: true });

    tasked(host);

    for (let each = 0; each < 9; each += 1) {
      expect(await run(call("go", `r${each}`))).toMatchObject({ status: "result" });
    }

    expect(sent(host).filter((input) => input.op === "tools/call")).toHaveLength(9);

    for (const input of sent(host).filter((each) => each.op === "tools/call")) {
      expect(input.ctx.allowTask).toBe(true);
    }

    expect(storage.get("mcp-task:app")).toBeUndefined();
  });

  it("is refused when the agent's live tasks fill the server's cap", async () => {
    const { host, run, call, tools } = await setup({ tasking: true });

    host.answer(async () => completed);
    bindAgent(tools, Array(MCP_TASKS_PER_SERVER - 1).fill(NAME));
    await run(call("go", "r1"));
    bindAgent(tools, Array(MCP_TASKS_PER_SERVER).fill(NAME));
    await run(call("go", "r2"));

    expect(sent(host).map((input) => input.ctx.allowTask)).toEqual([true, undefined]);
  });

  it("is refused when the agent's live tasks fill the Session's cap", async () => {
    const { host, run, call, tools } = await setup({ tasking: true });

    host.answer(async () => completed);
    bindAgent(tools, Array(MCP_TASKS_PER_SESSION).fill("other"));
    await run(call("go", "r1"));

    expect(sent(host)[0]?.ctx.allowTask).toBeUndefined();
  });

  it("makes the agent's offer fail once the Views hold the server's cap, and gives it back", async () => {
    const store = viewTaskStore(memory());
    const places = Array.from({ length: MCP_TASKS_PER_SERVER }, () => store.offer(NAME, []));

    const exchange = {
      subject: "tool",
      server: { name: NAME },
      tasking: { tasks: { views: store } },
    };

    const api = { snapshot: () => Promise.resolve(undefined) };

    // SAFETY: followsTasks reads only these fields of its three arguments.
    const offer = (): Promise<TaskOffer> =>
      followsTasks(
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: partial fakes; `followsTasks` reads only these members.
        exchange as unknown as Exchange,
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: as above.
        api as unknown as ToolExecutionApi,
        {} as Context,
      );

    expect(await offer()).toEqual({ allowed: false });

    places[0]?.release();

    const second = await offer();

    expect(second.allowed).toBe(true);
    // Its own place counts until it is given back: the next offer is over the cap again.
    expect(await offer()).toEqual({ allowed: false });
    second.place?.release();
    expect((await offer()).allowed).toBe(true);
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

    store.offer("docs", [])?.begin(entry);

    expect(store.orphans()).toEqual([]);
    expect(viewTaskStore(storage).orphans()).toEqual([entry]);

    store.end("a");
    expect(viewTaskStore(storage).orphans()).toEqual([]);
  });

  it("stops offering a task at the Session's or the server's cap, counting the agent's tasks and the places held", () => {
    const store = viewTaskStore(memory());
    const places = [];

    // Eight places held before any call has answered: the ninth is refused, so two calls never take the last one.
    for (let each = 0; each < 8; each += 1) places.push(store.offer("docs", []));

    expect(places.every((place) => place !== undefined)).toBe(true);
    expect(store.offer("docs", [])).toBeUndefined();
    expect(store.offer("other", [])).toBeDefined();
    expect(store.held()).toHaveLength(9);

    // A place given back (no task came) is free again.
    places[0]?.release();
    expect(store.offer("docs", [])).toBeDefined();
  });

  it("counts the agent's live tasks in the same caps", () => {
    const store = viewTaskStore(memory());

    expect(
      store.offer(
        "docs",
        Array.from({ length: 8 }, () => "docs"),
      ),
    ).toBeUndefined();
    expect(
      store.offer(
        "other",
        Array.from({ length: 8 }, () => "docs"),
      ),
    ).toBeDefined();
    expect(
      store.offer(
        "other",
        Array.from({ length: 16 }, () => "x"),
      ),
    ).toBeUndefined();
  });
});
