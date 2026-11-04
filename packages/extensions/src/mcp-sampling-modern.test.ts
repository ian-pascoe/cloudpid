// A Modern server's Sampling request on an agent's call (`docs/architecture/mcp-server-requests.md` → Sampling requests,
// Questions, The waiting-question record): with `ask` it is checked, kept with the call's round beside the forms, shown
// on a card that waits for the owner with no deadline, and run when the round resumes, on what the owner decided; with a
// refusal the round is sunk, which withdraws the forms beside it, sends nothing, and ends the call locally with
// `details.error: "sampling_refused"`. A scripted model on a Harness, and an in-memory host that asks through the call's
// hooks as the core's rounds do.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off anyUnknownInErrorContext:off preferSchemaOverJson:off
import {
  type JsonObject,
  McpHostCallFailed,
  McpHostCompleted,
  McpHostInputRequired,
  type McpInputAnswer,
  type McpInputRequest,
  MCP_HOST_FEATURES,
  Unsupported,
} from "@cloudpid/mcp/types";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { makeMcpTools, memoryMcpToolsStore } from "./mcp.ts";
import { DOCS, detailsOf, open } from "./mcp.fixture.ts";
import { fakeMcpHost, type FakeMcpAnswer } from "./mcp.testing.ts";
import {
  createMcpQuestions,
  MCP_DEFERRED_DEADLINE_MS,
  McpRoundState,
  type McpQuestionStorage,
} from "./mcp/questions.ts";
import { createMcpSampling } from "./mcp/sampling.ts";
import { openKeptVault } from "./secrets/vault.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

type Sent = Parameters<FakeMcpAnswer>[0];

type Request = typeof McpInputRequest.Encoded;

type Answer = typeof McpInputAnswer.Encoded;

const NAME_FORM: JsonObject = {
  type: "object",
  properties: { name: { type: "string", title: "Your name" } },
  required: ["name"],
};

const FORM: Request = {
  key: "q1",
  kind: "elicitation",
  params: { message: "Who are you?", requestedSchema: NAME_FORM },
  mode: "deferrable",
  era: "modern",
};

const SAMPLE: Request = {
  key: "s1",
  kind: "sampling",
  params: {
    messages: [{ role: "user", content: { type: "text", text: "Summarize" } }],
    maxTokens: 200,
  },
  mode: "deferrable",
  era: "modern",
};

const STATE = {
  v: 1,
  method: "tools/call",
  name: "search",
  arguments: {},
  round: 1,
  deferred: ["q1", "s1"],
};

const DONE = McpHostCompleted.make({
  result: { kind: "inline", value: { content: [{ type: "text", text: "done" }] } },
});

const memoryStorage = () => {
  const map = new Map<string, unknown>();

  const storage: McpQuestionStorage = {
    // SAFETY: the questions read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      map.set(key, structuredClone(value));
    },
    delete: (key) => map.delete(key),
  };

  return { storage, keys: () => [...map.keys()] };
};

const testVault = async () => {
  const kept = await Effect.runPromise(
    openKeptVault("test-master-key-0123456789abcdef0123456789", "mcp-elicitation"),
  );

  return {
    seal: (id: string, text: string) => kept.seal({ owner: "s1", name: id }, text),
    open: (id: string, sealed: Parameters<typeof kept.open>[1]) =>
      kept.open({ owner: "s1", name: id }, sealed),
  };
};

const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 5000;

  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * A Session's tools over a host whose Modern call asks `asks` in one round. A request that is refused ends the call as the
 * core's round does (`Unsupported` with the refusal's words); one deferred ends the round `input_required`; a round with
 * none of either is answered, and the resume is kept.
 */
const setup = async (
  options: { readonly asks?: ReadonlyArray<Request>; readonly over?: string } = {},
) => {
  const asks = options.asks ?? [FORM, SAMPLE];
  const host = fakeMcpHost([DOCS]);
  const memory = memoryStorage();
  const vault = await testVault();
  const told: Array<{ server: string; sampling?: true }> = [];

  const questions = createMcpQuestions({
    storage: memory.storage,
    announce: () => Effect.void,
    announceSampling: () => Effect.void,
    notify: (who) =>
      Effect.sync(() => {
        told.push(who);
      }),
    redact: (shown) => Effect.succeed(shown),
    holdsSecret: () => Effect.succeed(false),
    vault,
  });

  const faux = fauxProvider({ provider: "anthropic", models: [{ id: "claude-haiku-5-5" }] });
  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("a summary")]);

  const sampling = createMcpSampling({
    storage: memory.storage,
    redact: Effect.succeed,
    questions,
  });

  sampling.bind({
    models,
    roles: () => ({ small: { provider: "anthropic", modelId: "claude-haiku-5-5" } }),
    overLimit: () => Promise.resolve(options.over),
    usage: () => undefined,
  });

  host.features(MCP_HOST_FEATURES);

  const resumes: Array<Sent> = [];
  const replies: Array<readonly [string, Answer]> = [];

  host.answer(async (input, hooks) => {
    if (input.op === "resume") {
      resumes.push(input);

      return DONE;
    }

    for (const request of asks) {
      const reply = await hooks.onInput?.(request);

      if (reply === undefined) continue;

      replies.push([request.key, reply]);

      if (reply.kind === "refused") {
        return McpHostCallFailed.make({ error: Unsupported.make({ message: reply.message }) });
      }
    }

    return replies.some(([, reply]) => reply.kind === "defer")
      ? McpHostInputRequired.make({ requests: [...asks], resume: STATE, conn: "conn-docs" })
      : DONE;
  });

  const tools = makeMcpTools(host.client, memoryMcpToolsStore(), {
    slackMs: 0,
    questions,
    sampling,
  });

  const session = await open((request) =>
    request.text === "go" ? call(["mcp__docs_site__search", {}]) : answer("ok"),
  );

  await session.start(tools);

  const sent = () => host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));
  const run = () => session.root.submit({ type: "input", content: "go" }, context);

  return { memory, questions, sampling, faux, session, sent, resumes, replies, told, run };
};

const waitingFor = (questions: Awaited<ReturnType<typeof setup>>["questions"], count: number) =>
  until(async () => (await Effect.runPromise(questions.pendingSampling)).length >= count);

describe("a Modern server's Sampling request that asks the owner", () => {
  it("is kept with the round beside a form, shown with no deadline, and run when the round resumes", async () => {
    const { memory, questions, sampling, faux, session, sent, resumes, replies, told, run } =
      await setup();

    const submitted = await run();

    await waitingFor(questions, 1);

    // The call said it keeps questions and answers Sampling requests; both questions were kept, none run.
    expect(sent()[0]?.ctx.answers).toMatchObject({
      elicitation: true,
      sampling: true,
      defer: true,
    });
    expect(replies.map(([key, reply]) => [key, reply.kind])).toEqual([
      ["q1", "defer"],
      ["s1", "defer"],
    ]);
    expect(faux.state.callCount).toBe(0);

    const [card] = await Effect.runPromise(questions.pendingSampling);

    expect(card).toMatchObject({
      server: "Docs-Site",
      role: "small",
      waits: "owner",
      messages: [{ role: "user", text: "Summarize" }],
    });
    expect(card?.deadline).toBeGreaterThan(Date.now() + MCP_DEFERRED_DEADLINE_MS - 60_000);
    // A round with a form beside the request asks for input, which the Notification says, once.
    expect(told).toEqual([{ server: "Docs-Site" }]);

    const [form] = await Effect.runPromise(questions.pending);

    expect(form).toMatchObject({ message: "Who are you?", waits: "owner" });

    // The owner allows the request, and the call still waits for the form: nothing was sampled yet.
    await Effect.runPromise(questions.answerSampling(card?.id ?? "", { choice: "allow_call" }));
    expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]);
    expect(resumes).toEqual([]);
    expect(faux.state.callCount).toBe(0);

    await Effect.runPromise(
      questions.answer(form?.id ?? "", { action: "accept", content: { name: "Ada" } }),
    );
    await submitted.wait(context);

    // One resume carries the form's answer and the reply the model gave, and the call was sent once.
    expect(faux.state.callCount).toBe(1);
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({
      op: "resume",
      params: {
        resume: STATE,
        answers: {
          q1: { action: "accept", content: { name: "Ada" } },
          s1: {
            role: "assistant",
            content: { type: "text", text: "a summary" },
            stopReason: "endTurn",
          },
        },
      },
    });
    expect(sent().filter((each) => each.op === "tools/call")).toHaveLength(1);
    expect(await session.texts("toolResult")).toEqual(["done"]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        sampling: [
          expect.objectContaining({
            status: "answered",
            by: "owner",
            grant: "call",
            role: "small",
          }),
        ],
      }),
    ]);

    // The record is the one written while it waited, settled; nothing of the round is left.
    expect(await Effect.runPromise(sampling.records)).toEqual([
      expect.objectContaining({ id: card?.id, status: "answered", by: "owner", grant: "call" }),
    ]);
    expect(memory.keys().filter((key) => /^mcp-question:[dqp]/.test(key))).toEqual([]);
  });

  it("sinks the round when the owner refuses it: the form beside it is withdrawn, nothing is sent, and the call ends", async () => {
    const { memory, questions, faux, session, resumes, run } = await setup();
    const submitted = await run();

    await waitingFor(questions, 1);

    const [card] = await Effect.runPromise(questions.pendingSampling);
    const [form] = await Effect.runPromise(questions.pending);

    // The owner had answered the form already: the refusal withdraws it all the same.
    await Effect.runPromise(
      questions.answer(form?.id ?? "", { action: "accept", content: { name: "Ada" } }),
    );
    await Effect.runPromise(questions.answerSampling(card?.id ?? "", { choice: "refuse" }));
    await submitted.wait(context);

    expect(resumes).toEqual([]);
    expect(faux.state.callCount).toBe(0);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]);

    const [text] = await session.texts("toolResult");

    expect(text).toContain("Docs-Site asked for a model reply, which was refused by you.");
    expect(text).toContain("ends the call, which may have done part of its work");

    const [details] = await detailsOf(session);

    expect(details).toMatchObject({
      error: "sampling_refused",
      sampling: [expect.objectContaining({ status: "refused", by: "owner" })],
    });
    // The form is recorded as withdrawn by cloudpid, never as the owner's answer, and no sealed value is left.
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({ action: "cancel", by: "cloudpid", fields: [] }),
    ]);
    expect(memory.keys().filter((key) => /^mcp-question:[dqp]/.test(key))).toEqual([]);
  });

  it("is refused without asking when it fails a check, which ends the call locally too", async () => {
    const { questions, session, resumes, replies, run } = await setup({
      asks: [SAMPLE],
      over: "Spend limit of $1 reached",
    });

    const submitted = await run();

    await submitted.wait(context);

    expect(replies).toEqual([
      ["s1", { kind: "refused", message: "out of budget: Spend limit of $1 reached", code: -1 }],
    ]);
    expect(resumes).toEqual([]);
    expect(await Effect.runPromise(questions.pendingSampling)).toEqual([]);

    const [text] = await session.texts("toolResult");

    expect(text).toContain("which was refused: out of budget");
    expect((await detailsOf(session))[0]).toMatchObject({ error: "sampling_refused" });
  });

  it("is withdrawn when Stop aborts the waiting call, and its record settles refused", async () => {
    const { memory, questions, sampling: sampler, session, run } = await setup({ asks: [SAMPLE] });
    const submitted = await run();

    await waitingFor(questions, 1);
    await session.root.abort(context);
    await submitted.wait(context);
    await until(async () => (await Effect.runPromise(questions.pendingSampling)).length === 0);

    expect(memory.keys().filter((key) => /^mcp-question:[dqp]/.test(key))).toEqual([]);
    expect(await Effect.runPromise(sampler.records)).toEqual([
      expect.objectContaining({ status: "refused", by: "cloudpid", why: "unanswered" }),
    ]);
  });
});

/** The Session's questions over `storage`, with a Sampling request of `callId` kept in a round that is shown. */
const keepOne = async (
  memory: ReturnType<typeof memoryStorage>,
  callId: string,
  server = "docs",
) => {
  const questions = createMcpQuestions({
    storage: memory.storage,
    announce: () => Effect.void,
    announceSampling: () => Effect.void,
    redact: (shown) => Effect.succeed(shown),
    holdsSecret: () => Effect.succeed(false),
    vault: await testVault(),
  });

  const kept = await Effect.runPromise(
    questions.deferSampling({
      id: `${callId}:1`,
      key: "s1",
      sequence: 1,
      params: SAMPLE.params,
      card: {
        callId,
        conversationId: ROOT_CONVERSATION_ID,
        server,
        tool: "mcp__docs__search",
        role: "small",
        model: "m",
        roles: [{ role: "small", model: "m" }],
        messages: [],
        tools: [],
        notes: [],
      },
    }),
  );

  await Effect.runPromise(
    questions.commitRound({
      callId,
      round: 1,
      conn: "c",
      tool: "search",
      state: McpRoundState.Resume({ state: STATE }),
      asked: [],
    }),
  );
  await Effect.runPromise(questions.showRound(callId));

  return { questions, kept };
};

describe("the owner's choices on a Modern server's Sampling request", () => {
  it("keeps Allow for this call in the storage, so a later round of the call after a restart is not asked", async () => {
    const memory = memoryStorage();
    const { questions, kept } = await keepOne(memory, "call-1");

    expect(kept).toBe("deferred");
    expect(questions.samplingStanding("call-1", "docs")).toBeUndefined();

    await Effect.runPromise(questions.answerSampling("call-1:1", { choice: "allow_call" }));

    // A new instance of the Session finds the grant; the call's end takes it back.
    const later = createMcpQuestions({
      storage: memory.storage,
      announce: () => Effect.void,
      redact: (shown) => Effect.succeed(shown),
      holdsSecret: () => Effect.succeed(false),
    });

    expect(later.samplingStanding("call-1", "docs")).toEqual({ action: "allow", grant: "call" });
    expect(later.samplingStanding("call-2", "docs")).toBeUndefined();

    await Effect.runPromise(later.settleCall("call-1"));
    expect(later.samplingStanding("call-1", "docs")).toBeUndefined();
  });

  it("lets through the server's requests of other calls on Allow in this Session, and sinks them on Refuse in this Session", async () => {
    for (const choice of ["allow_session", "refuse_session"] as const) {
      const memory = memoryStorage();
      const { questions } = await keepOne(memory, "call-1");

      await keepOne(memory, "call-2");
      await keepOne(memory, "call-3", "other");

      expect(await Effect.runPromise(questions.pendingSampling)).toHaveLength(3);
      await Effect.runPromise(questions.answerSampling("call-1:1", { choice }));

      // The other server's request is the owner's to decide still.
      expect(await Effect.runPromise(questions.pendingSampling)).toEqual([
        expect.objectContaining({ callId: "call-3" }),
      ]);

      // Each call's round resumes with what was decided: run for an allow, refused for the refusal.
      const round = await Effect.runPromise(questions.awaitRound("call-2"));

      expect(round).toEqual([
        expect.objectContaining({
          key: "s1",
          sample: expect.objectContaining({
            decision:
              choice === "allow_session"
                ? { action: "allow", role: "small", grant: "session" }
                : expect.objectContaining({ action: "refuse", by: "owner" }),
          }),
        }),
      ]);
    }
  });

  it("refuses the answer of a Role the card does not offer, and a second answer to a request that ended", async () => {
    const memory = memoryStorage();
    const { questions } = await keepOne(memory, "call-1");

    await expect(
      Effect.runPromise(
        questions.answerSampling("call-1:1", { choice: "allow_call", role: "large" }),
      ),
    ).rejects.toThrow("That Role is not available");
    await Effect.runPromise(questions.answerSampling("call-1:1", { choice: "refuse" }));
    await expect(
      Effect.runPromise(questions.answerSampling("call-1:1", { choice: "allow_call" })),
    ).rejects.toThrow("This request ended");
  });

  it("is not kept past 1 MiB of parameters, or by a storage that cannot take it", async () => {
    const memory = memoryStorage();

    const big = await keepOne(memory, "call-1").then(async ({ questions }) =>
      Effect.runPromise(
        questions.deferSampling({
          id: "call-2:1",
          key: "s1",
          sequence: 1,
          params: { blob: "x".repeat(1024 * 1024 + 1) },
          card: {
            callId: "call-2",
            conversationId: ROOT_CONVERSATION_ID,
            server: "docs",
            tool: "t",
            role: "small",
            model: "m",
            roles: [],
            messages: [],
            tools: [],
            notes: [],
          },
        }),
      ),
    );

    expect(big).toBe("unrecorded");
  });
});
