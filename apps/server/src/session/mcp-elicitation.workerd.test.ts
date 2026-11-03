// A Legacy MCP server's elicitation form end to end (`docs/architecture/mcp-server-requests.md` → Elicitation requests;
// ADR-0037, ADR-0041): the agent's call goes Session → host → the real `McpEngine` → a fake Legacy server that asks a
// form during the call; the form reaches a client of the Session socket as a card's request, the owner answers over the
// socket, and the answer travels back to the server. Answered, declined and cancelled; a credential form declined unseen;
// Stop withdrawing the card; and what the owner entered kept nowhere: not in the Session's storage, not in what the
// sockets were sent, not in a log. The 10-minute bound runs here too, through the real engine, with the bound shortened
// to 300 ms for a Session named `mcp-short-wait-*` (`host.fixture.ts`): nothing else is changed. (The paused timeout is
// in `packages/extensions/src/mcp-elicitation.test.ts`, over a test clock.)
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferSchemaOverJson:off preferEffectArray:off globalDate:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { ASK_TOOL, legacyStatefulServer, modernServer, rpcMethods } from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  type McpElicitationRequest,
  type ServerMessage,
  ServerMessageJson,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const open = async (asked: Array<Schema.Json>, cancelled: Array<string> = [], name = "mcp") => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
  const server = legacyStatefulServer({ moreTools: [ASK_TOOL], asked, cancelled });

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

    // No countdown: the call waits as long as the owner takes.
    expect(request).toMatchObject({ server: "docs", tool: "mcp__docs__ask", message: "Who?" });
    expect(request).not.toHaveProperty("deadline");

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
