// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentEvent } from "@earendil-works/pi-durable";
import {
  type ClientMessage,
  type ConversationId,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

type Events = Extract<ServerMessage, { type: "events" }>;

/** A client of a Session's socket that keeps every message the Session sent it. */
const connect = async (stub: DurableObjectStub<TestSession>) => {
  const response = await stub.fetch("http://session/socket", { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;

  if (socket === null) throw new Error(`No socket: ${response.status}`);
  socket.accept();

  const received: ServerMessage[] = [];
  const closed = Promise.withResolvers<CloseEvent>();

  socket.addEventListener("message", (event) => {
    received.push(Effect.runSync(decode(event.data)));
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

describe("input submitted while a Run is in progress", () => {
  it("joins the running work as a steer, and starts the next Run as a follow-up", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script(['gate:call:roll_dice:{"count":1,"sides":6}', "steered", "followed up"]),
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

    const submitted = async (id: string) =>
      (await Effect.runPromise(Schema.decodeUnknownEffect(Submitted)(await client.answer(id))))
        .result.submissionId;

    const [a, b, c] = [await submitted("a"), await submitted("b"), await submitted("c")];

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
