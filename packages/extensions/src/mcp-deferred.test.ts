// A call of an MCP tool whose Modern server asks the owner for input (`docs/architecture/mcp-server-requests.md` →
// Questions, The waiting-question record, Elicitation requests): the form is kept for later, the call's round ends as
// `input_required`, the round is stored whole with its `ResumeState`, and once the owner answers, one resume is sent
// with the answer, which was sealed while it waited and never kept in the clear. Stop, a replaced Session's storage,
// and a round an earlier instance left behind. A scripted model on a Harness, and an in-memory host.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off anyUnknownInErrorContext:off globalJsonInEffect:off
import {
  type JsonObject,
  McpHostCallFailed,
  McpHostCompleted,
  McpHostInputRequired,
  type McpInputAnswer,
} from "@cloudpid/mcp/types";
import { ServerError } from "@cloudpid/mcp/types";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vitest";
import { makeMcpTools, memoryMcpToolsStore } from "./mcp.ts";
import { DOCS, detailsOf, startOf } from "./mcp.fixture.ts";
import { open } from "./mcp.fixture.ts";
import { type FakeMcpAnswer, fakeMcpHost } from "./mcp.testing.ts";
import {
  createMcpQuestions,
  MCP_DEFERRED_DEADLINE_MS,
  type McpQuestionAsk,
  McpRoundState,
  type McpQuestionStorage,
  type McpQuestionVault,
} from "./mcp/questions.ts";
import { openKeptVault } from "./secrets/vault.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

type Answer = typeof McpInputAnswer.Encoded;

/** A request the host was sent. */
type Sent = Parameters<FakeMcpAnswer>[0];

const SENTINEL = "sentinel-answer-41c9a";

const NAME_FORM: JsonObject = {
  type: "object",
  properties: { name: { type: "string", title: "Your name" } },
  required: ["name"],
};

const STATE = { v: 1, method: "tools/call", name: "search", arguments: {}, round: 1 };

const ask = (key = "7") => ({
  key,
  kind: "elicitation" as const,
  params: { message: "Who are you?", requestedSchema: NAME_FORM },
  mode: "deferrable" as const,
});

const DONE = McpHostCompleted.make({
  result: { kind: "inline", value: { content: [{ type: "text", text: "done" }] } },
});

/** A storage over a map, which throws on every write once `refuse` is set, as a replaced Session's does. */
const memoryStorage = () => {
  const map = new Map<string, unknown>();
  const puts: string[] = [];
  let refusing = false;
  let refusesPut = (_key: string) => false;

  const storage: McpQuestionStorage = {
    // SAFETY: the questions read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key, value) => {
      if (refusing || refusesPut(key)) throw new Error("This storage refuses every operation");

      map.set(key, structuredClone(value));
      puts.push(JSON.stringify(value));
    },
    delete: (key) => {
      if (refusing) throw new Error("This storage refuses every operation");

      return map.delete(key);
    },
  };

  return {
    storage,
    keys: () => [...map.keys()],
    dump: () => JSON.stringify([...map]),
    /** Every value written, as JSON, in order. */
    puts,
    refuse: () => {
      refusing = true;
    },
    /** Refuse only the writes of keys `refuses` names. */
    refusePuts: (refuses: (key: string) => boolean) => {
      refusesPut = refuses;
    },
  };
};

/** The vault the Session seals deferred answers in, under a test key. */
const testVault = async (): Promise<McpQuestionVault> => {
  const kept = await Effect.runPromise(
    openKeptVault("test-master-key-0123456789abcdef0123456789", "mcp-elicitation"),
  );

  return {
    seal: (id, text) => kept.seal({ owner: "s1", name: id }, text),
    open: (id, sealed) => kept.open({ owner: "s1", name: id }, sealed),
  };
};

/** Until `check` holds, for up to five seconds. */
const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 5000;

  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const setup = async (
  memory = memoryStorage(),
  server: NonNullable<Parameters<typeof fakeMcpHost>[0]>[number] = DOCS,
  tool: readonly [string, JsonObject] = ["mcp__docs_site__search", {}],
) => {
  const host = fakeMcpHost([server]);
  const told: string[] = [];
  const vault = await testVault();

  const make = () =>
    createMcpQuestions({
      storage: memory.storage,
      announce: () => Effect.void,
      notify: ({ server }) =>
        Effect.sync(() => {
          told.push(server);
        }),
      redact: (shown) => Effect.succeed(shown),
      holdsSecret: (text) => Effect.succeed(text === "my-secret"),
      vault,
    });

  const questions = make();
  const tools = makeMcpTools(host.client, memoryMcpToolsStore(), { slackMs: 0, questions });

  const session = await open((request) => (request.text === "go" ? call(tool) : answer("ok")));

  const sent = () => host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

  return { host, memory, questions, make, tools, told, session, sent };
};

/** A host whose call asks `ask()` and ends its round when deferred, then completes the resume, keeping what it was sent. */
const deferring =
  (seen: Answer[], resumes: Array<Sent>) =>
  async (input: Sent, hooks: Parameters<FakeMcpAnswer>[1]) => {
    if (input.op === "resume") {
      resumes.push(input);

      return DONE;
    }

    const reply = await hooks.onInput?.(ask());

    if (reply !== undefined) seen.push(reply);

    return reply?.kind === "defer"
      ? McpHostInputRequired.make({ requests: [ask()], resume: STATE, conn: "conn-docs" })
      : DONE;
  };

describe("a Modern server's form", () => {
  it("is kept for later: the round is stored, the owner answers, and one resume carries the answer", async () => {
    const { host, memory, questions, tools, told, session, sent } = await setup();
    const seen: Answer[] = [];
    const resumes: Array<Sent> = [];

    host.answer(deferring(seen, resumes));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

    // The call said it keeps questions, and the server was told the form waits.
    expect(sent()[0]?.ctx.answers).toMatchObject({ elicitation: true, defer: true });
    expect(seen).toEqual([{ kind: "defer" }]);

    // The card waits for the owner as long as the call does; its far `deadline` is for a client from before `waits`.
    const [request] = await Effect.runPromise(questions.pending);

    expect(request).toMatchObject({ server: "Docs-Site", message: "Who are you?", waits: "owner" });
    expect(request?.deadline).toBeGreaterThan(Date.now() + MCP_DEFERRED_DEADLINE_MS - 60_000);
    expect(told).toEqual(["Docs-Site"]);
    // The round is stored with its `ResumeState`, and no resume left yet.
    expect(memory.keys()).toEqual(
      expect.arrayContaining([
        "mcp-question:deferred",
        expect.stringMatching(/^mcp-question:d:/),
        expect.stringMatching(/^mcp-question:q:/),
      ]),
    );
    expect(resumes).toEqual([]);

    // A bad answer is bounced to the card; the round goes on waiting.
    await expect(
      Effect.runPromise(questions.answer(request?.id ?? "", { action: "accept", content: {} })),
    ).rejects.toThrow("name: is required");
    await expect(
      Effect.runPromise(
        questions.answer(request?.id ?? "", {
          action: "accept",
          content: { name: "my-secret" },
        }),
      ),
    ).rejects.toThrow("matches one of your Secrets");

    await Effect.runPromise(
      questions.answer(request?.id ?? "", { action: "accept", content: { name: SENTINEL } }),
    );
    await submitted.wait(context);

    // One resume, with the server's state as it came, its `conn`, and the answer.
    expect(resumes).toEqual([
      expect.objectContaining({
        op: "resume",
        server: "Docs-Site",
        params: {
          tool: "search",
          conn: "conn-docs",
          resume: STATE,
          answers: { "7": { action: "accept", content: { name: SENTINEL } } },
        },
      }),
    ]);
    expect(sent().filter((each) => each.op === "tools/call")).toHaveLength(1);
    expect(await session.texts("toolResult")).toEqual(["done"]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        elicitation: [
          { server: "Docs-Site", mode: "form", action: "accept", by: "owner", fields: ["name"] },
        ],
      }),
    ]);

    // Never a value in the clear, and nothing left of the round once it was resumed.
    expect(memory.dump()).not.toContain(SENTINEL);
    expect(memory.keys().filter((key) => /^mcp-question:[dq]/.test(key))).toEqual([]);
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({ action: "accept", by: "owner", fields: ["name"] }),
    ]);
    // A late answer is refused.
    await expect(
      Effect.runPromise(questions.answer(request?.id ?? "", { action: "decline" })),
    ).rejects.toThrow("This request ended");
  });

  describe("from a stdio server's process that restarts (#569)", () => {
    /** A host whose asks come from the processes in `spawns`, in order, and whose resume is answered by `resumed`. */
    const stdio = (spawns: string[], resumed: Awaited<ReturnType<FakeMcpAnswer>>) => {
      let asked = 0;

      return async (input: Sent, hooks: Parameters<FakeMcpAnswer>[1]) => {
        if (input.op === "resume") return resumed;

        await hooks.onInput?.(ask());
        asked += 1;

        return McpHostInputRequired.make({
          requests: [ask()],
          resume: STATE,
          conn: "conn-docs",
          spawn: spawns[asked - 1] ?? "spawn-x",
        });
      };
    };

    const failing = (spawn: string) =>
      McpHostCallFailed.make({
        error: ServerError.make({ message: "unknown request", code: -32602 }),
        spawn,
      });

    /** Runs the call, answers its first question and returns what the model got. */
    const answered = async (host: Awaited<ReturnType<typeof setup>>) => {
      await host.session.start(host.tools);

      const submitted = await host.session.root.submit({ type: "input", content: "go" }, context);

      await until(async () => (await Effect.runPromise(host.questions.pending)).length > 0);

      const [request] = await Effect.runPromise(host.questions.pending);

      await Effect.runPromise(
        host.questions.answer(request?.id ?? "", { action: "accept", content: { name: "Ada" } }),
      );
      await submitted.wait(context);

      return (await host.session.texts("toolResult")).join("\n");
    };

    it("tells the agent a resume that failed on another process, with the restart as the likely cause", async () => {
      const host = await setup();

      host.host.answer(stdio(["spawn-1"], failing("spawn-2")));

      expect(await answered(host)).toContain(
        "Docs-Site's process restarted while it waited for your answer, so it may have lost track; calling it again starts over",
      );
    });

    it("leaves a resume the same process answered as the server's own, error or not", async () => {
      const host = await setup();

      host.host.answer(stdio(["spawn-1"], failing("spawn-1")));

      const text = await answered(host);

      expect(text).toContain("unknown request");
      expect(text).not.toContain("restarted");
    });

    it("notes on the card of an ask that comes from another process than the last one's", async () => {
      const host = await setup();
      const { questions, session } = host;

      let asked = 0;

      // The call asks from one process, and its resume asks again from another.
      host.host.answer(async (_input, hooks) => {
        await hooks.onInput?.(ask(String(asked)));
        asked += 1;

        return asked <= 2
          ? McpHostInputRequired.make({
              requests: [ask(String(asked))],
              resume: STATE,
              conn: "conn-docs",
              spawn: `spawn-${asked}`,
            })
          : DONE;
      });
      await session.start(host.tools);
      await session.root.submit({ type: "input", content: "go" }, context);

      await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

      const [one] = await Effect.runPromise(questions.pending);

      expect(one?.notes).not.toContain("Docs-Site restarted since it last asked");

      await Effect.runPromise(
        questions.answer(one?.id ?? "", { action: "accept", content: { name: "Ada" } }),
      );
      await until(async () =>
        (await Effect.runPromise(questions.pending)).some((each) => each.id !== one?.id),
      );

      const again = (await Effect.runPromise(questions.pending)).find(
        (each) => each.id !== one?.id,
      );

      expect(again?.notes).toContain("Docs-Site restarted since it last asked");
    });
  });

  it("seals an answer given while the call waits, and the resume opens it", async () => {
    const { host, memory, questions, tools, session } = await setup();
    const resumes: Array<Sent> = [];
    let sealed = "";

    host.answer(async (input, hooks) => {
      if (input.op === "resume") {
        resumes.push(input);
        sealed = memory.dump();

        return DONE;
      }

      return deferring([], resumes)(input, hooks);
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

    const [request] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(
      questions.answer(request?.id ?? "", { action: "accept", content: { name: SENTINEL } }),
    );
    await submitted.wait(context);

    // The answer was kept sealed while it waited, never in the clear, and gone by the time the resume left.
    expect(memory.puts.some((put) => put.includes("ciphertext"))).toBe(true);
    expect(memory.puts.join("\n")).not.toContain(SENTINEL);
    expect(resumes).toHaveLength(1);
    expect(sealed).not.toContain(SENTINEL);
    expect(sealed).not.toContain("ciphertext");
  });

  it("sends a decline in the resume, and the agent is told", async () => {
    const { host, questions, tools, session } = await setup();
    const resumes: Array<Sent> = [];

    host.answer(deferring([], resumes));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

    const [request] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "decline" }));
    await submitted.wait(context);

    expect(resumes).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ answers: { "7": { action: "decline" } } }),
      }),
    ]);
    expect((await session.texts("toolResult")).join("\n")).toContain(
      "The user declined Docs-Site's request for input.",
    );
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        elicitation: [
          { server: "Docs-Site", mode: "form", action: "decline", by: "owner", fields: [] },
        ],
      }),
    ]);
  });

  it("is withdrawn when Stop aborts the waiting call, and no resume is sent", async () => {
    const { host, memory, questions, tools, session } = await setup();
    const resumes: Array<Sent> = [];

    host.answer(deferring([], resumes));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);
    await session.root.abort(context);
    await submitted.wait(context);

    expect(resumes).toEqual([]);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(memory.keys().filter((key) => /^mcp-question:[dq]/.test(key))).toEqual([]);
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({ action: "cancel", by: "cloudpid", reason: "Run stopped" }),
    ]);
  });

  it("is withdrawn at a look, with no request start, when its server was removed", async () => {
    const { host, questions, session, tools } = await setup();
    const resumes: Array<Sent> = [];

    // A host holds no request for a round kept for later, so it cannot tell the Session of a set change as it does a live
    // question; the Session looks when a client connects and at a request start, never on a timer.
    host.answer(deferring([], resumes));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);
    host.set([]);
    await Effect.runPromise(questions.lookAtRounds);
    await until(async () => (await Effect.runPromise(questions.pending)).length === 0);
    await submitted.wait(context);

    expect(resumes).toEqual([]);
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({
        action: "cancel",
        by: "cloudpid",
        reason: "Docs-Site was switched off, hidden or removed",
      }),
    ]);
  });

  it("is withdrawn at a look when its server's connection is no longer the one that asked", async () => {
    const { host, questions, session, tools } = await setup();

    // The round says it asked on `conn-docs`; the host's inventory has the server on `conn-Docs-Site`.
    host.answer(deferring([], []));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);
    await Effect.runPromise(questions.lookAtRounds);
    await until(async () => (await Effect.runPromise(questions.records)).length > 0);
    await submitted.wait(context);

    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({
        action: "cancel",
        by: "cloudpid",
        reason: "Docs-Site was changed",
      }),
    ]);
  });

  it("keeps waiting when a look cannot be made, because a host that fails says nothing of its servers", async () => {
    const { host, questions, session, tools } = await setup();

    host.answer(deferring([], []));
    await session.start(tools);

    await session.root.submit({ type: "input", content: "go" }, context);
    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

    host.set([]);
    host.fail(true);
    await Effect.runPromise(questions.lookAtRounds);

    expect(await Effect.runPromise(questions.pending)).toHaveLength(1);
    expect(await Effect.runPromise(questions.records)).toEqual([]);
  });

  it("is withdrawn at the next request start when its server's connection is no longer the one that asked", async () => {
    const { host, questions, session, tools } = await setup();

    host.answer(deferring([], []));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);
    // The look runs when a request starts, as the model's next one does.
    await Effect.runPromise(tools.requestStart(startOf(1)));
    await until(async () => (await Effect.runPromise(questions.pending)).length === 0);
    await submitted.wait(context);

    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({ by: "cloudpid", reason: "Docs-Site was changed" }),
    ]);
  });

  it('is withdrawn as "the script timed out", with no resume, when the codemode script that made the call passes its timeout_ms', async () => {
    const { host, questions, session, tools } = await setup(memoryStorage(), DOCS, [
      "codemode",
      {
        code: `// @options: {"timeout_ms": 300}\nawait tools.mcp__docs_site__search({}); text("done");`,
      },
    ]);

    const resumes: Array<Sent> = [];

    host.answer(deferring([], resumes));
    await session.start(tools, startOf(1, { offered: ["codemode"] }));
    await session.prompt("go");

    // The script's end settled the round, and its abort ended the call: nothing was resumed.
    expect(resumes).toEqual([]);
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({ action: "cancel", by: "cloudpid", reason: "the script timed out" }),
    ]);
  });

  it("is cancelled in the round's retry when the Session's storage cannot keep it (a replaced Session)", async () => {
    const memory = memoryStorage();
    const { host, tools, session } = await setup(memory);
    const seen: Answer[] = [];
    const resumes: Array<Sent> = [];

    host.answer(async (input, hooks) => {
      memory.refuse();

      return deferring(seen, resumes)(input, hooks);
    });
    await session.start(tools);
    await session.prompt("go");

    // The server is told `cancel`, never left with a question nobody can answer, and its call goes on.
    expect(seen).toEqual([{ kind: "answered", result: { action: "cancel" } }]);
    expect(resumes).toEqual([]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        elicitation: [
          {
            server: "Docs-Site",
            mode: "form",
            action: "cancel",
            by: "cloudpid",
            reason: "cloudpid could not record the question",
            fields: [],
          },
        ],
      }),
    ]);
  });

  it("is answered live, as a Legacy one, when the host does not resume", async () => {
    const { host, questions, tools, session, sent } = await setup();
    const seen: Answer[] = [];

    host.features(["inventory", "call"]);
    host.answer(deferring(seen, []));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

    const [request] = await Effect.runPromise(questions.pending);

    expect(request?.deadline).toBeGreaterThan(0);
    expect(request).not.toHaveProperty("waits");
    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "decline" }));
    await submitted.wait(context);

    expect(sent()[0]?.ctx.answers).not.toHaveProperty("defer");
    expect(seen).toEqual([{ kind: "answered", result: { action: "decline" } }]);
  });

  it("is answered live on a read of a resource, never deferred: a read keeps only a Legacy -32042's pages", async () => {
    const files = { name: "files", exposure: "direct", resources: true, tools: [] };

    const { host, questions, tools, session, sent } = await setup(memoryStorage(), files, [
      "read_mcp_resource",
      { server: "files", uri: "file:///a.txt" },
    ]);

    const seen: Answer[] = [];

    host.answer(async (_input, hooks) => {
      const reply = await hooks.onInput?.(ask());

      if (reply !== undefined) seen.push(reply);

      return McpHostCompleted.make({
        result: { kind: "inline", value: { contents: [{ uri: "file:///a.txt", text: "read" }] } },
      });
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

    const [request] = await Effect.runPromise(questions.pending);

    // A live card: a countdown, not `waits`.
    expect(request).not.toHaveProperty("waits");
    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "decline" }));
    await submitted.wait(context);

    // The host resumes and resends, yet the Modern form was answered live: the read's core never defers one, and the
    // Session keeps for later only a page (a Legacy `-32042`'s), which this form is not.
    expect(sent()).toEqual([expect.objectContaining({ op: "resources/read", server: "files" })]);
    expect(sent()[0]?.ctx.answers).toMatchObject({ elicitation: true, defer: true, pages: true });
    expect(seen).toEqual([{ kind: "answered", result: { action: "decline" } }]);
    expect(await session.texts("toolResult")).toEqual([expect.stringContaining("read")]);
  });

  it("keeps a round an earlier instance stored on its cards, and drops it once the Session is idle with no call for it", async () => {
    const { host, memory, questions, make, tools, session } = await setup();

    host.answer(deferring([], []));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await Effect.runPromise(questions.pending)).length > 0);

    // A new instance over the same storage: the card is still there, and an answer is kept for the call's rerun.
    const later = make();
    const [request] = await Effect.runPromise(later.pending);

    expect(request).toMatchObject({ server: "Docs-Site" });
    // What a rerun of the call would find (an instance of its own, since finding it marks the call as this instance's).
    expect(await Effect.runPromise(make().deferredRound(request?.callId ?? ""))).toMatchObject({
      round: 1,
      conn: "conn-docs",
      tool: "search",
      state: McpRoundState.Resume({ state: STATE }),
    });

    // No call of the new instance waits for it: the Session going idle withdraws it.
    await Effect.runPromise(later.dropAbandoned);

    expect(await Effect.runPromise(later.pending)).toEqual([]);
    expect(memory.keys().filter((key) => /^mcp-question:[dq]/.test(key))).toEqual([]);
    expect(await Effect.runPromise(later.records)).toEqual([
      expect.objectContaining({
        action: "cancel",
        by: "cloudpid",
        reason: "the server's call ended",
      }),
    ]);

    await session.root.abort(context);
    await submitted.wait(context);
  });
});

describe("a deferred round in the Session's storage", () => {
  const ASK: McpQuestionAsk = {
    key: "7",
    callId: "call-9",
    conversationId: ROOT_CONVERSATION_ID,
    server: "Docs-Site",
    tool: "mcp__docs_site__search",
    message: "Who are you?",
    form: { fields: [{ kind: "text", name: "name", required: true }] },
    notes: [],
  };

  const ROUND = {
    callId: ASK.callId,
    round: 1,
    conn: "conn-docs",
    tool: "search",
    state: McpRoundState.Resume({ state: STATE }),
    asked: [],
  };

  const service = async (memory = memoryStorage(), told: string[] = []) => {
    const vault = await testVault();

    const questions = createMcpQuestions({
      storage: memory.storage,
      announce: () => Effect.void,
      notify: ({ server }) =>
        Effect.sync(() => {
          told.push(server);
        }),
      redact: (shown) => Effect.succeed(shown),
      holdsSecret: () => Effect.succeed(false),
      vault,
    });

    return { questions, told, memory };
  };

  it("shows its cards and tells the owner only once shown, after the call marks the round", async () => {
    const { questions, told } = await service();

    expect(await Effect.runPromise(questions.defer(ASK))).toBe("deferred");
    await Effect.runPromise(questions.commitRound(ROUND));

    // Stored, not shown: a rerun that finds no `mcp.wait.1` settles the call, and no card was ever seen.
    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(told).toEqual([]);

    await Effect.runPromise(questions.showRound(ASK.callId));
    await Effect.runPromise(questions.showRound(ASK.callId));

    expect(await Effect.runPromise(questions.pending)).toEqual([
      expect.objectContaining({ callId: ASK.callId, waits: "owner" }),
    ]);
    // Told once, however often it is shown (the push is in the background).
    await until(async () => told.length > 0);
    expect(told).toEqual(["Docs-Site"]);
  });

  it("marks the call's wait once, after its round is stored, and not for a round answered already", async () => {
    const { questions } = await service();
    const marks: (readonly string[])[] = [];

    /** The call's wait mark: the questions waiting when it was made. */
    const marking = Effect.flatMap(questions.pending, (pending) =>
      Effect.sync(() => void marks.push(pending.map((question) => question.id))),
    );

    await Effect.runPromise(questions.defer(ASK));
    await Effect.runPromise(questions.defer({ ...ASK, key: "8", message: "And your team?" }));
    await Effect.runPromise(questions.commitRound(ROUND));
    await Effect.runPromise(questions.showRound(ASK.callId));

    const waiting = Effect.runPromise(questions.awaitRound(ASK.callId, marking));

    await until(async () => marks.length > 0);
    // The round's first answer leaves the call waiting for the other: still one mark.
    await Effect.runPromise(questions.answer("call-9:1", { action: "decline" }));
    await Effect.runPromise(questions.answer("call-9:2", { action: "decline" }));
    await waiting;

    // A rerun that finds every answer takes them, and has no wait to mark.
    await Effect.runPromise(questions.awaitRound(ASK.callId, marking));

    expect(marks).toEqual([["call-9:1", "call-9:2"]]);
  });

  it("withdraws the round when Stop comes while the call marks its wait", async () => {
    const { questions, memory } = await service();
    const marking = Promise.withResolvers<void>();

    await Effect.runPromise(questions.defer(ASK));
    await Effect.runPromise(questions.commitRound(ROUND));
    await Effect.runPromise(questions.showRound(ASK.callId));

    // A mark that never ends, as one the storage holds up.
    const waiting = Effect.runFork(
      questions.awaitRound(
        ASK.callId,
        Effect.sync(() => marking.resolve()).pipe(Effect.andThen(Effect.never)),
      ),
    );

    await marking.promise;
    await Effect.runPromise(waiting.pipe(Fiber.interrupt));

    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(memory.keys().filter((key) => /^mcp-question:[dq]/.test(key))).toEqual([]);
  });

  it("leaves a round whose state is a later build's alone: it is not resumed as a call's", async () => {
    const { questions, memory } = await service();

    await Effect.runPromise(questions.defer(ASK));
    await Effect.runPromise(questions.commitRound(ROUND));
    await Effect.runPromise(questions.showRound(ASK.callId));

    expect(await Effect.runPromise(questions.deferredRound(ASK.callId))).toBeDefined();

    // A later build stored the round under a state this one does not know.
    const key = `mcp-question:d:${ASK.callId}`;
    const stored = memory.storage.get<{ readonly round: object }>(key);

    expect(stored).toBeDefined();
    memory.storage.put(key, {
      ...stored,
      round: { ...stored?.round, state: "from-a-later-build" },
    });

    expect(await Effect.runPromise(questions.deferredRound(ASK.callId))).toBeUndefined();
  });

  it("keeps each question under a key of its own, and the call's record holds no form or answer", async () => {
    const { questions, memory } = await service();

    await Effect.runPromise(questions.defer(ASK));
    await Effect.runPromise(questions.defer({ ...ASK, key: "8", message: "And your team?" }));
    await Effect.runPromise(questions.commitRound(ROUND));
    await Effect.runPromise(questions.showRound(ASK.callId));

    const [first] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(
      questions.answer(first?.id ?? "", { action: "accept", content: { name: SENTINEL } }),
    );

    expect(memory.keys().filter((key) => key.startsWith("mcp-question:q:"))).toEqual([
      "mcp-question:q:call-9:1",
      "mcp-question:q:call-9:2",
    ]);

    const record = JSON.stringify(memory.storage.get("mcp-question:d:call-9"));

    expect(record).not.toContain("Who are you?");
    expect(record).not.toContain("ciphertext");
    expect(JSON.stringify(memory.storage.get("mcp-question:q:call-9:1"))).toContain("ciphertext");
  });

  it("reads a question stored without a kind as an elicitation", async () => {
    const { questions, memory } = await service();

    await Effect.runPromise(questions.defer(ASK));
    await Effect.runPromise(questions.commitRound(ROUND));
    await Effect.runPromise(questions.showRound(ASK.callId));

    const key = "mcp-question:q:call-9:1";
    const stored = memory.storage.get<{ readonly kind?: string }>(key) ?? {};

    expect(stored).toMatchObject({ kind: "elicitation" });

    const { kind: _kind, ...unkinded } = stored;

    memory.storage.put(key, unkinded);

    expect(await Effect.runPromise(questions.pending)).toEqual([
      expect.objectContaining({ id: "call-9:1" }),
    ]);
    expect(await Effect.runPromise(questions.deferredRound(ASK.callId))).toMatchObject({
      round: 1,
    });
    await Effect.runPromise(questions.answer("call-9:1", { action: "decline" }));
    expect(await Effect.runPromise(questions.awaitRound(ASK.callId))).toEqual([
      { kind: "form", key: "7", outcome: { action: "decline", by: "owner" }, fields: [] },
    ]);
  });

  it("neither shows nor waits again for a round with a question of a kind this build does not know", async () => {
    const { questions, memory } = await service();

    await Effect.runPromise(questions.defer(ASK));
    await Effect.runPromise(questions.commitRound(ROUND));
    await Effect.runPromise(questions.showRound(ASK.callId));

    const key = "mcp-question:q:call-9:1";

    memory.storage.put(key, { ...memory.storage.get<object>(key), kind: "a-later-kind" });

    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(await Effect.runPromise(questions.deferredRound(ASK.callId))).toBeUndefined();
    await expect(
      Effect.runPromise(questions.answer("call-9:1", { action: "decline" })),
    ).rejects.toThrow("This request ended");
  });

  it("shows none of a round that holds a question of an unknown kind beside a form, nor takes an answer to the form", async () => {
    const { questions, memory } = await service();

    await Effect.runPromise(questions.defer(ASK));
    await Effect.runPromise(questions.defer({ ...ASK, key: "8" }));
    await Effect.runPromise(questions.commitRound(ROUND));
    await Effect.runPromise(questions.showRound(ASK.callId));

    const key = "mcp-question:q:call-9:2";

    memory.storage.put(key, { ...memory.storage.get<object>(key), kind: "a-later-kind" });

    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    await expect(
      Effect.runPromise(questions.answer("call-9:1", { action: "decline" })),
    ).rejects.toThrow("This request ended");
    expect(await Effect.runPromise(questions.deferredRound(ASK.callId))).toBeUndefined();
  });

  /** The pushes still running in the background have had their turn. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("tells the owner of a round once: a rerun in a new instance does not tell again", async () => {
    const memory = memoryStorage();
    const told: string[] = [];
    const first = await service(memory, told);

    await Effect.runPromise(first.questions.defer(ASK));
    await Effect.runPromise(first.questions.commitRound(ROUND));
    await Effect.runPromise(first.questions.showRound(ASK.callId));
    await settled();

    expect(told).toEqual(["Docs-Site"]);

    // The rerun's instance finds the round shown, and shows it again without telling the owner.
    const { questions } = await service(memory, told);

    expect(await Effect.runPromise(questions.deferredRound(ASK.callId))).toMatchObject({
      round: 1,
    });
    await Effect.runPromise(questions.showRound(ASK.callId));
    await settled();

    expect(await Effect.runPromise(questions.pending)).toHaveLength(1);
    expect(told).toEqual(["Docs-Site"]);
  });

  it("tells the owner once of a round its instance stored and marked but never showed", async () => {
    const memory = memoryStorage();
    const told: string[] = [];
    const first = await service(memory, told);

    await Effect.runPromise(first.questions.defer(ASK));
    await Effect.runPromise(first.questions.commitRound(ROUND));

    // The instance went before `showRound`; the rerun's shows the round, and tells of it.
    const { questions } = await service(memory, told);

    expect(await Effect.runPromise(questions.pending)).toEqual([]);
    expect(await Effect.runPromise(questions.deferredRound(ASK.callId))).toMatchObject({
      round: 1,
    });
    await Effect.runPromise(questions.showRound(ASK.callId));
    await settled();

    expect(await Effect.runPromise(questions.pending)).toHaveLength(1);
    expect(told).toEqual(["Docs-Site"]);
  });

  it("leaves no key behind when the storage refuses the call's record or its question", async () => {
    for (const refused of [/^mcp-question:d:/, /^mcp-question:q:/]) {
      const memory = memoryStorage();
      const { questions } = await service(memory);

      memory.refusePuts((key) => refused.test(key));

      expect(await Effect.runPromise(questions.defer(ASK))).toBe("unrecorded");
      // Only its settled record, which says why it was cancelled.
      expect(memory.keys().filter((key) => key.startsWith("mcp-question:"))).toEqual([
        "mcp-question:s:call-9:1",
        "mcp-question:settled",
      ]);
    }
  });

  it("leaves no key behind when the storage refuses the round or its `ResumeState`", async () => {
    for (const refused of [/^mcp-question:d:call-9$/, /^mcp-question:d:call-9:\d+$/]) {
      const memory = memoryStorage();
      const { questions } = await service(memory);

      await Effect.runPromise(questions.defer(ASK));
      memory.refusePuts((key) => refused.test(key));

      await expect(Effect.runPromise(questions.commitRound(ROUND))).rejects.toThrow(
        "cloudpid could not record the question",
      );

      // The call ends as one that may have run, and its end drops what was stored.
      await Effect.runPromise(questions.settleCall(ASK.callId));

      expect(memory.keys().filter((key) => /^mcp-question:[dq]/.test(key))).toEqual([]);
    }
  });

  it("refuses an answer once the call's round is settled, and writes nothing back", async () => {
    const memory = memoryStorage();
    const { questions } = await service(memory);

    await Effect.runPromise(questions.defer(ASK));
    await Effect.runPromise(questions.commitRound(ROUND));
    await Effect.runPromise(questions.showRound(ASK.callId));
    await Effect.runPromise(questions.settleCall(ASK.callId));

    await expect(
      Effect.runPromise(
        questions.answer("call-9:1", { action: "accept", content: { name: SENTINEL } }),
      ),
    ).rejects.toThrow("This request ended");
    expect(memory.keys().filter((key) => /^mcp-question:[dq]/.test(key))).toEqual([]);
  });
});
