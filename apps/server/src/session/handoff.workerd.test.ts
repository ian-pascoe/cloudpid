// Browser Handoffs over the Session socket, against real Durable Object storage: the agent's request reaches every client
// without a Live View link, the owner's client mints links with `live_view` and is the only one that sees them, the
// owner finishing in Live View resumes the tool, and a pending handoff survives an eviction. No link is stored, pushed,
// broadcast, or let into the transcript or a model request.
// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferSchemaOverJson:off preferEffectArray:off globalDate:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  type ClientMessage,
  type BrowserHandoffRequest,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import { describeEvent } from "../push/notification.ts";
import { LIVE_VIEW_LINKS, LIVE_VIEW_TOKEN, type TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

/** The part of a Live View link that is a credential. */
const TOKEN = LIVE_VIEW_TOKEN;

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

type Requests = Extract<ServerMessage, { type: "browser_handoff_requests" }>;

type Answer = Extract<ServerMessage, { type: "result" | "error" }>;

/** The answer to the command with `id`. */
const answerTo =
  (id: string) =>
  (message: ServerMessage): message is Answer =>
    (message.type === "result" || message.type === "error") && message.id === id;

const isRequests = (message: ServerMessage): message is Requests =>
  message.type === "browser_handoff_requests";

const isPending = (message: ServerMessage): message is Requests =>
  isRequests(message) && message.requests.length > 0;

const only = (message: Requests): BrowserHandoffRequest => {
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
  it("shows every client the instructions, pushes the way to the Live View Pane, mints links only for the client that asks, and resumes the tool when the owner finishes", async () => {
    const stub = env.SESSIONS.get(env.SESSIONS.newUniqueId());

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.script(SCRIPT);
      instance.leaveWindows(["https://accounts.example.com"]);
    });

    const owner = await connect(stub);
    const other = await connect(stub);

    owner.send({ type: "submit", id: "go", input: "Log me in" });

    const pending = await owner.next(isPending);
    const request = only(pending);

    expect(request).toEqual({
      id: expect.any(String),
      conversationId: 1,
      instructions: "Log in, then press Done",
      deadline: expect.any(Number),
    });
    expect(request.deadline).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect((await other.next(isPending)).requests).toEqual(pending.requests);

    expect(await started(stub)).toMatchObject([
      { requestId: request.id, conversationId: 1, instructions: "Log in, then press Done" },
    ]);

    // The owner may not have the app open: the push opens the Session with the handoff's Live View Pane.
    await vi.waitFor(
      async () =>
        expect(
          await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
        ).toEqual([
          {
            kind: "notice",
            body: "Needs you in the browser: Log in, then press Done",
            url: `?pane=live-view:${request.id}`,
          },
        ]),
      { timeout: 10_000 },
    );

    const [push] = await runInDurableObject(stub, (instance: TestSession) => instance.notified());

    expect(push && describeEvent(push, { id: "session-1", title: null }).url).toBe(
      `/sessions/session-1?pane=live-view:${request.id}`,
    );

    // The owner takes over: their Live View asks for links, and only they get them.
    owner.send({ type: "live_view", id: "lv-1", requestId: request.id });

    expect(await owner.next(answerTo("lv-1"))).toEqual({
      type: "result",
      id: "lv-1",
      result: LIVE_VIEW_LINKS,
    });
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.liveViews())).toEqual(
      [request.id],
    );

    // A handoff the Session does not have gets none.
    owner.send({ type: "live_view", id: "lv-x", requestId: "nope" });
    expect(await owner.next(answerTo("lv-x"))).toEqual({
      type: "error",
      id: "lv-x",
      message: "the handoff is over",
    });

    const seen = other.received.length;

    // The owner presses Done in Live View.
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.completeHandoff(request.id, { state: "complete", success: true }),
    );

    // The request closes on every client, the run goes on, and the handoff is ended in the host.
    expect((await other.next(isRequests, seen)).requests).toEqual([]);
    await idle(stub);

    // The model hears how it ended and which windows are left, by origin.
    expect((await results(stub)).at(-1)).toMatch(/The user finished the handoff/);
    expect((await results(stub)).at(-1)).toMatch(
      /still open \(pop-ups or new tabs\): https:\/\/accounts\.example\.com/,
    );
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.endedHandoffs()),
    ).toEqual([request.id]);

    // Once it is over, no more links.
    owner.send({ type: "live_view", id: "lv-2", requestId: request.id });
    expect(await owner.next(answerTo("lv-2"))).toEqual({
      type: "error",
      id: "lv-2",
      message: "the handoff is over",
    });

    // A link reached the one answer to the asking client, and nothing else: no other message to any client, no push,
    // nothing the object stores, nor the transcript or the model's requests.
    const elsewhere = [
      ...owner.received.filter((message) => !answerTo("lv-1")(message)),
      ...other.received,
    ];

    const surfaces = await runInDurableObject(stub, async (instance: TestSession) => [
      JSON.stringify(elsewhere),
      JSON.stringify(instance.notified()),
      instance.kvDump(),
      JSON.stringify(await instance.toolResults()),
      instance.requestMessages().join("\n"),
      instance.harnessDump(),
      JSON.stringify(await instance.snapshot()),
    ]);

    expect(JSON.stringify(owner.received.filter(answerTo("lv-1")))).toContain(TOKEN);

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

    const stray: BrowserHandoffRequest = {
      id: "99",
      // SAFETY: a conversation ID, as the protocol brands it.
      conversationId: 1 as BrowserHandoffRequest["conversationId"],
      instructions: "Log in",
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
