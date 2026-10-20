// Secrets over the Session socket, against real Durable Object storage: the agent's request reaches the clients as a
// masked-form request, the owner's answer lets a tool use the value, and a pending request survives an eviction.
// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferSchemaOverJson:off preferEffectArray:off globalDate:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { secretReference } from "@cloudpid/extensions/secrets";
import {
  type ClientMessage,
  type SecretRequest,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

const VALUE = "sk-live-0123456789abcdef";

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

  /** The first message after `from` that `match` accepts. */
  const next = async <A extends ServerMessage>(
    match: (message: ServerMessage) => message is A,
    from = 0,
  ): Promise<A> => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const found = received.slice(from).find(match);

      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Never received the expected message: ${JSON.stringify(received)}`);
  };

  return {
    received,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    next,
    close: () => socket.close(),
  };
};

type Requests = Extract<ServerMessage, { type: "secret_requests" }>;

const isRequests = (message: ServerMessage): message is Requests =>
  message.type === "secret_requests";

const isPending = (message: ServerMessage): message is Requests =>
  isRequests(message) && message.requests.length > 0;

const isAnswer =
  (id: string) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: "result" | "error" }> =>
    (message.type === "result" || message.type === "error") && message.id === id;

/** The one request of a `secret_requests` message. */
const only = (message: Requests): SecretRequest => {
  const [request] = message.requests;

  if (request === undefined || message.requests.length !== 1) throw new Error("Not one request");

  return request;
};

/** Wait until `stub`'s Session has no work live. */
const idle = async (stub: DurableObjectStub<TestSession>) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await runInDurableObject(stub, (instance: TestSession) => instance.idle())) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Never idle");
};

/** The script: ask for `API_KEY`, then echo it through a placeholder. */
const SCRIPT = [
  `call:secret_ask:${JSON.stringify({ names: ["API_KEY"], reason: "call the API" })}`,
  `call:echo:${JSON.stringify({ text: `key=${secretReference("API_KEY")}` })}`,
  "done",
];

describe("Secrets over the Session socket", () => {
  it("shows the request in a masked form on every client, and a tool uses what the owner enters", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(stub, (instance: TestSession) => instance.script(SCRIPT));

    const owner = await connect(stub);
    const other = await connect(stub);

    owner.send({ type: "submit", id: "go", input: "Call the API" });

    const pending = await owner.next(isPending);
    const { requests } = pending;
    const request = only(pending);

    expect(pending.lifetimeMinutes).toBe(15);
    expect(request).toMatchObject({ names: ["API_KEY"], reason: "call the API" });
    expect((await other.next(isPending)).requests).toEqual(requests);

    const seen = other.received.length;

    owner.send({
      type: "secret_answer",
      id: "answer",
      request: request.id,
      values: { API_KEY: VALUE },
    });

    expect(await owner.next(isAnswer("answer"))).toEqual({
      type: "result",
      id: "answer",
      result: null,
    });
    // The other client's form closes.
    expect((await other.next(isRequests, seen)).requests).toEqual([]);

    await idle(stub);

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.at(-1)).toBe(`echo: key=${secretReference("API_KEY")}`);
    expect(JSON.stringify(results)).not.toContain(VALUE);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.storageDump()),
    ).not.toContain(VALUE);

    // Idle, the Session still wakes when the Secret expires, to delete it.
    const alarm = await runInDurableObject(stub, (_instance: TestSession, state) =>
      state.storage.getAlarm(),
    );

    expect(alarm).toBeGreaterThan(Date.now() + 14 * 60_000);
  });

  it("refuses an answer to a request that is not waiting", async () => {
    const client = await connect(env.SESSIONS.get(env.SESSIONS.newUniqueId()));

    client.send({ type: "secret_answer", id: "late", request: "nope", values: null });

    expect(await client.next(isAnswer("late"))).toMatchObject({ type: "error", id: "late" });
  });

  it("keeps a waiting request across an eviction, shows it again on reconnect, and finishes the call", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(stub, (instance: TestSession) => instance.script(SCRIPT));

    const before = await connect(stub);

    before.send({ type: "submit", id: "go", input: "Call the API" });

    const asked = only(await before.next(isPending));

    before.close();
    await evictDurableObject(stub);

    const after = await connect(stub);
    const shown = only(await after.next(isPending));

    expect(shown).toEqual(asked);

    after.send({
      type: "secret_answer",
      id: "answer",
      request: shown.id,
      values: { API_KEY: VALUE },
    });
    expect(await after.next(isAnswer("answer"))).toMatchObject({ type: "result" });

    await idle(stub);

    const results = await runInDurableObject(stub, (instance: TestSession) =>
      instance.toolResults(),
    );

    expect(results.at(-1)).toBe(`echo: key=${secretReference("API_KEY")}`);
  });

  it("withdraws a request whose call is gone once the Session is idle", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());
    const stray = { id: "99", conversationId: 1, names: ["API_KEY"] };

    // As an abandoned call leaves it: stored, with no call to come back for it.
    await runInDurableObject(stub, (_instance: TestSession, state) => {
      state.storage.kv.put("secret-asks", [stray]);
    });
    await evictDurableObject(stub);

    const asks = async () =>
      runInDurableObject(stub, (_instance: TestSession, state) =>
        state.storage.kv.get("secret-asks"),
      );

    // The new instance settles with no work live.
    for (let attempt = 0; attempt < 300 && JSON.stringify(await asks()) !== "[]"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(await asks()).toEqual([]);

    const client = await connect(stub);

    client.send({ type: "secret_answer", id: "late", request: stray.id, values: null });

    expect(await client.next(isAnswer("late"))).toMatchObject({ type: "error" });
    expect(client.received.some(isPending)).toBe(false);
  });
});
