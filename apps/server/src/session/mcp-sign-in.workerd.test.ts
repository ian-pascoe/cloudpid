// A Sign-in request in a Session end to end (`docs/architecture/mcp-sign-in.md` → Sign-in requests; ADR-0034): the agent's
// `mcp_sign_in_ask` goes Session → Registry (a scripted one, whose answers and calls the test reads) and waits with no
// deadline; the request reaches a client of the Session socket as a card and the owner once as a Notification; the owner
// declines over the socket, or a sign-in completed from Settings is carried to the Session (`mcpSignInsResolved`), which
// ends every open request; Stop withdraws it; and an eviction loses nothing: the call that asked reruns, finds its request
// again and asks the Registry once more. Over a scripted engine for the Environment's `McpHost`.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalTimers:off preferSchemaOverJson:off preferEffectArray:off globalDate:off
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpSignInKnownAskAnswer,
} from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  type McpSignInRequest,
  type ServerMessage,
  ServerMessageJson,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import type { EngineScript } from "../mcp/host.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

const DOCS = "https://docs.example/mcp";

const SET: McpApplySet = {
  kind: "set",
  hash: "h1",
  revision: 1,
  entries: [
    {
      name: "docs",
      source: { kind: "global" },
      server: { type: "http", url: DOCS, headers: {}, exposure: "direct" },
      hash: "hash-docs",
      conn: "conn-docs",
      identity: "identity-docs",
    },
  ],
};

const FOUND: EngineScript = {
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {} },
    tools: [{ name: "work", inputSchema: { type: "object" } }],
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {
      era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 },
    },
  } as typeof McpEngineDiscoverResult.Encoded,
};

/** What the Registry answers an ask for a server the owner has not signed in to. */
const OPEN: McpSignInKnownAskAnswer = {
  status: "open",
  first: true,
  key: "key-docs",
  why: "required",
  scopes: [],
  source: { kind: "global" },
  urlHost: "docs.example",
};

const LOAD = 'call:tool_search:{"query":"sign in"}';
const ASK = `call:mcp_sign_in_ask:${JSON.stringify({ server: "docs", reason: "I need the docs" })}`;

/** A Session in a fresh Environment whose host holds `SET`, and whose Registry answers `OPEN` to a Sign-in ask. */
const open = async () => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.script({ hash: SET.hash, signInsRevision: 0 });
  await host.scriptEngine(DOCS, [FOUND]);
  await host.apply(SET);

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await runInDurableObject(stub, (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
    instance.scriptSignIn(OPEN);
  });

  return { environment, stub };
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

  const requests = (): ReadonlyArray<McpSignInRequest> => {
    const last = received.findLast((message) => message.type === "mcp_sign_in_requests");

    return last?.type === "mcp_sign_in_requests" ? last.requests : [];
  };

  return {
    received,
    requests,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
};

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

/** The pushes a Session made about requests that wait for the owner: the Run's own "finished" is not one. */
const inputPushes = async (stub: DurableObjectStub<TestSession>) =>
  (await runInDurableObject(stub, (instance: TestSession) => instance.notified())).filter(
    (event) => event.kind === "input",
  );

const results = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.toolResults());

describe("a Sign-in request in a Session", () => {
  it("reaches the owner's client as a card, tells the owner once, and ends when a completed sign-in is carried to the Session", async () => {
    const { environment, stub } = await open();
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([LOAD, ASK, "done"]);
      await instance.submit({ requestId: "turn-1", text: "go" });
    });

    await settles(async () => expect(owner.requests()).toHaveLength(1));

    expect(owner.requests()[0]).toMatchObject({
      id: "signin-1",
      server: "docs",
      environment,
      urlHost: "docs.example",
      reason: "I need the docs",
      why: "required",
    });

    // The Registry was asked once, by this Session, with the request's id.
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.signInAsks()),
    ).toEqual({
      asked: [{ environment, server: "docs", session: `mcp-${environment}`, request: "signin-1" }],
      withdrawn: [],
    });
    // The owner was told once: what the key says, and the agent's reason.
    expect(await inputPushes(stub)).toEqual([
      {
        kind: "input",
        names: [],
        signIn: { server: "docs", reason: "I need the docs", key: "key-docs" },
      },
    ]);

    // The sign-in is completed from Settings: the main Worker carries the Registry's `resolved` here.
    expect(
      await runInDurableObject(stub, (instance: TestSession) =>
        instance.resolveSignIns(["signin-1"]),
      ),
    ).toBe(1);
    await settles(async () => expect(owner.requests()).toEqual([]));
    await idle(stub);

    expect((await results(stub)).at(-1)).toMatch(/^Signed in to docs/);
    expect(await inputPushes(stub)).toHaveLength(1);
    owner.close();
  });

  it("shows a failed sign-in attempt on the card and keeps the request open, and a later sign-in still ends it", async () => {
    const { stub } = await open();
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([LOAD, ASK, "done"]);
      await instance.submit({ requestId: "turn-1", text: "go" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    expect(owner.requests()[0]?.problem).toBeUndefined();

    expect(
      await runInDurableObject(stub, (instance: TestSession) =>
        instance.failSignIns(["signin-1"], "The authorization server refused the code"),
      ),
    ).toBe(1);
    await settles(async () =>
      expect(owner.requests()[0]?.problem).toBe("The authorization server refused the code"),
    );
    expect(owner.requests()).toHaveLength(1);

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.resolveSignIns(["signin-1"]),
    );
    await settles(async () => expect(owner.requests()).toEqual([]));
    await idle(stub);
    owner.close();
  });

  it("is one request when the agent's calls ask in parallel, and one sign-in ends every call", async () => {
    const { stub } = await open();
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([
        LOAD,
        `parallel:${JSON.stringify([
          ["mcp_sign_in_ask", { server: "docs", reason: "I need the docs" }],
          ["mcp_sign_in_ask", { server: "docs", reason: "Also the wiki" }],
        ])}`,
        "done",
      ]);
      await instance.submit({ requestId: "turn-1", text: "go" });
    });

    await settles(async () => expect(owner.requests()).toHaveLength(1));
    // Give the second call time to join; it must not make a second request or a second Notification.
    await Effect.runPromise(Effect.sleep(300));
    expect(owner.requests()).toHaveLength(1);
    expect(await inputPushes(stub)).toHaveLength(1);

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.resolveSignIns(["signin-1"]),
    );
    await settles(async () => expect(owner.requests()).toEqual([]));
    await idle(stub);

    const texts = (await results(stub)).filter((text) => text.startsWith("Signed in to docs"));

    expect(texts).toHaveLength(2);
    owner.close();
  });

  it("is declined over the socket, with the owner's reason for the agent, and its waiter is withdrawn", async () => {
    const { environment, stub } = await open();
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([LOAD, ASK, "done"]);
      await instance.submit({ requestId: "turn-1", text: "go" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));

    // A request that is not there is bounced to the card.
    owner.send({
      type: "mcp_sign_in_answer",
      id: "bad",
      request: "signin-9",
      action: "decline",
    });
    await settles(async () =>
      expect(owner.received).toContainEqual(expect.objectContaining({ type: "error", id: "bad" })),
    );

    owner.send({
      type: "mcp_sign_in_answer",
      id: "no",
      request: "signin-1",
      action: "decline",
      reason: "not that one",
    });
    await settles(async () => expect(owner.requests()).toEqual([]));
    await idle(stub);

    const text = (await results(stub)).at(-1) ?? "";

    expect(text).toContain("The owner declined to sign in to docs.");
    expect(text).toContain("Their reason: not that one");
    expect(
      (await runInDurableObject(stub, (instance: TestSession) => instance.signInAsks())).withdrawn,
    ).toEqual([{ session: `mcp-${environment}`, request: "signin-1" }]);
    owner.close();
  });

  it("is withdrawn from every client, and from the Registry, when Stop aborts the call", async () => {
    const { environment, stub } = await open();
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([LOAD, ASK, "stopped"]);
      await instance.submit({ requestId: "turn-1", text: "go" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    await runInDurableObject(stub, (instance: TestSession) => instance.abortRoot());
    await settles(async () => expect(owner.requests()).toEqual([]));
    await idle(stub);

    await settles(async () =>
      expect(
        (await runInDurableObject(stub, (instance: TestSession) => instance.signInAsks()))
          .withdrawn,
      ).toEqual([{ session: `mcp-${environment}`, request: "signin-1" }]),
    );
    owner.close();
  });

  it("survives an eviction: the card is there again, the rerun call rejoins it, and a sign-in carried after ends it", async () => {
    const { environment, stub } = await open();
    const owner = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([LOAD, ASK, "done"]);
      await instance.submit({ requestId: "turn-1", text: "go" });
    });
    await settles(async () => expect(owner.requests()).toHaveLength(1));
    await settles(async () => expect(await inputPushes(stub)).toHaveLength(1));
    owner.close();

    // The Session goes away while the call waits; its storage stays.
    await abortAllDurableObjects();

    const after = env.SESSIONS.getByName(`mcp-${environment}`);
    const reconnected = await connect(after);

    // A client that connects after the eviction is sent the request from storage, before anything else has run.
    await settles(async () => expect(reconnected.requests()).toHaveLength(1));
    expect(reconnected.requests()[0]).toMatchObject({ id: "signin-1", server: "docs" });

    // The resumed Run reruns the call, which finds its request and asks the Registry again: no second request.
    await runDurableObjectAlarm(after);
    await settles(async () =>
      expect(
        (await runInDurableObject(after, (instance: TestSession) => instance.signInAsks())).asked,
      ).toHaveLength(2),
    );
    expect(reconnected.requests()).toHaveLength(1);
    expect(await inputPushes(after)).toHaveLength(1);

    expect(
      await runInDurableObject(after, (instance: TestSession) =>
        instance.resolveSignIns(["signin-1"]),
      ),
    ).toBe(1);
    await settles(async () => expect(reconnected.requests()).toEqual([]));
    await idle(after);

    expect((await results(after)).at(-1)).toMatch(/^Signed in to docs/);
    reconnected.close();
  });

  it("is ended by a sign-in carried while no call waits, which the rerun call finds", async () => {
    const { environment, stub } = await open();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([LOAD, ASK, "done"]);
      await instance.submit({ requestId: "turn-1", text: "go" });
    });
    await settles(async () =>
      expect(
        (await runInDurableObject(stub, (instance: TestSession) => instance.signInAsks())).asked,
      ).toHaveLength(1),
    );
    await abortAllDurableObjects();

    const after = env.SESSIONS.getByName(`mcp-${environment}`);

    // The main Worker's call arrives first: it wakes the Session, and the outcome is kept for the call that reruns.
    expect(
      await runInDurableObject(after, (instance: TestSession) =>
        instance.resolveSignIns(["signin-1"]),
      ),
    ).toBe(1);
    await runDurableObjectAlarm(after);
    await idle(after);

    expect((await results(after)).at(-1)).toMatch(/^Signed in to docs/);
  });
});
