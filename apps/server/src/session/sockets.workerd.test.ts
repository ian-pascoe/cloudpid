// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { AgentEvent } from "@earendil-works/pi-durable";
import {
  type ClientMessage,
  ConversationId,
  HEARTBEAT,
  SESSION_DELETED_CLOSE_CODE,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { constructions, REQUEST_COST, type TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
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

let registries = 0;

/** A Registry holding the settings, which `stub` reads them from. */
const registryOf = async (stub: DurableObjectStub<TestSession>) => {
  const name = `settings-registry-${(registries += 1)}`;

  await runInDurableObject(stub, (instance: TestSession) => instance.reportTo(name));

  return env.REGISTRIES.getByName(name);
};

/** The agent a fresh watch of the root opens with: its snapshot's. */
const watchedAgent = async (client: Client) => {
  const root = await client.root();
  const from = client.received.length;

  client.send({ type: "watch", id: `watch-${from}`, conversationId: root });

  const [snapshot] = eventsOf(
    await client.until((messages) => eventsOf(messages, root).length > 0, from),
    root,
  );

  return snapshot?.type === "snapshot" ? snapshot.agent : undefined;
};

describe("what a client first sees of a Session's agent", () => {
  it("is the default in force, for a new Session, before any prompt", async () => {
    const stub = fresh();
    const registry = await registryOf(stub);

    await registry.updateSettings(
      { model: "anthropic/claude-sonnet-5-5", thinkingLevel: "low" },
      1,
    );

    expect(await watchedAgent(await connect(stub))).toEqual({
      model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
      thinkingLevel: "low",
    });
  });

  it("is the changed default, for an idle Session that has run before", async () => {
    const stub = fresh();
    const registry = await registryOf(stub);

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["one"]));
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.prompt({ requestId: "turn-1", text: "hi" }),
    );
    await registry.updateSettings({ model: "anthropic/claude-haiku-5-5" }, 1);

    expect((await watchedAgent(await connect(stub)))?.model).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-5-5",
    });
  });

  it("is the Session's own pick, whatever the default", async () => {
    const stub = fresh();
    const registry = await registryOf(stub);

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.configure({ model: { provider: "anthropic", modelId: "claude-haiku-5-5" } }),
    );
    await registry.updateSettings({ model: "anthropic/claude-sonnet-5-5" }, 1);

    expect((await watchedAgent(await connect(stub)))?.model).toEqual({
      provider: "anthropic",
      modelId: "claude-haiku-5-5",
    });
  });
});

describe("which of its agent a Session says it picked", () => {
  const lastPicked = (messages: readonly ServerMessage[]) =>
    Arr.findLast(messages, (message) => message.type === "picked").pipe(Option.getOrUndefined);

  it("starts with nothing picked, then follows each configure on every connected client", async () => {
    const stub = fresh();
    const first = await connect(stub);
    const second = await connect(stub);

    expect(lastPicked(await first.until((m) => lastPicked(m) !== undefined))).toEqual({
      type: "picked",
      model: false,
      thinkingLevel: false,
    });

    first.send({ type: "configure", id: "pick", model: "anthropic/claude-haiku-5-5" });
    await first.answer("pick");

    for (const client of [first, second]) {
      expect(lastPicked(await client.until((m) => lastPicked(m)?.model === true))).toEqual({
        type: "picked",
        model: true,
        thinkingLevel: false,
      });
    }

    second.send({ type: "configure", id: "both", thinkingLevel: "low" });
    await second.answer("both");
    expect(lastPicked(await first.until((m) => lastPicked(m)?.thinkingLevel === true))).toEqual({
      type: "picked",
      model: true,
      thinkingLevel: true,
    });

    second.send({ type: "configure", id: "clear", model: null, thinkingLevel: null });
    expect(
      lastPicked(
        await first.until(
          (m) => lastPicked(m)?.model === false && lastPicked(m)?.thinkingLevel === false,
        ),
      ),
    ).toEqual({ type: "picked", model: false, thinkingLevel: false });
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

describe("a submit the Session cannot store", () => {
  it("is refused with why, and the Session keeps running for the next one", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["Still here"]));

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");

    const instances = constructions.get(stub.id.toString());

    // Over the 2 MB a row holds: without the guard, the commit fails and takes the Session down with it.
    client.send({
      type: "submit",
      id: "big",
      input: [
        { type: "text", text: "look" },
        { type: "image", mimeType: "image/png", data: "A".repeat(2_200_000) },
      ],
      requestId: "big",
    });
    expect(await client.answer("big")).toMatchObject({
      type: "error",
      message: expect.stringMatching(/^This message is 2\.21 MB, and one holds at most 1\.9 MB/u),
    });

    client.send({
      type: "submit",
      id: "svg",
      input: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }],
      requestId: "svg",
    });
    expect(await client.answer("svg")).toMatchObject({
      type: "error",
      message: "An image must be PNG, JPEG, WebP or GIF to go to the model, not image/svg+xml.",
    });

    client.send({ type: "submit", id: "ok", input: "hi", requestId: "ok" });
    await submitted(client, "ok");

    const events = eventsOf(await client.until((messages) => runEnds(root)(messages) === 1), root);

    expect(answers(events)).toEqual(["Still here"]);
    expect(constructions.get(stub.id.toString())).toBe(instances);
  });

  it("is refused when it would not fit beside the messages already waiting for the run", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script(["gate:first", "queued"]),
    );

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    client.send({ type: "submit", id: "a", input: "start", requestId: "a" });
    await runInDurableObject(stub, (instance: TestSession) => instance.gated.promise);

    // Images, which the model's context counts by the image, not by their size.
    const half = [
      { type: "text" as const, text: "and this" },
      { type: "image" as const, mimeType: "image/png", data: "A".repeat(1_000_000) },
    ];

    client.send({ type: "submit", id: "b", input: half, requestId: "b", whenBusy: "followUp" });
    await submitted(client, "b");
    client.send({ type: "submit", id: "c", input: half, requestId: "c", whenBusy: "followUp" });
    expect(await client.answer("c")).toMatchObject({
      type: "error",
      message: expect.stringMatching(/^The messages waiting for the run and this one are/u),
    });

    await runInDurableObject(stub, (instance: TestSession) => instance.open());

    const events = eventsOf(await client.until((messages) => runEnds(root)(messages) === 2), root);

    expect(answers(events)).toEqual(["first", "queued"]);
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

/** The task graph summaries among `messages`. */
const graphs = (messages: readonly ServerMessage[]) =>
  Arr.filter(messages, (message) => message.type === "task_graph");

describe("a task graph watch", () => {
  it("sends the Session's summary, and stops once unwatched", async () => {
    const stub = fresh();
    const client = await connect(stub);

    client.send({ type: "watch_task_graph", id: "graph" });
    expect(await client.answer("graph")).toEqual({ type: "result", id: "graph", result: null });
    expect(graphs(await client.until((messages) => graphs(messages).length === 1))).toEqual([
      { type: "task_graph", agents: [], background: [] },
    ]);
    expect(await recordedWatches(stub)).toEqual([{ watches: [], taskGraph: true }]);

    client.send({ type: "unwatch_task_graph", id: "unwatch" });
    await client.answer("unwatch");
    expect(await recordedWatches(stub)).toEqual([{ watches: [], taskGraph: false }]);
  });

  it("survives hibernation: the woken Session sends the summary again on the same socket", async () => {
    const stub = fresh();
    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch_task_graph" });
    await client.until((messages) => graphs(messages).length === 1);
    await evictDurableObject(stub);

    const before = client.received.length;

    // A message wakes it.
    client.send({ type: "unwatch", id: "wake", conversationId: root });
    await client.answer("wake");

    expect(graphs(await client.until((messages) => graphs(messages).length === 1, before))).toEqual(
      [{ type: "task_graph", agents: [], background: [] }],
    );
  });
});

/** The usage messages among `messages`, in order. */
const usages = (messages: readonly ServerMessage[]) =>
  Arr.flatMap(messages, (message) => (message.type === "usage" ? [message] : []));

describe("a usage watch", () => {
  it("sends what the Session has spent and its limit, again after each answer, and stops once unwatched", async () => {
    const stub = fresh();
    const registry = await registryOf(stub);
    const client = await connect(stub);

    await registry.updateSettings({ spendLimit: { perSession: 5 } }, 1);
    await runInDurableObject(stub, (instance: TestSession) => instance.script(["It is done."]));

    client.send({ type: "watch_usage", id: "usage" });
    expect(await client.answer("usage")).toEqual({ type: "result", id: "usage", result: null });

    // Nothing spent yet, and no limit: the Session reads the saved settings when it admits a request.
    const [first] = usages(await client.until((messages) => usages(messages).length === 1));

    expect(first).toMatchObject({ type: "usage", cost: 0, totalTokens: 0 });
    expect(await recordedWatches(stub)).toEqual([{ watches: [], usage: true }]);

    client.send({
      type: "submit",
      id: "submit",
      input: "Do it",
    });

    const spent = usages(
      await client.until((messages) => Arr.some(usages(messages), (usage) => usage.cost > 0)),
    ).at(-1);

    expect(spent?.cost).toBeCloseTo(REQUEST_COST);
    expect(spent?.totalTokens).toBeGreaterThan(0);
    expect(spent?.limit).toBe(5);
    // The active branch's Context Window, against the faux model's 128k.
    expect(spent?.context?.contextWindow).toBe(128_000);
    expect(spent?.context?.tokens).toBeGreaterThan(0);
    expect(spent?.context?.compactAt).toBeLessThan(128_000);

    client.send({ type: "unwatch_usage", id: "unwatch" });
    await client.answer("unwatch");
    expect(await recordedWatches(stub)).toEqual([{ watches: [], usage: false }]);
  });

  it("sends the new limit when a read of the settings changes it, though the Session is idle", async () => {
    const stub = fresh();
    const registry = await registryOf(stub);
    const client = await connect(stub);

    client.send({ type: "watch_usage" });
    await client.until((messages) => usages(messages).length === 1);

    await registry.updateSettings({ spendLimit: { perSession: 3 } }, 1);

    // Any command reads the settings first; this one changes nothing else.
    client.send({ type: "configure", id: "read" });
    await client.answer("read");

    const sent = usages(
      await client.until((messages) => Arr.some(usages(messages), (usage) => usage.limit === 3)),
    );

    expect(sent.at(-1)).toMatchObject({ limit: 3, cost: 0 });
  });

  it("survives hibernation: the woken Session sends the usage again on the same socket", async () => {
    const stub = fresh();
    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch_usage" });
    await client.until((messages) => usages(messages).length === 1);
    await evictDurableObject(stub);

    const before = client.received.length;

    // A message wakes it.
    client.send({ type: "unwatch", id: "wake", conversationId: root });
    await client.answer("wake");

    expect(usages(await client.until((messages) => usages(messages).length === 1, before))).toEqual(
      [expect.objectContaining({ type: "usage", cost: 0, limit: null })],
    );
  });
});

/** The Todo Lists among `messages`, of conversation `conversationId`, in order. */
const todoLists = (messages: readonly ServerMessage[], conversationId: ConversationId) =>
  Arr.flatMap(messages, (message) =>
    message.type === "todos" && message.conversationId === conversationId ? [message.tasks] : [],
  );

const ADD_TASKS = `call:todo:${JSON.stringify({
  action: "add",
  tasks: [{ title: "Write the tool" }, { title: "Test it", description: "Through runs" }],
})}`;

describe("a Todo List watch", () => {
  it("sends the list after the snapshot, and again each time the agent changes it", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script([
        ADD_TASKS,
        `call:todo:${JSON.stringify({ action: "update", id: 1, status: "completed" })}`,
        "Done.",
      ]),
    );

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");

    // Empty until the agent first uses the tool, and sent after the conversation's snapshot.
    await client.until((messages) => todoLists(messages, root).length === 1);
    expect(todoLists(client.received, root)).toEqual([[]]);
    const order = Arr.map(client.received, (message) => message.type);

    expect(order.indexOf("todos")).toBeGreaterThan(order.indexOf("events"));

    client.send({ type: "submit", id: "submit", input: "plan it", requestId: "turn-1" });

    const lists = todoLists(await client.until((m) => todoLists(m, root).length === 3), root);

    expect(lists.slice(1)).toEqual([
      [
        { id: 1, title: "Write the tool", status: "pending" },
        { id: 2, title: "Test it", description: "Through runs", status: "pending" },
      ],
      [
        { id: 1, title: "Write the tool", status: "completed" },
        { id: 2, title: "Test it", description: "Through runs", status: "pending" },
      ],
    ]);
  });

  it("survives hibernation: the woken Session sends the list again on the same socket", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script([ADD_TASKS, "Done."]),
    );

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.until((messages) => todoLists(messages, root).length === 1);
    client.send({ type: "submit", id: "submit", input: "plan it", requestId: "turn-1" });
    await client.until((messages) => todoLists(messages, root).length === 2);
    await idle(stub);
    await evictDurableObject(stub);

    const before = client.received.length;

    // A message wakes it, and the watch it restarts sends the list as it stands.
    client.send({ type: "abort", id: "wake" });
    await client.answer("wake");

    const lists = todoLists(
      await client.until((messages) => todoLists(messages, root).length === 1, before),
      root,
    );

    expect(lists[0]).toHaveLength(2);
  });

  it("does not outlive an unwatch that comes while the snapshot is being made", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script([ADD_TASKS, "Done."]),
    );

    const client = await connect(stub);
    const root = await client.root();

    // Both commands are on the socket before the first snapshot is sent.
    client.send({ type: "watch", id: "watch", conversationId: root });
    client.send({ type: "unwatch", id: "unwatch", conversationId: root });
    await client.answer("unwatch");
    await client.answer("watch");
    client.send({ type: "submit", id: "submit", input: "plan it", requestId: "turn-1" });
    await submitted(client, "submit");
    await idle(stub);

    // Whatever list was sent before the unwatch, none of the agent's changes came after it.
    expect(todoLists(client.received, root).flat()).toEqual([]);
    expect(await recordedWatches(stub)).toEqual([{ watches: [] }]);
  });

  it("stops once the conversation is unwatched", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script([ADD_TASKS, "Done."]),
    );

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");
    await client.until((messages) => todoLists(messages, root).length === 1);

    client.send({ type: "unwatch", id: "unwatch", conversationId: root });
    await client.answer("unwatch");
    client.send({ type: "submit", id: "submit", input: "plan it", requestId: "turn-1" });
    await submitted(client, "submit");
    await idle(stub);

    expect(todoLists(client.received, root)).toEqual([[]]);
  });
});

describe("owner commands addressed to a conversation", () => {
  it("are refused, with the command's id, when it is neither the root nor a subagent's", async () => {
    const client = await connect(fresh());
    const root = await client.root();

    const stranger = await Effect.runPromise(
      Schema.decodeUnknownEffect(ConversationId)(root + 1000),
    );

    client.send({ type: "submit", id: "submit", conversationId: stranger, input: "hi" });
    client.send({ type: "abort", id: "abort", conversationId: stranger });
    client.send({ type: "history", id: "history", conversationId: stranger, before: 10 });

    expect(await client.answer("submit")).toMatchObject({ type: "error", id: "submit" });
    expect(await client.answer("abort")).toMatchObject({ type: "error", id: "abort" });
    expect(await client.answer("history")).toMatchObject({ type: "error", id: "history" });
  });
});

describe("history", () => {
  it("answers the root's entries before the one asked for, oldest first", async () => {
    const stub = fresh();
    const client = await connect(stub);

    await client.root();
    client.send({ type: "submit", id: "submit", input: "hi", requestId: "turn-1" });
    await submitted(client, "submit");
    await idle(stub);
    client.send({ type: "history", id: "history", before: 1_000_000 });

    const answer = await client.answer("history");

    expect(answer).toMatchObject({
      type: "result",
      id: "history",
      result: { before: null, entries: [{ kind: "pi.user" }, { kind: "pi.assistant" }] },
    });
  });
});

describe("deleting a Session", () => {
  it("stops its Run and subagents, closes its clients' sockets as deleted, and wipes its storage", async () => {
    const stub = env.SESSIONS.getByName("delete-me");
    const client = await connect(stub);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["hang"]);
      await instance.submit({ requestId: "turn-1", text: "hi" });
      await instance.hanging.promise;
    });

    // Read in the instance that deleted it: a later call would start a new instance, which opens a fresh Session.
    const left = await runInDurableObject(stub, async (instance: TestSession, state) => {
      await instance.destroy();

      return {
        tables: state.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%'",
          )
          .toArray(),
        keys: [...state.storage.kv.list()],
        alarm: await state.storage.getAlarm(),
      };
    });

    expect(left).toEqual({ tables: [], keys: [], alarm: null });
    expect((await client.closed).code).toBe(SESSION_DELETED_CLOSE_CODE);
  });
});
