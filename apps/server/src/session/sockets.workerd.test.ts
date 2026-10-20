// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentEvent } from "@earendil-works/pi-durable";
import {
  type ClientMessage,
  ConversationId,
  HEARTBEAT,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { constructions, type TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

type Events = Extract<ServerMessage, { type: "events" }>;

/** A client of a Session's socket that keeps every message the Session sent it. */
const connect = async (stub: DurableObjectStub<TestSession>) => {
  const response = await stub.fetch("http://session/socket", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null) throw new Error(`No socket: ${response.status}`);
  socket.accept();

  const received: ServerMessage[] = [];
  const closed = Promise.withResolvers<CloseEvent>();

  /** How many heartbeat replies arrived. */
  let pongs = 0;

  socket.addEventListener("message", (event) => {
    if (event.data === HEARTBEAT.response) pongs += 1;
    else received.push(Effect.runSync(decode(event.data)));
  });
  socket.addEventListener("close", (event) => {
    closed.resolve(event);
  });

  /** Messages after `from`, once `done` holds of them. */
  const until = async (done: (messages: readonly ServerMessage[]) => boolean, from = 0) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      const messages = received.slice(from);

      if (done(messages)) return messages;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(
      `Never received the expected messages: ${JSON.stringify(received.slice(from))}`,
    );
  };

  return {
    received,
    closed: closed.promise,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    /** Send `text` as it is, as a client that does not follow the protocol would. */
    sendText: (text: string) => socket.send(text),
    pongs: () => pongs,
    until,
    /** The answer to command `id`. */
    answer: async (id: string) => {
      const answered = (message: ServerMessage) => "id" in message && message.id === id;

      return Arr.findFirst(await until(Arr.some(answered)), answered).pipe(Option.getOrUndefined);
    },
    /** The root conversation's ID, from the hello. */
    root: async () => {
      const [hello] = await until((messages) => messages[0]?.type === "hello");

      if (hello?.type !== "hello") throw new Error("No hello");

      return hello.root;
    },
  };
};

type Client = Awaited<ReturnType<typeof connect>>;

/** The event batches among `messages`, in order. */
const batches = (messages: readonly ServerMessage[]): Events[] =>
  Arr.filter(messages, (message): message is Events => message.type === "events");

/** Every event of conversation `conversationId` among `messages`, in order. */
const eventsOf = (
  messages: readonly ServerMessage[],
  conversationId: ConversationId,
): readonly AgentEvent[] =>
  Arr.flatMap(batches(messages), (message) =>
    message.conversationId === conversationId ? message.events : [],
  );

/** The text of each assistant message the events ended, in order. */
const answers = (events: readonly AgentEvent[]): string[] =>
  Arr.flatMap(events, (event) => {
    const message = event.type === "message_end" ? event.entry.model?.[0] : undefined;

    return message?.role === "assistant"
      ? [
          Arr.join(
            Arr.flatMap(message.content, (block) => (block.type === "text" ? [block.text] : [])),
            "",
          ),
        ]
      : [];
  });

/** The type of each event, in order. */
const types = (events: readonly AgentEvent[]) => Arr.map(events, (event) => event.type);

const runEnds = (conversationId: ConversationId) => (messages: readonly ServerMessage[]) =>
  Arr.filter(eventsOf(messages, conversationId), (event) => event.type === "run_end").length;

/** A submit's answer. */
const Submitted = Schema.Struct({
  type: Schema.Literal("result"),
  result: Schema.Struct({ submissionId: Schema.Finite }),
});

/** Wait until `stub`'s Session has no work live. */
const idle = async (stub: DurableObjectStub<TestSession>) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await runInDurableObject(stub, (instance: TestSession) => instance.idle())) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Never idle");
};

/** The conversations each of `stub`'s sockets records as watched, read inside the object. */
const recordedWatches = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (_instance: TestSession, state) =>
    Arr.map(state.getWebSockets(), (socket) => socket.deserializeAttachment()),
  );

/** The submission ID a submit `id` was answered with. */
const submitted = async (client: Client, id: string) =>
  (await Effect.runPromise(Schema.decodeUnknownEffect(Submitted)(await client.answer(id)))).result
    .submissionId;

const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

describe("a Session's socket", () => {
  it("streams a submitted prompt's agent events, after a snapshot, through to the final answer", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["Hello there"]));

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    expect(await client.answer("watch")).toEqual({ type: "result", id: "watch", result: null });

    const [first] = batches(client.received);

    expect(types(first?.events ?? [])).toEqual(["snapshot"]);

    client.send({ type: "submit", id: "submit", input: "hi", requestId: "turn-1" });
    expect(await client.answer("submit")).toMatchObject({
      type: "result",
      result: { submissionId: expect.any(Number) },
    });

    const events = eventsOf(await client.until((messages) => runEnds(root)(messages) === 1), root);

    expect(types(events)).toEqual(
      expect.arrayContaining(["run_start", "turn_start", "message_end", "turn_end", "run_end"]),
    );
    expect(answers(events)).toEqual(["Hello there"]);
  });
});

describe("a Session's commands", () => {
  it("answer a message that is not a valid command with an error that carries its id", async () => {
    const client = await connect(fresh());

    client.sendText('{"type":"submit","id":"missing input"}');
    client.sendText('{"type":"submit","id":"misspelt","input":"hi","whenbusy":"steer"}');
    client.sendText("not json");

    expect(await client.answer("missing input")).toMatchObject({ type: "error" });
    expect(await client.answer("misspelt")).toMatchObject({ type: "error" });
    expect(
      await client.until((messages) =>
        Arr.some(messages, (message) => message.type === "error" && !("id" in message)),
      ),
    ).not.toHaveLength(0);
  });

  it("admit a submit resent with its requestId once", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["Once"]));

    const client = await connect(stub);

    client.send({ type: "submit", id: "first", input: "hi", requestId: "turn-1" });
    client.send({ type: "submit", id: "again", input: "hi", requestId: "turn-1" });

    expect(await submitted(client, "again")).toBe(await submitted(client, "first"));
  });
});

describe("a Session's configure command", () => {
  /** The agent each `agent_changed` event among `messages` reports, in order. */
  const agents = (messages: readonly ServerMessage[], conversationId: ConversationId) =>
    Arr.flatMap(eventsOf(messages, conversationId), (event) =>
      event.type === "agent_changed" ? [event.agent] : [],
    );

  it("picks the model and thinking level of the next request and tells every watching client", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["Hello there"]));

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    client.send({
      type: "configure",
      id: "pick",
      model: "anthropic/claude-sonnet-5-5",
      thinkingLevel: "low",
    });
    expect(await client.answer("pick")).toEqual({ type: "result", id: "pick", result: null });

    const changed = await client.until((messages) => agents(messages, root).length > 0);

    expect(agents(changed, root).at(-1)).toEqual({
      model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
      thinkingLevel: "low",
    });

    client.send({ type: "submit", id: "submit", input: "hi", requestId: "turn-1" });
    await client.until((messages) => runEnds(root)(messages) === 1);
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.requests())).toEqual([
      { model: "claude-sonnet-5-5", thinking: "low" },
    ]);
  });

  it("returns the Session to the default when a field is null", async () => {
    const client = await connect(fresh());
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    client.send({ type: "configure", id: "pick", model: "anthropic/claude-haiku-5-5" });
    await client.answer("pick");
    client.send({ type: "configure", id: "clear", model: null });
    expect(await client.answer("clear")).toEqual({ type: "result", id: "clear", result: null });

    const messages = await client.until((received) => agents(received, root).length > 1);

    expect(agents(messages, root).at(-1)?.model).toEqual({
      provider: "anthropic",
      modelId: "claude-opus-5-5",
    });
  });

  it("answers a model the proxy does not serve with an error that carries its id", async () => {
    const client = await connect(fresh());

    client.sendText('{"type":"configure","id":"bad","model":"anthropic/claude-nope"}');

    expect(await client.answer("bad")).toMatchObject({ type: "error" });
  });
});

describe("input submitted while a Run is in progress", () => {
  it("joins the running work as a steer, and starts the next Run as a follow-up", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script(['gate:call:echo:{"text":"hi"}', "steered", "followed up"]),
    );

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    client.send({ type: "submit", id: "a", input: "start", requestId: "a" });
    await runInDurableObject(stub, (instance: TestSession) => instance.gated.promise);
    client.send({ type: "submit", id: "b", input: "also this", requestId: "b", whenBusy: "steer" });
    client.send({
      type: "submit",
      id: "c",
      input: "then this",
      requestId: "c",
      whenBusy: "followUp",
    });

    const [a, b, c] = [
      await submitted(client, "a"),
      await submitted(client, "b"),
      await submitted(client, "c"),
    ];

    await runInDurableObject(stub, (instance: TestSession) => instance.open());

    const events = eventsOf(await client.until((messages) => runEnds(root)(messages) === 2), root);

    const runs = Arr.flatMap(events, (event) =>
      event.type === "run_start" || event.type === "run_end" ? [[event.type, event.inputs]] : [],
    );

    expect(runs).toEqual([
      ["run_start", [a]],
      ["run_end", [a, b]],
      ["run_start", [c]],
      ["run_end", [c]],
    ]);
    // The steer reached the model in the first Run, after the tool call it was submitted during.
    expect(answers(events)).toEqual(["", "steered", "followed up"]);
  });
});

describe("an abort", () => {
  it("ends the running Run and leaves the submission unanswered", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["hang"]));

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    client.send({ type: "submit", id: "submit", input: "hi", requestId: "turn-1" });
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);
    client.send({ type: "abort", id: "abort" });

    expect(await client.answer("abort")).toEqual({ type: "result", id: "abort", result: null });

    const events = eventsOf(await client.until((messages) => runEnds(root)(messages) === 1), root);

    const settled = Arr.flatMap(events, (event) =>
      event.type === "submission" ? [event.record.status] : [],
    );

    expect(settled.at(-1)).toBe("unanswered");
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true);
  });
});

describe("a watch", () => {
  it("of a conversation the Session does not have answers with an error", async () => {
    const client = await connect(fresh());
    const root = await client.root();

    const unknown = await Effect.runPromise(
      Schema.decodeUnknownEffect(ConversationId)(root + 1000),
    );

    client.send({ type: "watch", id: "watch", conversationId: unknown });

    expect(await client.answer("watch")).toMatchObject({ type: "error", id: "watch" });
  });

  it("stops streaming once unwatched", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["Unseen"]));

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    client.send({ type: "unwatch", id: "unwatch", conversationId: root });
    await client.answer("unwatch");

    const before = client.received.length;

    client.send({ type: "submit", id: "submit", input: "hi", requestId: "turn-1" });
    await client.answer("submit");
    await idle(stub);

    expect(batches(client.received.slice(before))).toEqual([]);
    expect(await recordedWatches(stub)).toEqual([{ watches: [] }]);
  });

  it("dropped while it starts is not restarted on wake", async () => {
    const stub = fresh();
    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    client.send({ type: "unwatch", id: "unwatch", conversationId: root });
    await client.answer("watch");
    await client.answer("unwatch");
    await evictDurableObject(stub);

    const before = client.received.length;

    // Waking it would restart a recorded watch, and send its snapshot.
    expect(await recordedWatches(stub)).toEqual([{ watches: [] }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(batches(client.received.slice(before))).toEqual([]);
  });

  it("that cannot restart on wake is dropped, and the client told which", async () => {
    const stub = fresh();
    const client = await connect(stub);
    const root = await client.root();
    const gone = await Effect.runPromise(Schema.decodeUnknownEffect(ConversationId)(root + 1000));

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    // A conversation the Session no longer has, as if it were deleted while the object slept.
    await runInDurableObject(stub, (_instance: TestSession, state) => {
      for (const socket of state.getWebSockets())
        socket.serializeAttachment({ watches: [root, gone] });
    });
    await evictDurableObject(stub);

    const before = client.received.length;

    // Waking restarts the watches: the root's with a snapshot, the other's not at all.
    expect(await recordedWatches(stub)).toEqual([{ watches: [root] }]);

    const woken = await client.until((messages) => messages.length >= 2, before);

    expect(woken).toContainEqual({
      type: "error",
      conversationId: gone,
      message: expect.any(String),
    });
    expect(types(eventsOf(woken, root))).toEqual(["snapshot"]);

    // The next wake does not retry it.
    await evictDurableObject(stub);

    const again = client.received.length;

    await recordedWatches(stub);
    await client.until((messages) => messages.length >= 1, again);
    expect(Arr.filter(client.received.slice(again), (message) => message.type === "error")).toEqual(
      [],
    );
  });

  it("answers the heartbeat while the Session hibernates, without waking it", async () => {
    const stub = fresh();
    const client = await connect(stub);

    client.send({ type: "watch", id: "watch", conversationId: await client.root() });
    await client.answer("watch");
    await evictDurableObject(stub);

    const instances = constructions.get(stub.id.toString());

    expect(instances).toBe(1);

    client.sendText(HEARTBEAT.request);

    for (let attempt = 0; attempt < 300 && client.pongs() === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(client.pongs()).toBe(1);
    expect(constructions.get(stub.id.toString())).toBe(instances);
  });

  it("survives hibernation: the woken Session sends a fresh snapshot and keeps streaming on the same socket", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script(["Before the nap", "After the nap"]),
    );

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    client.send({ type: "submit", id: "first", input: "hi", requestId: "turn-1" });
    await client.until((messages) => runEnds(root)(messages) === 1);

    // Hibernate: the object leaves memory, and its sockets stay open.
    await evictDurableObject(stub);

    const before = client.received.length;

    // A message wakes it.
    client.send({ type: "submit", id: "second", input: "again", requestId: "turn-2" });

    const after = await client.until((messages) => runEnds(root)(messages) === 1, before);
    const [first, ...rest] = batches(after);

    expect(types(first?.events ?? [])).toEqual(["snapshot"]);
    expect(answers(eventsOf(rest, root))).toEqual(["After the nap"]);
  });

  it("restarts for a client that reconnects after an eviction closed its socket, with the resumed Run's events", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script(["hang", "gate:recovered"]),
    );

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    client.send({ type: "submit", id: "submit", input: "hi", requestId: "turn-1" });
    await runInDurableObject(stub, (instance: TestSession) => instance.hanging.promise);

    // Evicted mid-Run, as by a deploy: the object leaves memory and its sockets close.
    await evictDurableObject(stub, { webSockets: "close" });

    const again = await connect(stub);

    again.send({ type: "watch", id: "watch", conversationId: await again.root() });
    await again.answer("watch");
    // The new instance resumed the Run, whose model request now waits at the gate.
    await runInDurableObject(stub, (instance: TestSession) => instance.open());

    const messages = await again.until((received) => runEnds(root)(received) === 1);
    const [first] = batches(messages);
    const snapshot = first?.events[0];

    // The snapshot holds the transcript so far, then the resumed Run streams to its answer.
    expect(snapshot?.type === "snapshot" ? snapshot.entries.length : 0).toBeGreaterThan(0);
    expect(answers(eventsOf(messages, root))).toEqual(["recovered"]);
    expect(
      await Promise.race([
        client.closed.then(() => "closed"),
        new Promise((r) => setTimeout(() => r("open"), 500)),
      ]),
    ).toBe("closed");
  });
});
