// Browser Handoffs over the Session socket, against real Durable Object storage: the agent's request reaches every client
// with the Live View link, the owner finishing in Live View resumes the tool, a pending handoff survives an eviction, and
// the link never enters the transcript or a model request.
// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferSchemaOverJson:off preferEffectArray:off globalDate:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ClientMessage,
  type HandoffRequest,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { LIVE_VIEW_URL, type TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

/** The part of the link that is a credential. */
const TOKEN = "SECRET-LIVE-VIEW-TOKEN";

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
    for (let attempt = 0; attempt < 1000; attempt++) {
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

type Requests = Extract<ServerMessage, { type: "handoff_requests" }>;

const isRequests = (message: ServerMessage): message is Requests =>
  message.type === "handoff_requests";

const isPending = (message: ServerMessage): message is Requests =>
  isRequests(message) && message.requests.length > 0;

const only = (message: Requests): HandoffRequest => {
  const [request] = message.requests;

  if (request === undefined || message.requests.length !== 1) throw new Error("Not one request");

  return request;
};

/** Wait until `stub`'s Session has no work live. */
const idle = async (stub: DurableObjectStub<TestSession>) => {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await runInDurableObject(stub, (instance: TestSession) => instance.idle())) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Never idle");
};

const SCRIPT = [
  `call:browser_handoff:${JSON.stringify({ instructions: "Log in, then press Done" })}`,
  "All done.",
];

const started = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.handoffStarts());

const results = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.toolResults());

describe("Browser Handoffs over the Session socket", () => {
  it("shows the owner the link and the instructions, pushes them, resumes the tool when the owner finishes, and keeps the link out of the transcript and the model's requests", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(stub, (instance: TestSession) => instance.script(SCRIPT));

    const owner = await connect(stub);
    const other = await connect(stub);

    owner.send({ type: "submit", id: "go", input: "Log me in" });

    const pending = await owner.next(isPending);
    const request = only(pending);

    expect(request).toMatchObject({
      conversationId: 1,
      instructions: "Log in, then press Done",
      url: LIVE_VIEW_URL,
    });
    expect(request.deadline).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect((await other.next(isPending)).requests).toEqual(pending.requests);

    expect(await started(stub)).toMatchObject([
      { requestId: request.id, conversationId: 1, instructions: "Log in, then press Done" },
    ]);

    // The owner may not have the app open: the link is pushed to them with the instructions.
    await vi.waitFor(
      async () =>
        expect(
          await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
        ).toEqual([
          {
            kind: "notice",
            body: "Needs you in the browser: Log in, then press Done",
            url: LIVE_VIEW_URL,
          },
        ]),
      { timeout: 10_000 },
    );

    const seen = other.received.length;

    // The owner presses Done in Live View.
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.completeHandoff(request.id, { state: "complete", success: true }),
    );

    // The request closes on every client, the run goes on, and the handoff is ended in the host.
    expect((await other.next(isRequests, seen)).requests).toEqual([]);
    await idle(stub);

    expect((await results(stub)).at(-1)).toMatch(/The user finished the handoff/);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.endedHandoffs()),
    ).toEqual([request.id]);

    // The link reached the owner's clients and the push, and nothing the model or the transcript holds.
    const surfaces = await runInDurableObject(stub, async (instance: TestSession) => [
      JSON.stringify(await instance.toolResults()),
      instance.requestMessages().join("\n"),
      instance.harnessDump(),
      JSON.stringify(await instance.snapshot()),
    ]);

    for (const surface of surfaces) {
      expect(surface).not.toContain(TOKEN);
      expect(surface).not.toContain("live.browser.run");
    }

    // The model did get as far as the result: it answered after it.
    expect(
      (await runInDurableObject(stub, (session: TestSession) => session.requestMessages())).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("keeps a waiting handoff across an eviction, shows it again on reconnect, and finishes the call without starting another", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.script(SCRIPT);
      instance.quietHandoffs();
    });

    const before = await connect(stub);

    before.send({ type: "submit", id: "go", input: "Log me in" });

    const asked = only(await before.next(isPending));

    before.close();
    await evictDurableObject(stub);

    const after = await connect(stub);
    const shown = only(await after.next(isPending));

    expect(shown).toEqual(asked);

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.completeHandoff(asked.id, { state: "complete", success: true }),
    );
    await idle(stub);

    expect((await results(stub)).at(-1)).toMatch(/The user finished the handoff/);
    // The rerun waited on the handoff the first instance started.
    expect(await started(stub)).toHaveLength(1);
  });

  it("tells the model when the owner could not do it, and when the handoff times out", async () => {
    const failing = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(failing, (instance: TestSession) => instance.script(SCRIPT));

    const client = await connect(failing);

    client.send({ type: "submit", id: "go", input: "Log me in" });

    const request = only(await client.next(isPending));

    await runInDurableObject(failing, (instance: TestSession) =>
      instance.completeHandoff(request.id, {
        state: "complete",
        success: false,
        reason: "The code never came",
      }),
    );
    await idle(failing);
    expect((await results(failing)).at(-1)).toMatch(
      /could not complete the handoff: The code never came/,
    );

    // A Session whose handoffs time out after 300 ms; the object is rebuilt to read it.
    const slow = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(slow, (instance: TestSession, state) => {
      state.storage.kv.put("handoff-timeout", 300);
      instance.script(SCRIPT);
    });
    await evictDurableObject(slow);

    const waiting = await connect(slow);

    waiting.send({ type: "submit", id: "go", input: "Log me in" });
    await waiting.next(isPending);
    await idle(slow);

    expect((await results(slow)).at(-1)).toMatch(/timed out after 30 minutes/);
    expect((await waiting.next(isRequests, waiting.received.length - 1)).requests).toEqual([]);
  });

  it("withdraws the request and ends the handoff when the run is stopped", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(stub, (instance: TestSession) => instance.script(SCRIPT));

    const client = await connect(stub);

    client.send({ type: "submit", id: "go", input: "Log me in" });

    const request = only(await client.next(isPending));
    const seen = client.received.length;

    await runInDurableObject(stub, (instance: TestSession) => instance.abortRoot());

    expect((await client.next(isRequests, seen)).requests).toEqual([]);
    await idle(stub);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.endedHandoffs()),
    ).toEqual([request.id]);
  });

  it("ends a handoff whose call is gone once the Session is idle", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    const stray: HandoffRequest = {
      id: "99",
      // SAFETY: a conversation ID, as the protocol brands it.
      conversationId: 1 as HandoffRequest["conversationId"],
      instructions: "Log in",
      url: LIVE_VIEW_URL,
      deadline: Date.now() + 60_000,
    };

    // As an abandoned call leaves it: stored, with no call to come back for it.
    await runInDurableObject(stub, (_instance: TestSession, state) => {
      state.storage.kv.put("browser-handoffs", [stray]);
    });
    await evictDurableObject(stub);

    const ended = () =>
      runInDurableObject(stub, (instance: TestSession) => instance.endedHandoffs());

    // The new instance settles with no work live.
    for (let attempt = 0; attempt < 1000 && (await ended()).length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(await ended()).toEqual(["99"]);

    const client = await connect(stub);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(client.received.some(isPending)).toBe(false);
  });
});
