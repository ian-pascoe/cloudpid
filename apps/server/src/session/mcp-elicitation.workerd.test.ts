// A Legacy MCP server's elicitation form end to end (`docs/architecture/mcp-server-requests.md` → Elicitation requests;
// ADR-0037, ADR-0041): the agent's call goes Session → host → the real `McpEngine` → a fake Legacy server that asks a
// form during the call; the form reaches a client of the Session socket as a card's request, the owner answers over the
// socket, and the answer travels back to the server. Answered, declined and cancelled; a credential form declined unseen;
// Stop withdrawing the card; and what the owner entered kept nowhere: not in the Session's storage, not in what the
// sockets were sent, not in a log. The 10-minute bound runs here too, through the real engine, with the bound shortened
// to 300 ms for a Session named `mcp-short-wait-*` (`host.fixture.ts`): nothing else is changed. (The paused timeout is
// in `packages/extensions/src/mcp-elicitation.test.ts`, over a test clock.)
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalJsonInEffect:off preferEffectArray:off globalDate:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ASK_TOOL,
  type FakeOptions,
  GATED_TOOL,
  legacyStatefulServer,
  modernServer,
  rpcMethods,
  VISIT_TOOL,
} from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  type McpElicitationRequest,
  type ServerMessage,
  ServerMessageJson,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { TestSession } from "./host.fixture.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

const SET: McpApplySet = {
  kind: "set",
  hash: "h1",
  revision: 1,
  entries: [
    {
      name: "docs",
      source: { kind: "global" },
      server: { type: "http", url: "https://docs.example/mcp", headers: {}, exposure: "direct" },
      hash: "hash-docs",
      conn: "conn-docs",
      identity: "identity-docs",
    },
  ],
};

const SENTINEL = "sentinel-answer-5b7d0";

const NAME_FORM = {
  type: "object",
  properties: { name: { type: "string", title: "Your name" } },
  required: ["name"],
};

const TOKEN_FORM = {
  type: "object",
  properties: { githubToken: { type: "string", title: "Your API key" } },
  required: ["githubToken"],
};

/** A client of a Session's socket that keeps every message the Session sent it. */
const connect = async (stub: DurableObjectStub<TestSession>) => {
  const response = await stub.fetch("http://session/socket", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null) throw new Error(`No socket: ${response.status}`);
  socket.accept();

  const received: ServerMessage[] = [];

  socket.addEventListener("message", (event) => {
    received.push(Effect.runSync(decode(event.data)));
  });

  const requests = (): ReadonlyArray<McpElicitationRequest> => {
    const last = received.findLast((message) => message.type === "mcp_elicitation_requests");

    return last?.type === "mcp_elicitation_requests" ? last.requests : [];
  };

  return {
    received,
    requests,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
};

/** A Session whose host runs the real engine against a fake Legacy server that has the `ask` tool. */
const open = async (
  asked: Array<Schema.Json>,
  cancelled: Array<string> = [],
  name = "mcp",
  more: Pick<FakeOptions, "gate" | "gateReads" | "resources"> = {},
) => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  const server = legacyStatefulServer({
    moreTools: [ASK_TOOL, VISIT_TOOL, GATED_TOOL],
    asked,
    cancelled,
    ...more,
  });

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(new Request(input, init)),
  );

  await host.useRealEngine();
  await host.apply(SET);

  const stub = env.SESSIONS.getByName(`${name}-${environment}`);

  await runInDurableObject(stub, (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
  });

  return { stub, asked };
};

const ask = (schema: typeof NAME_FORM | typeof TOKEN_FORM) =>
  `call:mcp__docs__ask:${JSON.stringify({ message: "Who?", requestedSchema: schema })}`;

/** The pushes a Session made about MCP questions: the Run's own "finished" is not one. */
const inputPushes = async (stub: DurableObjectStub<TestSession>) =>
  (await runInDurableObject(stub, (instance: TestSession) => instance.notified())).filter(
    (event) => event.kind === "input",
  );

/** Everything the Session's storage holds, as text. */
const storageDump = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (_instance: TestSession, state) =>
    [...state.storage.kv.list()].map(([key, value]): readonly [string, Schema.Json] => [
      key,
      // SAFETY: the Session keeps JSON in its storage.
      value as Schema.Json,
    ]),
  );

/** The keys of a storage dump whose value holds the sentinel. */
const holders = (dump: ReadonlyArray<readonly [string, Schema.Json]>): ReadonlyArray<string> =>
  dump.flatMap(([key, value]) => (JSON.stringify(value).includes(SENTINEL) ? [key] : []));

const logs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  logs.length = 0;
});

const spyOnLogs = () => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });
  }
};

describe("a Legacy MCP server's form in a Session", () => {
  it("reaches the owner's client, is answered over the socket, and is kept nowhere", async () => {
    spyOnLogs();

    const { stub, asked } = await open([]);
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([ask(NAME_FORM), "done"]);
      await instance.submit({ requestId: "turn-1", text: "ask" });
    });

    await settles(async () => expect(owner.requests()).toHaveLength(1));

    const [request] = owner.requests();

    expect(request).toMatchObject({
      server: "docs",
      tool: "mcp__docs__ask",
      message: "Who?",
      form: { fields: [{ kind: "text", name: "name", title: "Your name", required: true }] },
    });
    expect(request?.deadline).toBeGreaterThan(Date.now());

    // A form that does not fit is bounced to the card, and the call goes on waiting.
    owner.send({
      type: "mcp_elicitation_answer",
      id: "bad",
      request: request?.id ?? "",
      action: "accept",
      content: {},
    });
    await settles(async () =>
      expect(owner.received).toContainEqual(
        expect.objectContaining({
          type: "error",
          id: "bad",
          message: expect.stringContaining("name: is required"),
        }),
      ),
    );
    expect(owner.requests()).toHaveLength(1);

    owner.send({
      type: "mcp_elicitation_answer",
      id: "yes",
      request: request?.id ?? "",
      action: "accept",
      content: { name: SENTINEL },
    });

    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    // The server got the owner's answer.
    expect(asked).toEqual([{ action: "accept", content: { name: SENTINEL } }]);

    // `/export` says what the form came to under the call's result: the names of the fields, never a value.
    const exported = await runInDurableObject(stub, async (instance: TestSession) => {
      const result = await instance.command("export", "");

      return "outcome" in result ? (result.outcome.file?.content ?? "") : result.failure;
    });

    expect(exported).toContain("Elicitation: docs · form · submitted (name)");

    // The owner was told once, never what is asked.
    const told = await inputPushes(stub);

    expect(told).toEqual([
      { kind: "input", names: [], mcp: { server: "docs", kind: "elicitation" } },
    ]);

    // The call's `details` say what happened, with the names of the fields and no value.
    const dump = await storageDump(stub);

    expect(dump.map(([key]) => key).some((key) => key.startsWith("mcp-question:s:"))).toBe(true);
    // The fake server repeats what it was given in its reply, which the agent reads (`request-messages` holds the
    // model's context, as the spec says: "its reply to the agent may repeat it"); no other key holds it.
    expect(holders(dump)).toEqual(["request-messages"]);
    expect(JSON.stringify(owner.received)).not.toContain(SENTINEL);
    expect(logs.join("\n")).not.toContain(SENTINEL);
    owner.close();
  });

  it("is declined or cancelled by the owner, and the server is told", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const { stub, asked } = await open([]);
      const owner = await connect(stub);

      await runInDurableObject(stub, async (instance: TestSession) => {
        instance.script([ask(NAME_FORM), "done"]);
        await instance.submit({ requestId: "turn-1", text: "ask" });
      });
      await settles(async () => expect(owner.requests()).toHaveLength(1));
      owner.send({
        type: "mcp_elicitation_answer",
        id: "no",
        request: owner.requests()[0]?.id ?? "",
        action,
      });
      await settles(async () => expect(asked).toEqual([{ action }]));
      await settles(async () =>
        expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(
          true,
        ),
      );

      const results = await runInDurableObject(stub, (instance: TestSession) =>
        instance.toolResults(),
      );

      expect(results.join("\n")).toContain(
        `The user ${action === "decline" ? "declined" : "cancelled"} docs's request for input.`,
      );
      owner.close();
    }
  });

  it("is declined in this Session: the server's next question is declined unseen, until the owner takes it back", async () => {
    const { stub, asked } = await open([]);
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([ask(NAME_FORM), ask(NAME_FORM), "done"]);
      await instance.submit({ requestId: "turn-1", text: "ask" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));

    // The Session says it takes a Decline's scope, so a client may send one.
    expect(owner.received[0]).toMatchObject({ type: "hello", mcpDecline: true });

    owner.send({
      type: "mcp_elicitation_answer",
      id: "never",
      request: owner.requests()[0]?.id ?? "",
      action: "decline",
      scope: "session",
    });

    // The second question is declined with no card: both are told `decline`.
    await settles(async () =>
      expect(asked).toEqual([{ action: "decline" }, { action: "decline" }]),
    );
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );
    expect(owner.requests()).toEqual([]);

    const last = owner.received.findLast((message) => message.type === "mcp_elicitation_requests");

    expect(last).toMatchObject({ requests: [], declined: ["docs"] });

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.join("\n")).toContain(
      "cloudpid declined docs's request for input: the owner chose to decline this server's requests in this Session",
    );

    // The owner's ✕ takes it back, and the clients are told.
    owner.send({ type: "mcp_elicitation_revoke", id: "back", server: "docs" });
    await settles(async () =>
      expect(
        owner.received.findLast((message) => message.type === "mcp_elicitation_requests"),
      ).toEqual({ type: "mcp_elicitation_requests", requests: [] }),
    );
    owner.close();
  });

  it("is declined unseen when it asks for a credential: no card, no Notification", async () => {
    const { stub, asked } = await open([]);
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([ask(TOKEN_FORM), "done"]);
      await instance.submit({ requestId: "turn-1", text: "ask" });
    });
    await settles(async () => expect(asked).toEqual([{ action: "decline" }]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    expect(owner.requests()).toEqual([]);
    expect(
      owner.received
        .filter((m) => m.type === "mcp_elicitation_requests")
        .every((m) => m.requests.length === 0),
    ).toBe(true);
    expect(await inputPushes(stub)).toEqual([]);
    owner.close();
  });

  it("leaves its record, and a Sampling request's, to a Fork, whose own Session keeps both as its root conversation's", async () => {
    const { stub } = await open([]);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([ask(TOKEN_FORM), "done"]);
      await instance.submit({ requestId: "turn-1", text: "ask" });
    });
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    const [, kept] =
      (await storageDump(stub)).find(([key]) => key.startsWith("mcp-question:s:")) ?? [];

    // SAFETY: a settled question record is a JSON object with its call's `callId`.
    const callId = (kept as { readonly callId: string }).callId;

    // A Sampling request the same call made, as the Session keeps it (`mcp-sampling:*`).
    const sampling = {
      id: `${callId}:s1`,
      server: "docs",
      tool: "mcp__docs__ask",
      origin: "agent",
      conversationId: 1,
      callId,
      sequence: 1,
      status: "refused",
      by: "owner",
      reason: "the owner refused",
      notes: [],
      askedAt: 1,
      settledAt: 2,
    };

    await runInDurableObject(stub, (_instance: TestSession, state) => {
      state.storage.kv.put(`mcp-sampling:r:${sampling.id}`, sampling);
      state.storage.kv.put("mcp-sampling:index", [
        { id: sampling.id, bytes: 1, at: 2, stub: false },
      ]);
    });

    const target = `fork-${counter++}`;

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.forkInto(target, { quiet: "none" }),
    );

    const copy = await storageDump(env.SESSIONS.getByName(target));

    expect(copy.filter(([key]) => key.startsWith("mcp-question:s:"))).toEqual([
      [expect.any(String), expect.objectContaining({ callId, action: "decline", by: "cloudpid" })],
    ]);
    expect(copy.filter(([key]) => key.startsWith("mcp-sampling:r:"))).toEqual([
      [`mcp-sampling:r:${sampling.id}`, expect.objectContaining({ callId, status: "refused" })],
    ]);
  });

  it("is withdrawn from every client when Stop aborts the call", async () => {
    const { stub } = await open([]);
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([ask(NAME_FORM), "stopped"]);
      await instance.submit({ requestId: "turn-1", text: "ask" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    await runInDurableObject(stub, (instance: TestSession) => instance.abortRoot());
    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );
    owner.close();
  });

  it("is cancelled when the owner does not answer in time, the server told and the card withdrawn", async () => {
    const { stub, asked } = await open([], [], "mcp-short-wait");
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([ask(NAME_FORM), "done"]);
      await instance.submit({ requestId: "turn-1", text: "ask" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () => expect(asked).toEqual([{ action: "cancel" }]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.join("\n")).toContain(
      "cloudpid cancelled docs's request for input: the owner did not answer in time",
    );
    expect(await inputPushes(stub)).toHaveLength(1);
    owner.close();
  });
});

describe("a Modern MCP server's form in a Session", () => {
  it("is kept between the call's rounds, answered over the socket, and sent in one resume, sealed meanwhile", async () => {
    spyOnLogs();

    const environment = `env-${counter++}`;
    const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
    const asked: Array<Schema.Json> = [];
    const options = { moreTools: [ASK_TOOL], asked };
    const server = modernServer(options);

    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      server.handle(new Request(input, init)),
    );

    await host.useRealEngine();
    await host.apply(SET);

    const stub = env.SESSIONS.getByName(`mcp-${environment}`);

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.mcpEnvironment(environment, 1);
    });

    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([ask(NAME_FORM), "done"]);
      await instance.submit({ requestId: "turn-1", text: "ask" });
    });

    await settles(async () => expect(owner.requests()).toHaveLength(1));

    const [request] = owner.requests();

    // No countdown: the call waits as long as the owner takes. The far `deadline` is for a client from before `waits`.
    expect(request).toMatchObject({
      server: "docs",
      tool: "mcp__docs__ask",
      message: "Who?",
      waits: "owner",
    });
    expect(request?.deadline).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);

    owner.send({
      type: "mcp_elicitation_answer",
      id: "yes",
      request: request?.id ?? "",
      action: "accept",
      content: { name: SENTINEL },
    });

    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    // The call went out once, then its one resume with the owner's answer.
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(2);
    expect(options.asked).toEqual([
      expect.objectContaining({
        round: 1,
        responses: { q1: { action: "accept", content: { name: SENTINEL } } },
      }),
    ]);
    expect(await inputPushes(stub)).toHaveLength(1);

    // Never in the clear: only the server's reply, which the agent reads, repeats it.
    const dump = await storageDump(stub);

    expect(holders(dump)).toEqual(["request-messages"]);
    expect(dump.map(([key]) => key).filter((key) => key.startsWith("mcp-question:d"))).toEqual([]);
    expect(JSON.stringify(owner.received)).not.toContain(SENTINEL);
    expect(logs.join("\n")).not.toContain(SENTINEL);
    owner.close();
  });
});

describe("a Modern MCP server's form kept for later, while its server changes", () => {
  it("is withdrawn from the cards when a client connects after the change, which a round kept for later holds no request to hear", async () => {
    const environment = `env-${counter++}`;
    const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
    const asked: Array<Schema.Json> = [];
    const server = modernServer({ moreTools: [ASK_TOOL], asked });

    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      server.handle(new Request(input, init)),
    );

    await host.useRealEngine();
    await host.apply(SET);

    const stub = env.SESSIONS.getByName(`mcp-${environment}`);

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.mcpEnvironment(environment, 1);
    });

    const first = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([ask(NAME_FORM), "done"]);
      await instance.submit({ requestId: "turn-1", text: "ask" });
    });
    await settles(async () => expect(first.requests()).toHaveLength(1));

    // The owner leaves; the server's connection changes while the round waits. The host holds no request for the round, so
    // nothing tells the Session: its card stays.
    first.close();
    await host.apply({
      ...SET,
      hash: "h2",
      revision: 2,
      entries: SET.entries.map((entry) => ({ ...entry, hash: "hash-docs-2", conn: "conn-docs-2" })),
    });

    // The next client's connect makes the look, which finds the server on another connection and withdraws the card.
    const second = await connect(stub);

    await settles(async () =>
      expect(second.received.filter((m) => m.type === "mcp_elicitation_requests")).toEqual(
        expect.arrayContaining([expect.objectContaining({ requests: [] })]),
      ),
    );
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    // The call was sent once and never resumed: the question was answered `cancel` by cloudpid.
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(1);
    second.close();
  });
});

const PAGE_URL = "https://login.example.com/authorize?state=1";

/** A Session whose host runs the real engine against a fake Modern server that has the `visit` tool. */
const openModern = async (asked: Array<Schema.Json>) => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
  const server = modernServer({ moreTools: [VISIT_TOOL], asked });

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(new Request(input, init)),
  );

  await host.useRealEngine();
  await host.apply(SET);

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await runInDurableObject(stub, (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
  });

  return { stub, server };
};

const visitModern = (rounds: number) =>
  `call:mcp__docs__visit:${JSON.stringify({ url: PAGE_URL, message: "Sign in", rounds })}`;

describe("a Legacy MCP server's page in a Session", () => {
  it("is opened in the call: the server is told at once, and the card goes when the call ends", async () => {
    const { stub, asked } = await open([]);
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([
        `call:mcp__docs__visit:${JSON.stringify({ url: PAGE_URL, message: "Sign in", elicitationId: "e1", holdMs: 600 })}`,
        "done",
      ]);
      await instance.submit({ requestId: "turn-1", text: "visit" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));

    const [request] = owner.requests();

    expect(request).toMatchObject({
      server: "docs",
      message: "Sign in",
      page: { url: PAGE_URL, host: "login.example.com", domain: "example.com", opened: false },
    });
    expect(await inputPushes(stub)).toEqual([
      { kind: "input", names: [], mcp: { server: "docs", kind: "elicitation", page: true } },
    ]);

    owner.send({
      type: "mcp_elicitation_answer",
      id: "open",
      request: request?.id ?? "",
      action: "opened",
    });
    await settles(async () => expect(asked).toEqual([{ action: "accept" }]));
    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );
    owner.close();
  });

  it("is declined unseen when its address is not an https page", async () => {
    const { stub, asked } = await open([]);
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([
        `call:mcp__docs__visit:${JSON.stringify({ url: "http://login.example.com/x", elicitationId: "e1" })}`,
        "done",
      ]);
      await instance.submit({ requestId: "turn-1", text: "visit" });
    });
    await settles(async () => expect(asked).toEqual([{ action: "decline" }]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );
    expect(owner.requests()).toEqual([]);
    owner.close();
  });

  it("is a -32042: opened, then Done sends the call again, which now runs", async () => {
    const gate = { times: 1, calls: 0, url: PAGE_URL };
    const { stub } = await open([], [], "mcp", { gate });
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["call:mcp__docs__gated:{}", "done"]);
      await instance.submit({ requestId: "turn-1", text: "gated" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));

    const [request] = owner.requests();

    expect(request?.page).toMatchObject({ url: PAGE_URL, opened: false, retry: true });

    // Done is not offered before the page is opened.
    owner.send({
      type: "mcp_elicitation_answer",
      id: "early",
      request: request?.id ?? "",
      action: "done",
    });
    await settles(async () =>
      expect(owner.received).toContainEqual(
        expect.objectContaining({ type: "error", id: "early" }),
      ),
    );
    owner.send({
      type: "mcp_elicitation_answer",
      id: "open",
      request: request?.id ?? "",
      action: "opened",
    });
    await settles(async () => expect(owner.requests()[0]?.page?.opened).toBe(true));
    owner.send({
      type: "mcp_elicitation_answer",
      id: "done",
      request: request?.id ?? "",
      action: "done",
    });
    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    expect(gate.calls).toBe(2);

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.join("\n")).toContain("opened");
    owner.close();
  });

  it("is a -32042 on read_mcp_resource: Done sends the same read again, which now returns", async () => {
    const gateReads = { times: 1, calls: 0, url: PAGE_URL };
    const uri = "file:///notes.txt";

    const { stub } = await open([], [], "mcp", {
      gateReads,
      resources: [{ uri, name: "notes", contents: [{ uri, text: "the notes" }] }],
    });

    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([
        `call:read_mcp_resource:${JSON.stringify({ server: "docs", uri })}`,
        "done",
      ]);
      await instance.submit({ requestId: "turn-1", text: "read" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));

    const [request] = owner.requests();

    expect(request?.page).toMatchObject({ url: PAGE_URL, opened: false, retry: true });
    owner.send({
      type: "mcp_elicitation_answer",
      id: "open",
      request: request?.id ?? "",
      action: "opened",
    });
    await settles(async () => expect(owner.requests()[0]?.page?.opened).toBe(true));
    owner.send({
      type: "mcp_elicitation_answer",
      id: "done",
      request: request?.id ?? "",
      action: "done",
    });
    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    expect(gateReads.calls).toBe(2);

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.join("\n")).toContain("the notes");
    owner.close();
  });
});

describe("a Modern MCP server's page in a Session", () => {
  it("is declared to the server, kept between the call's rounds, and answered once the owner is Done", async () => {
    const asked: Array<Schema.Json> = [];
    const { stub, server } = await openModern(asked);
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([visitModern(1), "done"]);
      await instance.submit({ requestId: "turn-1", text: "visit" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));

    const [request] = owner.requests();

    expect(request).toMatchObject({
      server: "docs",
      message: "Sign in",
      waits: "owner",
      page: {
        url: PAGE_URL,
        host: "login.example.com",
        domain: "example.com",
        opened: false,
        retry: true,
      },
    });
    expect(await inputPushes(stub)).toEqual([
      { kind: "input", names: [], mcp: { server: "docs", kind: "elicitation", page: true } },
    ]);

    // The call declared `url` along with the form, in the request's `_meta`.
    const call = server.received.find((received) => received.rpc?.method === "tools/call");

    expect(JSON.stringify(call?.rpc?.params?.["_meta"])).toContain(
      '"elicitation":{"form":{},"url":{}}',
    );

    // Done is not offered before the page is opened, and Open answers nothing: the server hears nothing meanwhile.
    owner.send({
      type: "mcp_elicitation_answer",
      id: "early",
      request: request?.id ?? "",
      action: "done",
    });
    await settles(async () =>
      expect(owner.received).toContainEqual(
        expect.objectContaining({ type: "error", id: "early" }),
      ),
    );
    owner.send({
      type: "mcp_elicitation_answer",
      id: "open",
      request: request?.id ?? "",
      action: "opened",
    });
    await settles(async () => expect(owner.requests()[0]?.page?.opened).toBe(true));
    expect(asked).toEqual([]);
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(1);

    owner.send({
      type: "mcp_elicitation_answer",
      id: "done",
      request: request?.id ?? "",
      action: "done",
    });
    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    // One more `tools/call`: the resume, carrying the accept and no content.
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(2);
    expect(asked).toEqual([{ round: 1, responses: { page: { action: "accept" } } }]);

    // Nothing of the round is left in the Session's storage.
    const dump = await storageDump(stub);

    expect(dump.map(([key]) => key).filter((key) => key.startsWith("mcp-question:d"))).toEqual([]);
    expect(dump.map(([key]) => key).filter((key) => key.startsWith("mcp-question:q"))).toEqual([]);
    owner.close();
  });

  it("reads Not finished when the server asks for the same page again, then Done sends the next resume", async () => {
    const asked: Array<Schema.Json> = [];
    const { stub, server } = await openModern(asked);
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([visitModern(2), "done"]);
      await instance.submit({ requestId: "turn-1", text: "visit" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));

    const [first] = owner.requests();

    for (const action of ["opened", "done"] as const) {
      owner.send({ type: "mcp_elicitation_answer", id: action, request: first?.id ?? "", action });
    }

    await settles(async () => expect(owner.requests()[0]?.page?.again).toBe(true));

    const [second] = owner.requests();

    expect(second?.id).not.toEqual(first?.id);
    expect(second?.page).toMatchObject({ url: PAGE_URL, opened: false, retry: true, again: true });
    // The owner was told once.
    expect(await inputPushes(stub)).toHaveLength(1);

    for (const action of ["opened", "done"] as const) {
      owner.send({ type: "mcp_elicitation_answer", id: action, request: second?.id ?? "", action });
    }

    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(3);
    expect(asked).toEqual([
      { round: 1, responses: { page: { action: "accept" } } },
      { round: 2, responses: { page: { action: "accept" } } },
    ]);
    owner.close();
  });

  it("is declined before it is opened: the server is told decline, and the agent reads that", async () => {
    const asked: Array<Schema.Json> = [];
    const { stub } = await openModern(asked);
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([visitModern(1), "done"]);
      await instance.submit({ requestId: "turn-1", text: "visit" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));

    const [request] = owner.requests();

    owner.send({
      type: "mcp_elicitation_answer",
      id: "no",
      request: request?.id ?? "",
      action: "decline",
    });
    await settles(async () => expect(owner.requests()).toEqual([]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );
    expect(asked).toEqual([{ round: 1, responses: { page: { action: "decline" } } }]);

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.join("\n")).toContain("The user declined docs's request for input.");
    owner.close();
  });
});
