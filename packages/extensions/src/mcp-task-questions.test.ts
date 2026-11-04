// The questions an MCP task asks the owner (`docs/architecture/mcp-server-requests.md` → MCP tasks, Questions in a task):
// a task whose status is `input_required` lists its questions in `tasks/get`; each is kept for the owner under the task's
// key, shown in the task's conversation with no call waiting, and answered through `tasks/update`, sent by the owner's
// own answer once the round is complete. A key whose answer was sent is never asked again; a credential form is declined
// unseen and a request past the caps is cancelled, both in the same update; a request cloudpid did not offer ends the
// task. A scripted model on a Harness, over an in-memory host and the Session's question service.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off missingPipeableSignature:off preferEffectRecord:off strictEffectProvide:off
import {
  type JsonObject,
  McpHostCallFailed,
  McpHostTaskAck,
  type McpTaskSnapshot,
  ServerError,
} from "@cloudpid/mcp/types";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { createMcpSampling } from "./mcp/sampling.ts";
import type { McpTasksTiming } from "./mcp/task-port.ts";
import { observeQuestions, type TaskStore, taskStoreOf } from "./mcp/task-questions.ts";
import {
  McpTasksDoc,
  type McpTaskRecord,
  type McpTasksState,
  shownStatusMessage,
} from "./mcp/task-state.ts";
import {
  createMcpQuestions,
  MCP_QUESTION_RENOTIFY_MS,
  McpRoundState,
  type McpQuestionStorage,
} from "./mcp/questions.ts";
import { openKeptVault } from "./secrets/vault.ts";
import {
  CREATED,
  ended,
  memory,
  recordNow,
  type Script,
  scripted,
  setup,
  type SetupOptions,
  TIMING,
  toldOfEnd,
  turn,
} from "./mcp-tasks.fixture.ts";
import { MCP_TASK_ENDED_KIND } from "./mcp.ts";
import { call, context } from "./subagents/harness.fixture.ts";

const FORM: JsonObject = {
  method: "elicitation/create",
  params: {
    message: "Which region?",
    requestedSchema: {
      type: "object",
      properties: { region: { type: "string", title: "Region", enum: ["eu", "us"] } },
      required: ["region"],
    },
  },
};

const CREDENTIAL: JsonObject = {
  method: "elicitation/create",
  params: {
    message: "Token?",
    requestedSchema: {
      type: "object",
      properties: { api_token: { type: "string", title: "API token" } },
      required: ["api_token"],
    },
  },
};

const PAGE: JsonObject = {
  method: "elicitation/create",
  params: { mode: "url", message: "Sign in there", url: "https://login.example.com/start" },
};

/** The Session's questions over a storage that also lets a test read what it holds. */
const questionsOf = async () => {
  const kept = await Effect.runPromise(
    openKeptVault("test-master-key-0123456789abcdef0123456789", "mcp-elicitation"),
  );

  const store = memory();
  const told: string[] = [];

  const make = () =>
    createMcpQuestions({
      storage: store satisfies McpQuestionStorage,
      announce: () => Effect.void,
      notify: ({ server }) =>
        Effect.sync(() => {
          told.push(server);
        }),
      redact: (shown) => Effect.succeed(shown),
      holdsSecret: (text) => Effect.succeed(text === "my-secret"),
      vault: {
        seal: (id, text) => kept.seal({ owner: "s1", name: id }, text),
        open: (id, sealed) => kept.open({ owner: "s1", name: id }, sealed),
      },
    });

  return { questions: make(), make, store, told };
};

const until = async (check: () => Promise<boolean> | boolean) => {
  const end = Date.now() + 5000;

  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const asked = async (
  asks: Readonly<Record<string, JsonObject>>,
  timing: McpTasksTiming = TIMING,
  more: Partial<SetupOptions> = {},
  script: Script = scripted(),
) => {
  const { questions, make, store, told } = await questionsOf();

  const world = await setup(2, timing, script, {
    ...more,
    host: { asks, ...more.host },
    questions,
  });

  return { ...world, questions, make, store, told };
};

describe("a task's question inside the window", () => {
  it("is shown with no call waiting on it and answered with one tasks/update, its form sealed until then", async () => {
    const world = await asked({ which: FORM }, { ...TIMING, windowMs: 5000 });
    const { session, questions, taskServer, store, told } = world;

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [request] = await Effect.runPromise(questions.pending);

    expect(request).toMatchObject({
      callId: "mcp_task:mcp-task-1",
      task: "mcp-task-1",
      server: "docs",
      tool: "mcp__docs__report",
      waits: "owner",
    });
    expect(told).toEqual(["docs"]);
    expect((await recordNow(session, "mcp-task-1"))?.status).toBe("input_required");
    expect(taskServer.updates).toEqual([]);

    await Effect.runPromise(
      questions.answer(request?.id ?? "", { action: "accept", content: { region: "eu" } }),
    );

    const task = await running;

    await task.wait(context);

    expect(taskServer.updates).toEqual([
      { which: { action: "accept", content: { region: "eu" } } },
    ]);
    expect(JSON.stringify([...store.map])).not.toContain('"region":"eu"');
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect((await recordNow(session, "mcp-task-1"))?.questions?.keys).toMatchObject({
      which: { state: "sent" },
    });
  });

  it("is asked once: a key the server still shows after the answer was sent gets no second card or update", async () => {
    const { session, questions, taskServer } = await (async () => {
      const world = await asked(
        { which: FORM },
        { ...TIMING, windowMs: 5000 },
        {
          host: { asks: { which: FORM }, lagPolls: 3 },
        },
      );

      return world;
    })();

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [request] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "decline" }));

    await (await running).wait(context);

    expect(taskServer.updates).toEqual([{ which: { action: "decline" } }]);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
  });
});

describe("a task's question after the call went on", () => {
  it("is answered from the Session's own answer while only the follower polls, and the agent is told of the end", async () => {
    const world = await asked({ which: FORM });
    const { session, questions, make, taskServer } = world;

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));

    // The call returned at the window's end; the task waits on the owner.
    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [request] = await Effect.runPromise(questions.pending);

    expect(request?.callId).toBe("mcp_task:mcp-task-1");

    // An instance that holds no call for it leaves the round: a task's questions outlive any call, the task's end settles them.
    await Effect.runPromise(make().dropAbandoned);
    expect(await Effect.runPromise(questions.pending)).toHaveLength(1);

    await Effect.runPromise(
      questions.answer(request?.id ?? "", { action: "accept", content: { region: "us" } }),
    );

    await until(ended(session));
    await until(() => toldOfEnd(session));

    expect(taskServer.updates).toEqual([
      { which: { action: "accept", content: { region: "us" } } },
    ]);
    expect((await session.entries()).some((entry) => entry.kind === MCP_TASK_ENDED_KIND)).toBe(
      true,
    );
  });
});

describe("what cloudpid answers at once", () => {
  it("declines a form that asks for a credential unseen, and sends the answer without a card", async () => {
    const { session, questions, taskServer } = await asked(
      { token: CREDENTIAL },
      { ...TIMING, windowMs: 5000 },
    );

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));

    expect(taskServer.updates).toEqual([{ token: { action: "decline" } }]);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
  });

  it("cancels the forms past the cap of ten for one task, in the same update as the ten asked", async () => {
    const asks: Record<string, JsonObject> = {};

    for (let n = 1; n <= 11; n += 1) asks[`q${n}`] = CREDENTIAL;

    const { session, taskServer } = await asked(asks, { ...TIMING, windowMs: 5000 });

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));

    const [update] = taskServer.updates;

    expect(Object.keys(update ?? {})).toHaveLength(11);
    // Ten were declined as credentials, the eleventh was past the cap.
    expect(
      Object.values(update ?? {}).every(
        (each) => each["action"] === "decline" || each["action"] === "cancel",
      ),
    ).toBe(true);
    expect(update?.["q11"]).toEqual({ action: "cancel" });
  });

  it("answers Roots with none, which a task's server is never given", async () => {
    const { session, taskServer } = await asked(
      { roots: { method: "roots/list", params: {} } },
      { ...TIMING, windowMs: 5000 },
    );

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));

    expect(taskServer.updates).toEqual([{ roots: { roots: [] } }]);
  });
});

describe("a request cloudpid did not offer", () => {
  it("ends the task with tasks/cancel, naming what was asked", async () => {
    const { session, taskServer } = await asked(
      { odd: { method: "something/else", params: {} } },
      { ...TIMING, windowMs: 5000 },
    );

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(taskServer.updates).toEqual([]);

    const record = await recordNow(session, "mcp-task-1");

    expect(record?.end).toMatchObject({ status: "cancelled", by: "cloudpid" });
    expect(record?.end?.reason).toContain("something/else");
  });

  it("refuses a Sampling request the definition does not offer the same way", async () => {
    const { session, taskServer } = await asked(
      { sample: { method: "sampling/createMessage", params: { messages: [], maxTokens: 10 } } },
      { ...TIMING, windowMs: 5000 },
    );

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect((await recordNow(session, "mcp-task-1"))?.end?.by).toBe("cloudpid");
  });
});

describe("a page a task asks the owner to open", () => {
  it("is answered accept at once by Open, with no Done", async () => {
    const { session, questions, taskServer } = await asked(
      { page: PAGE },
      {
        ...TIMING,
        windowMs: 5000,
      },
    );

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [request] = await Effect.runPromise(questions.pending);

    expect(request?.page).toMatchObject({ host: "login.example.com", opened: false });
    expect(request?.page?.retry).toBeUndefined();

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "opened" }));
    await (await running).wait(context);

    expect(taskServer.updates).toEqual([{ page: { action: "accept" } }]);
  });
});

const SAMPLE: JsonObject = {
  method: "sampling/createMessage",
  params: {
    messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
    maxTokens: 200,
  },
};

/** A task over the Session's questions and Sampling, whose models answer `replies`. */
const sampled = async (
  asks: Readonly<Record<string, JsonObject>>,
  replies = ["a summary"],
  timing: McpTasksTiming = { ...TIMING, windowMs: 5000 },
) => {
  const { questions, store, told } = await questionsOf();

  const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-haiku-5-5" }] });
  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses(replies.map((text) => fauxAssistantMessage(text)));

  const sampling = createMcpSampling({ storage: store, redact: Effect.succeed, questions });

  sampling.bind({
    models,
    roles: () => ({ small: { provider: "anthropic", modelId: "claude-haiku-5-5" } }),
    overLimit: () => Promise.resolve(undefined),
    usage: () => undefined,
  });

  const world = await setup(2, timing, scripted(), {
    host: { asks },
    questions,
    sampling,
  });

  return { ...world, questions, sampling, faux, told };
};

describe("a Sampling request inside a task", () => {
  it("is shown on a card, run on the owner's yes, and answered with the model's reply in tasks/update", async () => {
    const { session, questions, faux, taskServer, told } = await sampled({ summary: SAMPLE });

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pendingSampling)).length === 1);

    const [card] = await Effect.runPromise(questions.pendingSampling);

    expect(card).toMatchObject({
      callId: "mcp_task:mcp-task-1",
      task: "mcp-task-1",
      server: "docs",
      waits: "owner",
    });
    expect(told).toEqual(["docs"]);
    expect(faux.state.callCount).toBe(0);
    expect(taskServer.updates).toEqual([]);

    await Effect.runPromise(questions.answerSampling(card?.id ?? "", { choice: "allow_call" }));
    await (await running).wait(context);

    expect(faux.state.callCount).toBe(1);
    expect(taskServer.updates).toEqual([
      {
        summary: expect.objectContaining({
          role: "assistant",
          content: { type: "text", text: "a summary" },
        }),
      },
    ]);
    expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]);
  });

  it("ends the task with tasks/cancel when the owner refuses it, naming sampling_refused", async () => {
    const { session, questions, faux, taskServer } = await sampled({ summary: SAMPLE });

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pendingSampling)).length === 1);

    const [card] = await Effect.runPromise(questions.pendingSampling);

    await Effect.runPromise(questions.answerSampling(card?.id ?? "", { choice: "refuse" }));
    await (await running).wait(context);

    expect(faux.state.callCount).toBe(0);
    expect(taskServer.updates).toEqual([]);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);

    const record = await recordNow(session, "mcp-task-1");

    expect(record?.end).toMatchObject({
      status: "cancelled",
      by: "cloudpid",
      error: "sampling_refused",
    });
    expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]);
  });

  it("ends the task with tasks/cancel when it asks more than twenty, none of them run", async () => {
    const asks: Record<string, JsonObject> = {};

    for (let n = 1; n <= 21; n += 1) asks[`s${n}`] = SAMPLE;

    const { session, questions, faux, taskServer } = await sampled(asks);

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));

    // A Sampling request has no `cancel` to be told: one past the cap is refused, which ends the task.
    expect(faux.state.callCount).toBe(0);
    expect(taskServer.updates).toEqual([]);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]);
    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({
      status: "cancelled",
      by: "cloudpid",
      error: "sampling_refused",
    });
  });
});

const ROOTS: JsonObject = { method: "roots/list", params: {} };

const lost = async () =>
  McpHostCallFailed.make({ error: ServerError.make({ message: "no", code: -32000 }) });

const LONG = { ...TIMING, windowMs: 5000 };

describe("an update that was lost", () => {
  it("is sent again once from the record when cloudpid answered everything itself and stored no round", async () => {
    const { session, taskServer } = await asked({ roots: ROOTS }, LONG, {
      host: { updateAnswer: (n) => (n === 1 ? lost() : undefined) },
    });

    await turn(session, "go");

    expect(taskServer.attempts).toEqual([{ roots: { roots: [] } }, { roots: { roots: [] } }]);
    expect(taskServer.updates).toEqual([{ roots: { roots: [] } }]);

    const held = (await recordNow(session, "mcp-task-1"))?.questions;

    expect(held?.pending).toBeUndefined();
    expect(held?.keys).toMatchObject({ roots: { state: "sent" } });
  });

  it("is sent again once from the owner's round, its content still sealed until the server took it", async () => {
    const { session, questions, taskServer, store } = await asked({ which: FORM }, LONG, {
      host: { updateAnswer: (n) => (n === 1 ? lost() : undefined) },
    });

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [request] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(
      questions.answer(request?.id ?? "", { action: "accept", content: { region: "eu" } }),
    );
    await (await running).wait(context);

    expect(taskServer.attempts).toHaveLength(2);
    expect(taskServer.updates).toEqual([
      { which: { action: "accept", content: { region: "eu" } } },
    ]);
    expect(JSON.stringify([...store.map])).not.toContain('"region":"eu"');
    expect((await recordNow(session, "mcp-task-1"))?.questions?.pending).toBeUndefined();
  });

  it("ends the task with tasks/cancel when it was lost twice, rather than leave the server waiting", async () => {
    const { session, taskServer } = await asked({ roots: ROOTS }, LONG, {
      host: { updateAnswer: () => lost() },
    });

    await turn(session, "go");

    expect(taskServer.attempts).toHaveLength(2);
    expect(taskServer.updates).toEqual([]);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);

    const end = (await recordNow(session, "mcp-task-1"))?.end;

    expect(end).toMatchObject({ status: "cancelled", by: "cloudpid" });
    expect(end?.reason).toContain("could not send your answer");
  });
});

describe("a page opened beside a form", () => {
  it("is answered accept at once in an update of its own, and not again with the form's", async () => {
    const { session, questions, taskServer } = await asked({ page: PAGE, which: FORM }, LONG);

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length === 2);

    const waiting = await Effect.runPromise(questions.pending);
    const page = waiting.find((each) => each.page !== undefined);
    const form = waiting.find((each) => each.page === undefined);

    await Effect.runPromise(questions.answer(page?.id ?? "", { action: "opened" }));
    await until(() => taskServer.updates.length === 1);

    expect(taskServer.updates).toEqual([{ page: { action: "accept" } }]);
    // The form is still the owner's to answer.

    expect(await Effect.runPromise(questions.pending)).toHaveLength(1);

    await Effect.runPromise(
      questions.answer(form?.id ?? "", { action: "accept", content: { region: "us" } }),
    );
    await (await running).wait(context);

    expect(taskServer.updates).toEqual([
      { page: { action: "accept" } },
      { which: { action: "accept", content: { region: "us" } } },
    ]);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
  });
});

describe("a Sampling request in a task that went on in the background", () => {
  it("is allowed after the call returned, run, and answered with the model's reply in tasks/update", async () => {
    const { session, questions, faux, taskServer } = await sampled(
      { summary: SAMPLE },
      ["a summary"],
      TIMING,
    );

    await turn(session, "go");

    // The call returned at the window's end: the task is the follower's, and the card waits for the owner.
    expect((await recordNow(session, "mcp-task-1"))?.background).toBe(true);

    await until(async () => (await Effect.runPromise(questions.pendingSampling)).length === 1);

    const [card] = await Effect.runPromise(questions.pendingSampling);

    expect(faux.state.callCount).toBe(0);

    await Effect.runPromise(questions.answerSampling(card?.id ?? "", { choice: "allow_call" }));
    await until(ended(session));

    expect(faux.state.callCount).toBe(1);
    expect(taskServer.updates).toEqual([
      { summary: expect.objectContaining({ content: { type: "text", text: "a summary" } }) },
    ]);
  });
});

describe("the caps of a task", () => {
  const FORMS = (prefix: string, n: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i + 1}`, CREDENTIAL]));

  it("hold across rounds: the second round's requests past ten forms are cancelled", async () => {
    const { session, taskServer } = await asked(FORMS("a", 6), LONG, {
      host: { asks: FORMS("a", 6), later: FORMS("b", 6) },
    });

    await turn(session, "go");

    const [first, second] = taskServer.updates;

    expect(Object.keys(first ?? {})).toHaveLength(6);
    expect(Object.keys(second ?? {})).toHaveLength(6);
    expect(second?.["b4"]).toEqual({ action: "decline" });
    expect(second?.["b5"]).toEqual({ action: "cancel" });
    expect(second?.["b6"]).toEqual({ action: "cancel" });
  });

  it("hold after a restart: an instance that never saw the earlier forms counts on from the record", async () => {
    const { session, client } = await asked({}, LONG, { host: {} });
    const { make } = await questionsOf();

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await recordNow(session, "mcp-task-1")) !== undefined);

    await session.harness.commit(async (tx) => {
      const own = (await tx.doc(McpTasksDoc)).tasks["mcp-task-1"];

      if (own !== undefined) own.questions = { round: 1, count: 9, sampled: 0, keys: {} };
    }, context);

    const record = await recordNow(session, "mcp-task-1");

    // SAFETY: only the status and the questions of the snapshot are read.
    const snapshot: McpTaskSnapshot = {
      ...CREATED,
      status: "input_required",
      inputRequests: FORMS("x", 2),
    } as McpTaskSnapshot;

    const updates: Array<unknown> = [];

    await observeQuestions(
      {
        asking: {
          questions: make(),
          samples: false,
          servers: [{ name: "docs", state: "connected", server: {} }],
        },
        client: {
          ...client,
          request: (input, options) => {
            if (input.op === "tasks/update") updates.push(input.params.inputResponses);

            return client.request(input, options);
          },
        },
        origin: {},
        store: taskStoreOf(session.harness, context),
        now: () => Date.now(),
      },
      record ??
        (() => {
          throw new Error("no record");
        })(),
      snapshot,
    );

    expect(updates).toEqual([{ x1: { action: "decline" }, x2: { action: "cancel" } }]);
    await session.root.abort(context, { background: true });
    await running.catch(() => undefined);
  });
});

describe("a task that waits for the server to take the owner's answer", () => {
  it("reads so once the answer was sent and the server kept asking for answerSlowMs, and not once it asks anew", async () => {
    const { session } = await asked(
      { r1: ROOTS },
      { ...LONG, answerSlowMs: 30 },
      {
        host: { lagPolls: 40, later: { r2: ROOTS } },
      },
    );

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await recordNow(session, "mcp-task-1"))?.questions?.stuck === true);

    const stuck = await recordNow(session, "mcp-task-1");

    expect(stuck && shownStatusMessage(stuck)).toBe("waiting for docs to take your answer");

    // The server asks something new: the status is the server's again.
    await until(
      async () => (await recordNow(session, "mcp-task-1"))?.questions?.keys["r2"] !== undefined,
    );

    expect((await recordNow(session, "mcp-task-1"))?.questions?.stuck).toBeUndefined();
    await (await running).wait(context);
  });
});

describe("what the agent reads of a task that waits for the owner", () => {
  it("is 'waiting for the owner' in mcp_tasks and in mcp_task_wait", async () => {
    const { session } = await asked(
      { which: FORM },
      TIMING,
      {},
      scripted((text) => {
        if (text === "list") return call(["mcp_tasks", {}]);

        return text === "wait"
          ? call(["mcp_task_wait", { task: "mcp-task-1", timeout_s: 1 }])
          : undefined;
      }),
    );

    await turn(session, "go");
    await until(async () => (await recordNow(session, "mcp-task-1"))?.status === "input_required");
    await turn(session, "list");
    await turn(session, "wait");

    const [listed, waited] = (await session.texts("toolResult")).slice(-2);

    expect(listed).toContain("waiting for the owner");
    expect(waited).toContain("waiting for the owner");
    await session.root.abort(context, { background: true });
  });
});

describe("the Notification of a task's rounds", () => {
  const rounds = async () => {
    const { session, questions, told } = await asked({ a: FORM }, LONG, {
      host: { asks: { a: FORM }, later: { b: FORM }, lagPolls: 25 },
    });

    const running = session.root.submit({ type: "input", content: "go" }, context);

    const answerOne = async () => {
      await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

      const [request] = await Effect.runPromise(questions.pending);

      await Effect.runPromise(
        questions.answer(request?.id ?? "", { action: "accept", content: { region: "eu" } }),
      );
    };

    await answerOne();
    // The second round comes some polls after the answer, well within the two minutes the owner is not told again for.
    await answerOne();
    await (await running).wait(context);

    return told;
  };

  it("is sent for the first round, and not for a second that came within two minutes", async () => {
    expect(await rounds()).toEqual(["docs"]);
  });
});

describe("a page opened after the form beside it", () => {
  it("is sent alone, and then the form's answer, so the form is not asked again", async () => {
    const { session, questions, taskServer } = await asked({ page: PAGE, which: FORM }, LONG);

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length === 2);

    const waiting = await Effect.runPromise(questions.pending);
    const page = waiting.find((each) => each.page !== undefined);
    const form = waiting.find((each) => each.page === undefined);

    // The form first: the round is not complete, and nothing is sent.
    await Effect.runPromise(
      questions.answer(form?.id ?? "", { action: "accept", content: { region: "eu" } }),
    );
    expect(taskServer.updates).toEqual([]);

    await Effect.runPromise(questions.answer(page?.id ?? "", { action: "opened" }));
    await (await running).wait(context);

    expect(taskServer.updates).toEqual([
      { page: { action: "accept" } },
      { which: { action: "accept", content: { region: "eu" } } },
    ]);
    // The form was not asked again: two forms and pages were asked in all.
    expect((await recordNow(session, "mcp-task-1"))?.questions?.count).toBe(2);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
  });

  it("sends what cloudpid answered itself once, with the update after the page's own", async () => {
    const { session, questions, taskServer } = await asked({ page: PAGE, roots: ROOTS }, LONG);

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [page] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(questions.answer(page?.id ?? "", { action: "opened" }));
    await (await running).wait(context);

    expect(taskServer.updates).toEqual([{ page: { action: "accept" } }, { roots: { roots: [] } }]);
  });

  it("closes its round once the only question of it was sent", async () => {
    // The server goes on listing the page for good, so the task does not end and nothing else settles the round.
    const { session, questions, taskServer } = await asked({ page: PAGE }, LONG, {
      host: { asks: { page: PAGE }, lagPolls: 100_000 },
    });

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [page] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(questions.answer(page?.id ?? "", { action: "opened" }));
    await until(() => taskServer.updates.length === 1);
    await until(
      async () =>
        (await Effect.runPromise(questions.deferredRound("mcp_task:mcp-task-1"))) === undefined,
    );

    expect(taskServer.updates).toEqual([{ page: { action: "accept" } }]);
    expect((await recordNow(session, "mcp-task-1"))?.end).toBeUndefined();
    await session.root.abort(context, { background: true });
    await running.catch(() => undefined);
  });
});

describe("an update the server took without the answer reaching cloudpid", () => {
  it("is not sent again once the server no longer lists its key, and the task goes on", async () => {
    const { session, taskServer } = await asked({ a: ROOTS }, LONG, {
      host: { asks: { a: ROOTS }, later: { b: ROOTS }, updateLostAfter: (n) => n === 1 },
    });

    await turn(session, "go");

    // `a` reached the server once; the next round's `b` was answered, and `a` never again.
    expect(taskServer.attempts).toEqual([{ a: { roots: [] } }, { b: { roots: [] } }]);
    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({ status: "completed" });
    expect((await recordNow(session, "mcp-task-1"))?.questions?.pending).toBeUndefined();
  });
});

/** A record in a document of its own, so no poll of the Session changes it while the test reads it. */
const isolated = (record: McpTaskRecord) => {
  const doc: McpTasksState = {
    next: 2,
    tasks: { [record.handle]: structuredClone(record) },
    recent: [],
  };

  const store: TaskStore = {
    read: async (handle) => doc.tasks[handle],
    commit: async (write) => {
      const tx: Partial<Parameters<typeof write>[0]> = { doc: async () => doc };

      // SAFETY: the writes of the questions only read the tasks document from the transaction.
      await write(tx as Parameters<typeof write>[0]);
    },
  };

  return { doc, store };
};

describe("an update that was lost while the server omitted its key for a poll", () => {
  it("is sent again once the server lists the key again, its sealed answer kept meanwhile", async () => {
    const { session, questions, taskServer, store } = await asked({ which: FORM }, LONG, {
      host: { updateAnswer: (n) => (n === 1 ? lost() : undefined), omitOnce: true },
    });

    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [request] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(
      questions.answer(request?.id ?? "", { action: "accept", content: { region: "eu" } }),
    );
    await (await running).wait(context);

    // The first update never reached the server; the poll after it listed nothing; the answer was sent when it listed it.
    expect(taskServer.attempts).toHaveLength(2);
    expect(taskServer.updates).toEqual([
      { which: { action: "accept", content: { region: "eu" } } },
    ]);
    expect((await recordNow(session, "mcp-task-1"))?.questions?.count).toBe(1);
    expect(JSON.stringify([...store.map])).not.toContain('"region":"eu"');
  });

  it("counts an update taken and then one lost as two attempts apart, so the task is not cancelled", async () => {
    // `a` reaches the server and its ack is lost; the server goes on to `b`, whose update is lost once before it reaches it.
    const { session, taskServer } = await asked({ a: ROOTS }, LONG, {
      host: {
        asks: { a: ROOTS },
        later: { b: ROOTS },
        updateLostAfter: (n) => n === 1,
        updateAnswer: (n) => (n === 2 ? lost() : undefined),
      },
    });

    await turn(session, "go");

    expect(taskServer.attempts).toEqual([
      { a: { roots: [] } },
      { b: { roots: [] } },
      { b: { roots: [] } },
    ]);
    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({ status: "completed" });
  });
});

describe("the slow status of a task that asks anew", () => {
  const observe = async (listed: Readonly<Record<string, JsonObject>>) => {
    const { session, client } = await asked({}, LONG);
    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await recordNow(session, "mcp-task-1")) !== undefined);

    const started = await recordNow(session, "mcp-task-1");

    if (started === undefined) throw new Error("the task has no record");

    const seeded: McpTaskRecord = {
      ...structuredClone(started),
      questions: {
        round: 1,
        count: 1,
        sampled: 0,
        stuck: true,
        keys: { r1: { state: "sent", at: 0 } },
      },
    };

    const { doc, store } = isolated(seeded);

    // SAFETY: only the status and the questions of the snapshot are read.
    const snapshot = {
      ...CREATED,
      status: "input_required",
      inputRequests: listed,
    } as McpTaskSnapshot;

    await observeQuestions(
      {
        asking: {
          questions: (await questionsOf()).questions,
          samples: false,
          servers: [{ name: "docs", state: "connected", server: {} }],
        },
        client,
        origin: {},
        store,
        now: () => Date.now(),
      },
      seeded,
      snapshot,
    );

    await session.root.abort(context, { background: true });
    await running.catch(() => undefined);

    return doc.tasks["mcp-task-1"]?.questions?.stuck;
  };

  it("goes on while the server only lists the key it was answered", async () => {
    expect(await observe({ r1: ROOTS })).toBe(true);
  });

  it("is cleared by a new question, though the key that was sent is still listed", async () => {
    expect(await observe({ r1: ROOTS, x1: ROOTS })).toBeUndefined();
  });

  it("is cleared once the server no longer lists the key that was sent", async () => {
    expect(await observe({})).toBeUndefined();
  });
});

describe("the Notification of a task's rounds by the clock", () => {
  const OWNER = "mcp_task:mcp-task-1";

  /** Two rounds under the task's key, the owner having nothing waiting for `gap` ms between them; who was told. */
  const told = async (gap: number) => {
    const { questions, told: heard } = await questionsOf();

    const round = (n: number) =>
      Effect.gen(function* () {
        yield* questions.defer({
          key: `k${n}`,
          callId: OWNER,
          conversationId: ROOT_CONVERSATION_ID,
          server: "docs",
          tool: "mcp__docs__report",
          message: "Which region?",
          form: { fields: [{ kind: "text", name: "region", required: true }] },
          notes: [],
          task: "mcp-task-1",
        });
        yield* questions.commitRound({
          callId: OWNER,
          round: n,
          conn: "conn-docs",
          tool: "report",
          state: McpRoundState.Task({ answered: {} }),
          asked: [],
        });
        yield* questions.showRound(OWNER);

        const [request] = yield* questions.pending;

        yield* questions.answer(request?.id ?? "", { action: "decline" });
        yield* questions.endRound(OWNER);
      });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* round(1);
        yield* TestClock.adjust(gap);
        yield* round(2);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    // The Notification is sent in the background.
    await new Promise((resolve) => setTimeout(resolve, 30));

    return heard;
  };

  it("tells again for a second round once two minutes have passed with nothing waiting", async () => {
    expect(await told(MCP_QUESTION_RENOTIFY_MS)).toEqual(["docs", "docs"]);
  });

  it("tells nobody for a second round a millisecond short of two minutes", async () => {
    expect(await told(MCP_QUESTION_RENOTIFY_MS - 1)).toEqual(["docs"]);
  });
});

const FORMS2 = { f1: FORM, f2: FORM } satisfies Record<string, JsonObject>;

describe("a round whose update the server partly took", () => {
  const HANDLE = "mcp-task-iso";
  const OWNER = `mcp_task:${HANDLE}`;

  /**
   * A task's questions asked and answered over a document of their own and a host that answers each `tasks/update` as
   * the test says (`lose`: the next ones fail before they reach the server); what was sent is `sent`.
   */
  const rig = async (replies: ReadonlyArray<string> = []) => {
    const world = await sampled({}, [...replies]);
    const { session, questions, client } = world;
    const running = session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await recordNow(session, "mcp-task-1")) !== undefined);

    const started = await recordNow(session, "mcp-task-1");

    if (started === undefined) throw new Error("the task has no record");

    const { doc, store } = isolated({ ...structuredClone(started), handle: HANDLE });
    const sent: Array<Readonly<Record<string, JsonObject>>> = [];
    const roundsAtSend: Array<boolean> = [];
    // The updates that fail before they reach the server, by their number (1-based) among those sent.
    const lost = new Set<number>();

    const wrapped: typeof client = {
      ...client,
      request: (input, options) => {
        if (input.op !== "tasks/update") return client.request(input, options);

        sent.push(input.params.inputResponses);

        return questions.deferredRound(OWNER).pipe(
          Effect.map((round) => {
            roundsAtSend.push(round !== undefined);

            if (lost.has(sent.length)) {
              return McpHostCallFailed.make({
                error: ServerError.make({ message: "no", code: -32000 }),
              });
            }

            return McpHostTaskAck.make({});
          }),
        );
      },
    };

    const observe = (listed: Readonly<Record<string, JsonObject>>) => {
      // SAFETY: only the status and the questions of the snapshot are read.
      const snapshot = {
        ...CREATED,
        status: "input_required",
        inputRequests: listed,
      } as McpTaskSnapshot;

      const record = doc.tasks[HANDLE];

      if (record === undefined) throw new Error("the rig lost its record");

      return observeQuestions(
        {
          asking: {
            questions,
            sampling: world.sampling,
            samples: true,
            servers: [{ name: "docs", state: "connected", server: {} }],
          },
          client: wrapped,
          origin: {},
          store,
          now: () => Date.now(),
        },
        record,
        snapshot,
      );
    };

    const finish = async () => {
      await session.root.abort(context, { background: true });
      await running.catch(() => undefined);
    };

    return {
      ...world,
      doc,
      sent,
      roundsAtSend,
      observe,
      finish,
      /** The next `n` updates are lost. */
      lose: (n: number) => {
        for (const each of Arr.makeBy(n, (i) => sent.length + i + 1)) lost.add(each);
      },
      /** The updates numbered `at` (1-based, among those sent) are lost. */
      loseAt: (at: ReadonlyArray<number>) => {
        for (const each of at) lost.add(each);
      },
      keys: () => doc.tasks[HANDLE]?.questions?.keys,
    };
  };

  const answerForms = async (questions: Awaited<ReturnType<typeof rig>>["questions"]) => {
    for (const card of await Effect.runPromise(questions.pending)) {
      await Effect.runPromise(
        questions.answer(card.id, { action: "accept", content: { region: "eu" } }),
      );
    }
  };

  it("sends again only the keys the server still lists, and keeps the round until all of it was sent", async () => {
    const { observe, questions, lose, sent, keys, roundsAtSend, finish } = await rig();

    await observe(FORMS2);
    await answerForms(questions);

    lose(1);
    await observe(FORMS2);
    expect(keys()).toMatchObject({ f1: { state: "sending" }, f2: { state: "sending" } });

    // The server took `f1` and went on to a question of its own; `f2` it still lists.
    await observe({ f2: FORM, x1: ROOTS });

    expect(sent.map((each) => Object.keys(each))).toEqual([["f1", "f2"], ["f2"]]);
    expect(sent[1]).toEqual({ f2: { action: "accept", content: { region: "eu" } } });
    // The round was there when `f2` was sent, and is gone once it was.
    expect(roundsAtSend).toEqual([true, true]);
    expect(keys()).toMatchObject({ f1: { state: "sent" }, f2: { state: "sent" } });
    expect(await Effect.runPromise(questions.deferredRound(OWNER))).toBeUndefined();
    await finish();
  });

  it("does not run a Sampling request again for a key that was sent", async () => {
    const SAMPLES = { s1: SAMPLE, s2: SAMPLE } satisfies Record<string, JsonObject>;
    const { observe, questions, faux, lose, sent, finish } = await rig(["one", "two", "three"]);

    await observe(SAMPLES);

    const [card] = await Effect.runPromise(questions.pendingSampling);

    await Effect.runPromise(questions.answerSampling(card?.id ?? "", { choice: "allow_call" }));

    lose(1);
    await observe(SAMPLES);
    expect(faux.state.callCount).toBe(2);

    // The server took `s1`; `s2` it still lists, and is asked for again.
    await observe({ s2: SAMPLE, x1: ROOTS });

    expect(sent.map((each) => Object.keys(each))).toEqual([["s1", "s2"], ["s2"]]);
    // Only `s2`'s reply was made again.
    expect(faux.state.callCount).toBe(3);
    await finish();
  });

  it("counts a server that merely lists less as no evidence: its keys stay, with the round, to be sent again", async () => {
    const { observe, questions, lose, sent, keys, finish } = await rig();

    await observe({ f1: FORM });
    await answerForms(questions);

    lose(1);
    await observe({ f1: FORM });

    // A poll that omits the key, then one that lists it again.
    await observe({});
    expect(keys()).toMatchObject({ f1: { state: "sending" } });
    expect(await Effect.runPromise(questions.deferredRound(OWNER))).toBeDefined();
    expect(sent).toHaveLength(1);

    await observe({ f1: FORM });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ f1: { action: "accept", content: { region: "eu" } } });
    expect(keys()).toMatchObject({ f1: { state: "sent" } });
    await finish();
  });

  it("keeps what was held back to be sent: a key the server omitted is sent when it lists it again", async () => {
    const { observe, lose, sent, doc, finish } = await rig();

    lose(1);
    await observe({ x1: ROOTS, x2: ROOTS });
    await observe({ x1: ROOTS });
    await observe({});
    await observe({ x2: ROOTS });

    expect(sent.map((each) => Object.keys(each))).toEqual([["x1", "x2"], ["x1"], ["x2"]]);
    expect(doc.tasks[HANDLE]?.questions?.pending).toBeUndefined();
    await finish();
  });

  it("holds a page back too: an opened page the server omitted is sent alone again when it lists it again", async () => {
    const { observe, questions, lose, sent, keys, finish } = await rig();
    const PAGES = { p1: PAGE, p2: PAGE } satisfies Record<string, JsonObject>;

    await observe(PAGES);

    for (const card of await Effect.runPromise(questions.pending)) {
      await Effect.runPromise(questions.answer(card.id, { action: "opened" }));
    }

    // The update that carries both pages is lost.
    lose(1);
    await observe(PAGES);
    expect(sent.map((each) => Object.keys(each))).toEqual([["p1", "p2"]]);
    expect(keys()).toMatchObject({ p1: { state: "sending" }, p2: { state: "sending" } });

    // The server lists `p2` alone: `p1` is not sent again, as it may list it again, and `p2` is.
    await observe({ p2: PAGE });
    expect(sent.map((each) => Object.keys(each))).toEqual([["p1", "p2"], ["p2"]]);
    expect(keys()).toMatchObject({ p1: { state: "sending" }, p2: { state: "sent" } });

    await observe(PAGES);

    expect(sent.map((each) => Object.keys(each))).toEqual([["p1", "p2"], ["p2"], ["p1"]]);
    expect(sent[2]).toEqual({ p1: { action: "accept" } });
    expect(keys()).toMatchObject({ p1: { state: "sent" }, p2: { state: "sent" } });
    await finish();
  });

  it("does not take a page for sent because the server lists the form beside it, which was asked and not answered", async () => {
    const { observe, questions, lose, sent, keys, finish } = await rig();

    await observe({ p1: PAGE, f1: FORM });

    const page = (await Effect.runPromise(questions.pending)).find(
      (each) => each.page !== undefined,
    );

    await Effect.runPromise(questions.answer(page?.id ?? "", { action: "opened" }));

    // The page's own update is lost.
    lose(1);
    await observe({ p1: PAGE, f1: FORM });
    expect(sent.map((each) => Object.keys(each))).toEqual([["p1"]]);

    // The server lists the form and omits the page: the form is not news, so the page stays to be sent.
    await observe({ f1: FORM });
    expect(sent).toHaveLength(1);
    expect(keys()).toMatchObject({ p1: { state: "sending" } });
    expect(await Effect.runPromise(questions.deferredRound(OWNER))).toBeDefined();

    await observe({ p1: PAGE, f1: FORM });

    expect(sent.map((each) => Object.keys(each))).toEqual([["p1"], ["p1"]]);
    expect(keys()).toMatchObject({ p1: { state: "sent" } });
    await finish();
  });

  it("does not take a page for sent because the server lists what cloudpid answered itself and has not sent", async () => {
    const { observe, questions, lose, sent, keys, finish } = await rig();

    await observe({ p1: PAGE, x1: ROOTS });

    const page = (await Effect.runPromise(questions.pending)).find(
      (each) => each.page !== undefined,
    );

    await Effect.runPromise(questions.answer(page?.id ?? "", { action: "opened" }));

    lose(1);
    await observe({ p1: PAGE, x1: ROOTS });
    expect(sent.map((each) => Object.keys(each))).toEqual([["p1"]]);

    // `x1` was answered by cloudpid, and is kept with the round to be sent: listing it is not news.
    await observe({ x1: ROOTS });
    expect(sent).toHaveLength(1);
    expect(keys()).toMatchObject({ p1: { state: "sending" } });

    await observe({ p1: PAGE, x1: ROOTS });

    expect(sent.map((each) => Object.keys(each))[1]).toEqual(["p1"]);
    expect(keys()).toMatchObject({ p1: { state: "sent" } });
    await finish();
  });

  it("sends an update again once, though another key of the round was sent in between", async () => {
    const { observe, questions, loseAt, sent, doc, finish } = await rig();

    await observe(FORMS2);
    await answerForms(questions);

    // The first update and the third are lost: `f1` is tried twice, and not a third time.
    loseAt([1, 3]);
    await observe(FORMS2);
    await observe({ f2: FORM });
    await observe({ f1: FORM });
    await observe({ f1: FORM });

    expect(sent.map((each) => Object.keys(each))).toEqual([["f1", "f2"], ["f2"], ["f1"]]);
    expect(doc.tasks[HANDLE]?.cancel?.by).toBe("cloudpid");
    await finish();
  });

  it("sends the keys the server lists first and the rest when it lists them, the round staying until then", async () => {
    const { observe, questions, lose, sent, keys, roundsAtSend, finish } = await rig();

    await observe(FORMS2);
    await answerForms(questions);

    lose(1);
    await observe(FORMS2);
    await observe({ f2: FORM });

    expect(keys()).toMatchObject({ f1: { state: "sending" }, f2: { state: "sent" } });
    expect(await Effect.runPromise(questions.deferredRound(OWNER))).toBeDefined();

    await observe({ f1: FORM });

    expect(sent.map((each) => Object.keys(each))).toEqual([["f1", "f2"], ["f2"], ["f1"]]);
    expect(roundsAtSend).toEqual([true, true, true]);
    expect(keys()).toMatchObject({ f1: { state: "sent" }, f2: { state: "sent" } });
    expect(await Effect.runPromise(questions.deferredRound(OWNER))).toBeUndefined();
    await finish();
  });

  it("runs only the Sampling requests the server lists, and the rest when it lists them", async () => {
    const SAMPLES = { s1: SAMPLE, s2: SAMPLE } satisfies Record<string, JsonObject>;
    const { observe, questions, faux, lose, sent, finish } = await rig(["a", "b", "c", "d"]);

    await observe(SAMPLES);

    const [card] = await Effect.runPromise(questions.pendingSampling);

    await Effect.runPromise(questions.answerSampling(card?.id ?? "", { choice: "allow_call" }));

    lose(1);
    await observe(SAMPLES);
    await observe({ s2: SAMPLE });
    // `s1` is held back, not run again.
    expect(faux.state.callCount).toBe(3);

    await observe({ s1: SAMPLE });

    expect(faux.state.callCount).toBe(4);
    expect(sent.map((each) => Object.keys(each))).toEqual([["s1", "s2"], ["s2"], ["s1"]]);
    await finish();
  });

  it("reads slow while only keys already sent are listed and an answer is held back", async () => {
    const { observe, questions, lose, doc, finish } = await rig();

    await observe({ f1: FORM });
    await answerForms(questions);

    lose(1);
    await observe({ f1: FORM });

    const task = doc.tasks[HANDLE];

    if (task?.questions !== undefined) task.questions.keys["r1"] = { state: "sent", at: 0 };

    // The server lists `r1`, which was answered long ago, and not `f1`, whose update was lost.
    await observe({ r1: ROOTS });

    expect(doc.tasks[HANDLE]?.questions?.stuck).toBe(true);
    await finish();
  });
});
