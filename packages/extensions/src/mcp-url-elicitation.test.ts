// A page an MCP server asks the owner to open (`docs/architecture/mcp-server-requests.md` → Elicitation requests, URL
// mode): a Legacy server's, during its call (Open answers `accept` at once, the card stays until the page is finished),
// and a Legacy `-32042`, which ends the call, so it is kept for the owner like a Modern round and the call is sent again
// once they are done ("Done, try again"). The addresses cloudpid declines unseen, and what the agent and `details` read.
// A scripted model on a Harness, and an in-memory host. pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off anyUnknownInErrorContext:off preferSchemaOverJson:off
import {
  MCP_HOST_FEATURES,
  McpHostCompleted,
  McpHostPagesRequired,
  type McpInputAnswer,
} from "@cloudpid/mcp/types";
import type { Context, JsonValue } from "@earendil-works/chord";
import { ROOT_CONVERSATION_ID, type ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { makeMcpTools, mcpExtension, memoryMcpToolsStore } from "./mcp.ts";
import { DOCS, detailsOf, open } from "./mcp.fixture.ts";
import { type FakeMcpAnswer, fakeMcpHost } from "./mcp.testing.ts";
import {
  createMcpQuestions,
  type McpQuestionAsk,
  McpRoundState,
  type McpQuestionStorage,
  type McpQuestionVault,
} from "./mcp/questions.ts";
import {
  MCP_PAGE_KEY_CHARS,
  MCP_PAGES_KEPT,
  pageKeyOf,
  questionBasics,
} from "./mcp/question-records.ts";
import { openKeptVault } from "./secrets/vault.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

type Answer = typeof McpInputAnswer.Encoded;

type Sent = Parameters<FakeMcpAnswer>[0];

const STATE = {
  v: 1,
  method: "tools/call",
  name: "search",
  arguments: {},
  deferred: ["page-1"],
  round: 1,
  message: "Authorization needed",
};

const PAGE = "https://auth.example.com/authorize?state=abc";

const visit = (
  url = PAGE,
  mode: "live" | "deferrable" = "live",
  key = "page-1",
  message = "Authorize the app",
) => ({
  key,
  kind: "elicitation" as const,
  params: { mode: "url", elicitationId: key, url, message },
  mode,
});

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

  return { storage, keys: () => [...map.keys()], dump: () => JSON.stringify([...map]) };
};

const testVault = async (): Promise<McpQuestionVault> => {
  const kept = await Effect.runPromise(
    openKeptVault("test-master-key-0123456789abcdef0123456789", "mcp-elicitation"),
  );

  return {
    seal: (id, text) => kept.seal({ owner: "s1", name: id }, text),
    open: (id, sealed) => kept.open({ owner: "s1", name: id }, sealed),
  };
};

const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 5000;

  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out waiting");

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const setup = async (finishedShownMs?: number) => {
  const host = fakeMcpHost([DOCS]);
  const memory = memoryStorage();
  const told: Array<{ server: string; page?: true }> = [];
  const vault = await testVault();

  const questions = createMcpQuestions({
    storage: memory.storage,
    announce: () => Effect.void,
    notify: (who) =>
      Effect.sync(() => {
        told.push(who);
      }),
    redact: (shown) => Effect.succeed(shown),
    holdsSecret: () => Effect.succeed(false),
    ownHost: (hostname) => hostname === "pi.ianpascoe.dev",
    vault,
    finishedShownMs,
  });

  const tools = makeMcpTools(host.client, memoryMcpToolsStore(), { slackMs: 0, questions });

  const session = await open((request) =>
    request.text === "go" ? call(["mcp__docs_site__search", {}]) : answer("ok"),
  );

  const pending = () => Effect.runPromise(questions.pending);

  return { host, memory, questions, tools, told, session, pending };
};

describe("a Legacy server's page during its call", () => {
  it("is shown as a card; Open answers the server accept at once and the card stays until the page is finished", async () => {
    const { host, questions, tools, session, pending } = await setup(150);
    const replies: Array<Answer> = [];
    const finished: Array<string> = [];

    host.answer(async (_input, hooks) => {
      const reply = await hooks.onInput?.(visit());

      if (reply !== undefined) replies.push(reply);

      // The server goes on once the owner is at the page, and says when they are done there.
      await until(async () => (await pending()).every((each) => each.page?.opened === true));
      await hooks.onInputComplete?.("page-1");
      finished.push("page-1");

      // The server's result follows its `complete` at once, as a real server's does.
      return DONE;
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length > 0);

    const [request] = await pending();

    expect(request).toMatchObject({
      server: "Docs-Site",
      message: "Authorize the app",
      form: { fields: [] },
      page: {
        url: PAGE,
        host: "auth.example.com",
        domain: "example.com",
        opened: false,
      },
    });
    expect(request?.page).not.toHaveProperty("retry");

    // Done is for a call that is sent again; this server goes on by itself.
    await expect(
      Effect.runPromise(questions.answer(request?.id ?? "", { action: "done" })),
    ).rejects.toThrow("goes on by itself");
    await expect(
      Effect.runPromise(questions.answer(request?.id ?? "", { action: "accept", content: {} })),
    ).rejects.toThrow("a page to open");

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "opened" }));
    await submitted.wait(context);

    expect(replies).toEqual([{ kind: "answered", result: { action: "accept" } }]);
    expect(finished).toEqual(["page-1"]);

    // The call is over, and its card still says "Finished at <host>" for a moment before it goes.
    expect((await pending()).map((each) => each.page)).toEqual([
      expect.objectContaining({ host: "auth.example.com", opened: true, finished: true }),
    ]);
    await until(async () => (await pending()).length === 0);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        elicitation: [
          {
            server: "Docs-Site",
            mode: "url",
            action: "accept",
            by: "owner",
            fields: [],
            host: "auth.example.com",
            finished: true,
          },
        ],
      }),
    ]);
    // The record names the origin of the page, never the rest of its address.
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({
        mode: "url",
        action: "accept",
        page: { origin: "https://auth.example.com" },
      }),
    ]);
    expect(JSON.stringify(await Effect.runPromise(questions.records))).not.toContain("state=abc");
  });

  it("can be declined or cancelled until it is opened", async () => {
    const { host, questions, tools, session, pending } = await setup();
    const replies: Array<Answer> = [];

    host.answer(async (_input, hooks) => {
      const reply = await hooks.onInput?.(visit());

      if (reply !== undefined) replies.push(reply);

      return DONE;
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length > 0);

    const [request] = await pending();

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "decline" }));
    await submitted.wait(context);

    expect(replies).toEqual([{ kind: "answered", result: { action: "decline" } }]);
    expect((await session.texts("toolResult")).join("\n")).toContain(
      "The user declined Docs-Site's request for input.",
    );
  });

  it.each([
    ["http://auth.example.com/authorize", "the page isn't served over HTTPS"],
    ["https://user:pw@auth.example.com/", "the address has a username or password in it"],
    ["https://localhost:8443/", "the page is on a local or private address"],
    ["https://192.168.1.5/", "the page is on a local or private address"],
    ["https://pi.ianpascoe.dev/oauth/mcp/start", "the page is on one of cloudpid's own hosts"],
  ])("declines %s unseen, and tells the server and the agent why", async (url, reason) => {
    const { host, questions, tools, session, pending, told } = await setup();
    const replies: Array<Answer> = [];

    host.answer(async (_input, hooks) => {
      const reply = await hooks.onInput?.(visit(url));

      if (reply !== undefined) replies.push(reply);

      return DONE;
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await submitted.wait(context);

    expect(replies).toEqual([{ kind: "answered", result: { action: "decline" } }]);
    expect(await pending()).toEqual([]);
    expect(told).toEqual([]);
    expect((await session.texts("toolResult")).join("\n")).toContain(
      `cloudpid declined Docs-Site's request for input: ${reason}`,
    );

    const [recorded] = await Effect.runPromise(questions.records);

    expect(recorded).toMatchObject({ mode: "url", action: "decline", by: "cloudpid", reason });
  });

  it("refuses an address that is not one with -32602, and a request with none", async () => {
    const { host, tools, session } = await setup();
    const replies: Array<Answer> = [];

    host.answer(async (_input, hooks) => {
      const bad = await hooks.onInput?.(visit("not a url"));

      const none = await hooks.onInput?.({
        key: "x",
        kind: "elicitation",
        params: { mode: "url", message: "Open it" },
        mode: "live",
      });

      replies.push(...[bad, none].filter((each): each is Answer => each !== undefined));

      return DONE;
    });
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await submitted.wait(context);

    expect(replies).toEqual([
      {
        kind: "refused",
        message: "unsupported elicitation form: the address is not a valid URL",
        code: -32602,
      },
      {
        kind: "refused",
        message: "unsupported elicitation form: the request has no page address",
        code: -32602,
      },
    ]);
  });
});

/** A host whose call is answered `-32042`: its pages are kept (`deferrable`), and the call is sent again by `resend`. */
const gated =
  (resumes: Array<Sent>, pages: ReadonlyArray<string>, again?: () => boolean) =>
  async (input: Sent, hooks: Parameters<FakeMcpAnswer>[1]) => {
    if (input.op === "resend") {
      resumes.push(input);

      if (again?.() === true) {
        const replies = await Promise.all(
          pages.map(async (key) => hooks.onInput?.(visit(PAGE, "deferrable", key))),
        );

        return replies.every((reply) => reply?.kind === "defer")
          ? McpHostPagesRequired.make({
              requests: pages.map((key) => visit(PAGE, "deferrable", key)),
              message: "Authorization needed",
              resend: { ...STATE, deferred: pages, round: 2 },
              conn: "conn-docs",
            })
          : DONE;
      }

      return DONE;
    }

    const replies = await Promise.all(
      pages.map(async (key) => hooks.onInput?.(visit(PAGE, "deferrable", key))),
    );

    return replies.every((reply) => reply?.kind === "defer")
      ? McpHostPagesRequired.make({
          requests: pages.map((key) => visit(PAGE, "deferrable", key)),
          message: "Authorization needed",
          resend: { ...STATE, deferred: pages },
          conn: "conn-docs",
        })
      : DONE;
  };

describe("a Legacy server's -32042", () => {
  it("is kept for the owner, and the call is sent again once every page is opened and Done is pressed", async () => {
    const { host, memory, questions, tools, told, session, pending } = await setup();
    const resumes: Array<Sent> = [];

    host.answer(gated(resumes, ["page-1", "page-2"]));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length === 2);

    const requests = await pending();

    // One card per page, each saying the call is sent again; one Notification, and it says a page.
    expect(requests.map((each) => each.page)).toEqual([
      expect.objectContaining({ opened: false, retry: true, host: "auth.example.com" }),
      expect.objectContaining({ opened: false, retry: true }),
    ]);
    expect(requests.every((each) => each.waits === "owner")).toBe(true);
    expect(told).toEqual([{ server: "Docs-Site", page: true }]);

    // Done waits for every page to be opened, from any client.
    await Effect.runPromise(questions.answer(requests[0]?.id ?? "", { action: "opened" }));
    await expect(
      Effect.runPromise(questions.answer(requests[0]?.id ?? "", { action: "done" })),
    ).rejects.toThrow("Open every page first");
    expect(resumes).toEqual([]);

    await Effect.runPromise(questions.answer(requests[1]?.id ?? "", { action: "opened" }));
    await Effect.runPromise(questions.answer(requests[0]?.id ?? "", { action: "done" }));
    await submitted.wait(context);

    // One resend, answering every page; nothing but the owner's accept goes with it.
    expect(resumes).toEqual([
      expect.objectContaining({
        op: "resend",
        params: expect.objectContaining({
          conn: "conn-docs",
          answers: {
            "page-1": { action: "accept", content: {} },
            "page-2": { action: "accept", content: {} },
          },
        }),
      }),
    ]);
    expect(await session.texts("toolResult")).toEqual(["done"]);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({
        elicitation: [
          expect.objectContaining({
            mode: "url",
            action: "accept",
            by: "owner",
            host: "auth.example.com",
          }),
          expect.objectContaining({ mode: "url", action: "accept", by: "owner" }),
        ],
      }),
    ]);
    expect(memory.keys().filter((key) => /^mcp-question:[dq]/.test(key))).toEqual([]);
    expect(await Effect.runPromise(questions.records)).toEqual([
      expect.objectContaining({ mode: "url", era: "legacy", action: "accept" }),
      expect.objectContaining({ mode: "url", era: "legacy", action: "accept" }),
    ]);
  });

  it("answers the whole round the same when one page is declined, and the agent is told", async () => {
    const { host, questions, tools, session, pending } = await setup();
    const resumes: Array<Sent> = [];

    host.answer(gated(resumes, ["page-1", "page-2"]));
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length === 2);

    const [first] = await pending();

    await Effect.runPromise(questions.answer(first?.id ?? "", { action: "decline" }));
    await submitted.wait(context);

    expect(resumes).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          answers: { "page-1": { action: "decline" }, "page-2": { action: "decline" } },
        }),
      }),
    ]);
    expect((await session.texts("toolResult")).join("\n")).toContain(
      "The user declined Docs-Site's request for input.",
    );
  });

  it("brings a page opened before back as not finished, with no new Notification and no count toward the cap", async () => {
    const { host, questions, tools, told, session, pending } = await setup();
    const resumes: Array<Sent> = [];
    let asksAgain = true;

    host.answer(
      gated(resumes, ["page-1"], () => {
        const again = asksAgain;

        asksAgain = false;

        return again;
      }),
    );
    await session.start(tools);

    const submitted = await session.root.submit({ type: "input", content: "go" }, context);

    await until(async () => (await pending()).length === 1);

    const [first] = await pending();

    await Effect.runPromise(questions.answer(first?.id ?? "", { action: "opened" }));
    await Effect.runPromise(questions.answer(first?.id ?? "", { action: "done" }));
    await until(async () => (await pending()).some((each) => each.page?.again === true));

    const [second] = await pending();

    expect(second?.id).not.toEqual(first?.id);
    expect(second?.page).toMatchObject({ opened: false, retry: true, again: true });
    expect(told).toHaveLength(1);

    await Effect.runPromise(questions.answer(second?.id ?? "", { action: "opened" }));
    await Effect.runPromise(questions.answer(second?.id ?? "", { action: "done" }));
    await submitted.wait(context);

    expect(resumes).toHaveLength(2);
    expect(await session.texts("toolResult")).toEqual(["done"]);
  });
});

/** pi-durable's `memo` over a map: a read, or a write whose first value wins. */
const memoryMemo = (memos: Map<string, JsonValue>) => {
  async function memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
  async function memo<T extends JsonValue>(
    name: string,
    candidate: T,
    context: Context,
  ): Promise<T>;
  async function memo(
    name: string,
    ...rest: ReadonlyArray<JsonValue | Context>
  ): Promise<JsonValue | undefined> {
    if (rest.length === 1) return memos.get(name);

    // SAFETY: a write's candidate is a `JsonValue`, as the overloads take it.
    const candidate = rest[0] as JsonValue;

    if (!memos.has(name)) memos.set(name, candidate);

    return memos.get(name);
  }

  return memo;
};

/** The parts of a tool's api that `execute` reads, as the api. */
const apiWith = (parts: Partial<ToolExecutionApi>): ToolExecutionApi =>
  // SAFETY: only what the `mcp` tools read of the api is given: the call's ids, its memos, task, details and environment.
  parts as ToolExecutionApi;

/**
 * A call's instances over one storage and one set of memos, the way a restart makes them: each `instance` is a Session
 * instance's questions and the tool a rerun of the call executes (`docs/architecture/mcp-server-requests.md` → The
 * waiting-question record, Phased replay). The host answers `-32042` to the call and `done` to its resend.
 */
const restartable = async () => {
  const memory = memoryStorage();
  const memos = new Map<string, JsonValue>();
  const told: Array<{ server: string; page?: true }> = [];
  const vault = await testVault();
  const host = fakeMcpHost([DOCS]);
  const sent: Array<Sent> = [];

  host.answer(async (input, hooks) => {
    sent.push(input);

    // The resend's marker is durable before the resend leaves.
    if (input.op === "resend") return DONE;

    await hooks.onInput?.(visit(PAGE, "deferrable"));

    return McpHostPagesRequired.make({
      requests: [visit(PAGE, "deferrable")],
      message: "Authorization needed",
      resend: STATE,
      conn: "conn-docs",
    });
  });

  const instance = () => {
    const questions = createMcpQuestions({
      storage: memory.storage,
      announce: () => Effect.void,
      notify: (who) =>
        Effect.sync(() => {
          told.push(who);
        }),
      redact: (shown) => Effect.succeed(shown),
      holdsSecret: () => Effect.succeed(false),
      vault,
    });

    const extension = mcpExtension(
      {
        servers: [
          {
            name: "Docs-Site",
            state: "connected",
            discoveredAt: 1,
            server: { exposure: "direct" },
            tools: [{ name: "search", inputSchema: { type: "object" } }],
          },
        ],
        offered: [],
        features: MCP_HOST_FEATURES,
      },
      host.client,
      {},
      { slackMs: 0, questions },
    );

    const tool = Option.getOrThrow(Arr.head(extension.tools ?? []));

    const api = apiWith({
      callId: "call-1",
      conversationId: ROOT_CONVERSATION_ID,
      env: undefined,
      getTask: async () => undefined,
      details: async () => undefined,
      memo: memoryMemo(memos),
    });

    return { questions, run: () => tool.execute({}, api, context) };
  };

  return { instance, memos, memory, sent, told };
};

describe("a -32042 round across a restart", () => {
  it("waits again for the owner when the rerun finds the round stored and Done not yet given", async () => {
    const { instance, memos, sent, told } = await restartable();
    const first = instance();

    // The first instance asks, stores the round and waits; it is then lost (its promise is never settled).
    void first.run();
    await until(async () => (await Effect.runPromise(first.questions.pending)).length === 1);
    expect(memos.get("mcp.wait.1")).toBe(true);

    // A new instance over the same storage: the rerun finds `mcp.sent` and the stored round, and waits for it.
    const second = instance();
    const rerun = second.run();
    let settled = false;

    void rerun.then(() => {
      settled = true;
    });
    await until(async () => (await Effect.runPromise(second.questions.pending)).length === 1);
    expect(settled).toBe(false);
    // Not sent again, nor resent: one request in all, and the owner was told once.
    expect(sent.map((each) => each.op)).toEqual(["tools/call"]);
    expect(told).toHaveLength(1);

    const [request] = await Effect.runPromise(second.questions.pending);

    await Effect.runPromise(second.questions.answer(request?.id ?? "", { action: "opened" }));
    await Effect.runPromise(second.questions.answer(request?.id ?? "", { action: "done" }));
    expect((await rerun).output).toEqual([{ type: "text", text: "done" }]);
    expect(sent.map((each) => each.op)).toEqual(["tools/call", "resend"]);
    expect(memos.get("mcp.resumed.1")).toBe(true);
  });

  it("takes the answer when Done was stored before the resend's marker, writes the marker and resends once", async () => {
    const { instance, memos, sent } = await restartable();
    const first = instance();

    void first.run();
    await until(async () => (await Effect.runPromise(first.questions.pending)).length === 1);

    // Done is stored by another instance, as an owner's answer is while the call's instance is going: the call's own
    // instance is not woken, and it is lost before it writes `mcp.resumed.1`.
    const answering = instance();
    const [request] = await Effect.runPromise(answering.questions.pending);

    await Effect.runPromise(answering.questions.answer(request?.id ?? "", { action: "opened" }));
    await Effect.runPromise(answering.questions.answer(request?.id ?? "", { action: "done" }));
    expect(memos.has("mcp.resumed.1")).toBe(false);

    // The rerun takes the stored answer, writes the marker, and sends the resend with the owner's accept.
    const rerun = await instance().run();

    expect(rerun.output).toEqual([{ type: "text", text: "done" }]);
    expect(memos.get("mcp.resumed.1")).toBe(true);
    expect(sent).toEqual([
      expect.objectContaining({ op: "tools/call" }),
      expect.objectContaining({
        op: "resend",
        params: expect.objectContaining({
          answers: { "page-1": { action: "accept", content: {} } },
        }),
      }),
    ]);

    // A rerun after the marker never sends the resend again.
    const later = await instance().run();

    expect(later.isError).toBe(true);
    expect(sent.map((each) => each.op)).toEqual(["tools/call", "resend"]);
  });
});

describe("a page the owner was done at, when the server asks for it again", () => {
  const ASK: McpQuestionAsk = {
    key: "page-1",
    callId: "call-9",
    conversationId: ROOT_CONVERSATION_ID,
    server: "Docs-Site",
    tool: "mcp__docs_site__search",
    message: "Authorize the app",
    form: { fields: [] },
    notes: [],
    page: { url: PAGE, host: "auth.example.com", domain: "example.com" },
    retry: true,
  };

  const ROUND = {
    callId: ASK.callId,
    round: 1,
    conn: "conn-docs",
    tool: "search",
    state: McpRoundState.Resend({ state: STATE }),
    asked: [],
  };

  const instance = async (memory: ReturnType<typeof memoryStorage>, told: Array<string>) =>
    createMcpQuestions({
      storage: memory.storage,
      announce: () => Effect.void,
      notify: ({ server }) =>
        Effect.sync(() => {
          told.push(server);
        }),
      redact: (shown) => Effect.succeed(shown),
      holdsSecret: () => Effect.succeed(false),
      vault: await testVault(),
    });

  /** The question `ask` is kept for round `round`, stored and shown. */
  const shown = async (questions: Awaited<ReturnType<typeof instance>>, ask: McpQuestionAsk) => {
    expect(await Effect.runPromise(questions.defer(ask))).toBe("deferred");
    await Effect.runPromise(questions.commitRound({ ...ROUND, callId: ask.callId }));
    await Effect.runPromise(questions.showRound(ask.callId));
  };

  it("keeps a round's state under its tag: a read's pages hold none", async () => {
    const memory = memoryStorage();
    const before = await instance(memory, []);

    expect(await Effect.runPromise(before.defer(ASK))).toBe("deferred");
    await Effect.runPromise(
      before.commitRound({ ...ROUND, callId: ASK.callId, state: McpRoundState.Read() }),
    );

    const after = await instance(memory, []);

    expect(await Effect.runPromise(after.deferredRound(ASK.callId))).toMatchObject({
      state: McpRoundState.Read(),
    });
  });

  it("keeps a call's resend state under its tag", async () => {
    const memory = memoryStorage();
    const before = await instance(memory, []);

    expect(await Effect.runPromise(before.defer(ASK))).toBe("deferred");
    await Effect.runPromise(before.commitRound({ ...ROUND, callId: ASK.callId }));

    const after = await instance(memory, []);

    expect(await Effect.runPromise(after.deferredRound(ASK.callId))).toMatchObject({
      state: McpRoundState.Resend({ state: STATE }),
    });
  });

  it("is brought back as not finished after a restart, with no new Notification and no count toward the cap", async () => {
    const memory = memoryStorage();
    const told: Array<string> = [];
    const before = await instance(memory, told);

    await shown(before, ASK);

    const [first] = await Effect.runPromise(before.pending);

    await Effect.runPromise(before.answer(first?.id ?? "", { action: "opened" }));
    await Effect.runPromise(before.answer(first?.id ?? "", { action: "done" }));
    await Effect.runPromise(before.endRound(ASK.callId));
    await until(async () => told.length === 1);
    expect(told).toEqual(["Docs-Site"]);
    expect(memory.keys().some((key) => key.startsWith("mcp-question:pages:"))).toBe(true);

    // The Session instance is gone; a new one over the same storage runs the call's rerun, which counts on from the round.
    const after = await instance(memory, told);

    await Effect.runPromise(after.deferredRound(ASK.callId));
    await shown(after, ASK);

    const [again] = await Effect.runPromise(after.pending);

    expect(again?.page).toMatchObject({ opened: false, retry: true, again: true });
    expect(again?.id).not.toEqual(first?.id);
    // Brought back quietly: the owner was told of this page once (the push is sent in the background).
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(told).toEqual(["Docs-Site"]);

    // It counted for nothing: the call still has all ten of its requests for other pages.
    await Effect.runPromise(after.answer(again?.id ?? "", { action: "decline" }));
    await Effect.runPromise(after.endRound(ASK.callId));

    for (const n of Arr.range(1, 10)) {
      expect(await Effect.runPromise(after.defer({ ...ASK, key: `other-${n}` }))).toBe("deferred");
    }

    // The call's end takes what it came to with it.
    await Effect.runPromise(after.settleCall(ASK.callId));
    expect(memory.keys().some((key) => key.startsWith("mcp-question:pages:"))).toBe(false);
  });
});

describe("the pages a call keeps as opened", () => {
  it("are bounded in how many, and in how long a key is", () => {
    const { storage } = memoryStorage();

    const basics = questionBasics({
      storage,
      redact: (shown) => Effect.succeed(shown),
      holdsSecret: () => Effect.succeed(false),
    });

    basics.openedPages("call-1", ["x".repeat(5000)]);
    basics.openedPages(
      "call-1",
      Arr.makeBy(100, (n) => `page-${n}`),
    );

    const { opened } = basics.pagesOf("call-1");

    expect(opened).toHaveLength(MCP_PAGES_KEPT);
    expect(opened.at(-1)).toBe("page-99");
    expect(opened.every((key) => key.length <= MCP_PAGE_KEY_CHARS)).toBe(true);

    basics.openedPages("call-2", ["x".repeat(5000)]);
    expect(basics.pagesOf("call-2").opened).toEqual([pageKeyOf("x".repeat(5000))]);
  });
});

describe("a page the server says is finished", () => {
  it("reads Finished for a moment, then closes", async () => {
    const memory = memoryStorage();

    const questions = createMcpQuestions({
      storage: memory.storage,
      announce: () => Effect.void,
      redact: (shown) => Effect.succeed(shown),
      holdsSecret: () => Effect.succeed(false),
      finishedShownMs: 40,
    });

    const ask = {
      key: "page-1",
      callId: "call-9",
      conversationId: ROOT_CONVERSATION_ID,
      server: "Docs-Site",
      tool: "mcp__docs_site__search",
      message: "Authorize the app",
      form: { fields: [] },
      notes: [],
      page: { url: PAGE, host: "auth.example.com", domain: "example.com" },
    } satisfies McpQuestionAsk;

    const outcome = Effect.runPromise(questions.ask(ask));

    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [request] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "opened" }));
    expect(await outcome).toMatchObject({ action: "accept" });
    await Effect.runPromise(questions.complete(ask.callId, ask.key));

    const [finished] = await Effect.runPromise(questions.pending);

    expect(finished?.page).toMatchObject({ opened: true, finished: true });
    // The call's clock is not held for it any more.
    await Effect.runPromise(questions.whileOpen(ask.callId, ask.key));
    await until(async () => (await Effect.runPromise(questions.pending)).length === 0);
  });
});

describe("a Legacy server's -32042 on read_mcp_resource", () => {
  const READ = { server: "File-Store", uri: "file:///a.txt" };

  const FILES = {
    name: "File-Store",
    exposure: "direct",
    resources: true,
    tools: [],
  };

  /** A read whose host answers `-32042` for its first `times` reads, then the contents. */
  const reading = async (times: number) => {
    const host = fakeMcpHost([FILES]);
    const sent: Array<Sent> = [];
    const vault = await testVault();

    host.answer(async (input, hooks) => {
      sent.push(input);

      if (sent.length > times) {
        return McpHostCompleted.make({
          result: {
            kind: "inline",
            value: { contents: [{ uri: READ.uri, text: "the notes" }] },
          },
        });
      }

      await hooks.onInput?.(visit(PAGE, "deferrable"));

      return McpHostPagesRequired.make({
        requests: [visit(PAGE, "deferrable")],
        message: "Authorization needed",
        conn: "conn-files",
      });
    });

    const questions = createMcpQuestions({
      storage: memoryStorage().storage,
      announce: () => Effect.void,
      redact: (shown) => Effect.succeed(shown),
      holdsSecret: () => Effect.succeed(false),
      vault,
    });

    const extension = mcpExtension(
      {
        servers: [
          {
            name: "File-Store",
            state: "connected",
            discoveredAt: 1,
            server: { exposure: "direct" },
            resources: true,
          },
        ],
        offered: [],
        features: MCP_HOST_FEATURES,
      },
      host.client,
      {},
      { slackMs: 0, questions },
    );

    const tool = Option.getOrThrow(
      Arr.findFirst(extension.tools ?? [], (each) => each.name === "read_mcp_resource"),
    );

    const api = apiWith({
      callId: "call-1",
      conversationId: ROOT_CONVERSATION_ID,
      env: undefined,
      getTask: async () => undefined,
      details: async () => undefined,
      memo: memoryMemo(new Map()),
    });

    return { questions, sent, run: () => tool.execute(READ, api, context) };
  };

  /** The owner opens the page that waits and presses Done. */
  const done = async (questions: Awaited<ReturnType<typeof reading>>["questions"]) => {
    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [request] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "opened" }));
    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "done" }));
  };

  it("is kept for the owner, and the read is sent again as it was once Done is pressed", async () => {
    const { questions, sent, run } = await reading(1);
    const running = run();

    await done(questions);

    const result = await running;

    expect(JSON.stringify(result.output)).toContain("the notes");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]).toMatchObject({
      op: "resources/read",
      params: { uri: READ.uri },
      ctx: { answers: { elicitation: true, defer: true, pages: true } },
    });
  });

  it("ends with the server's error when the owner declines the page, and the agent is told", async () => {
    const { questions, sent, run } = await reading(1);
    const running = run();

    await until(async () => (await Effect.runPromise(questions.pending)).length === 1);

    const [request] = await Effect.runPromise(questions.pending);

    await Effect.runPromise(questions.answer(request?.id ?? "", { action: "decline" }));

    const result = await running;
    const text = JSON.stringify(result.output);

    expect(result.isError).toBe(true);
    expect(text).toContain("Authorization needed");
    expect(JSON.stringify(result.diagnostics)).toContain(
      "The user declined File-Store's request for input.",
    );
    expect(sent).toHaveLength(1);
  });

  it("stops at the eleventh -32042 with the server's error, and says it kept asking", async () => {
    const { questions, sent, run } = await reading(1000);
    const running = run();

    for (let round = 1; round <= 10; round += 1) {
      await done(questions);
      await until(async () => sent.length === round + 1);
    }

    const result = await running;

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.output)).toContain(
      "Authorization needed. File-Store kept asking for the same page; stopped after 10 tries",
    );
    expect(sent).toHaveLength(11);
  });
});
