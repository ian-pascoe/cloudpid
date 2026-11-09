// workerd's Durable Object, WebSocket, and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { AgentState, ConversationView, LiveState } from "@earendil-works/pi-durable";
import {
  type ClientMessage,
  ConversationId,
  EMPTY_VIEW,
  HEARTBEAT,
  SESSION_DELETED_CLOSE_CODE,
  ServerMessageJson,
  type ServerMessage,
  type SessionView,
} from "@cloudpid/protocol";
import { ConversationMirror } from "@cloudpid/protocol/mirror";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { TestRegistry } from "../registry/store.fixture.ts";
import {
  CHANGES_TEST_DEBOUNCE_MS,
  type ChangesFixture,
  constructions,
  REQUEST_COST,
  type TestSession,
} from "./host.fixture.ts";
import { idle } from "../durable-waits.fixture.ts";
import { poll } from "../poll.fixture.ts";
import { approvalRequests } from "./sockets.ts";

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

type Frame = Extract<ServerMessage, { type: "view" | "ops" }>;

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
    let messages: readonly ServerMessage[] = [];

    await poll(
      () => {
        messages = received.slice(from);

        return done(messages);
      },
      () => `Never received the expected messages: ${JSON.stringify(received.slice(from))}`,
    );

    return messages;
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

/** The frames of conversation watches among `messages`, in order. */
const frames = (messages: readonly ServerMessage[]): Frame[] =>
  Arr.filter(
    messages,
    (message): message is Frame => message.type === "view" || message.type === "ops",
  );

/** The frames of conversation `conversationId`'s watch among `messages`, in order. */
const framesOf = (messages: readonly ServerMessage[], conversationId: ConversationId) =>
  Arr.filter(frames(messages), (frame) => frame.conversationId === conversationId);

/** pi's view of conversation `conversationId` after each of its frames among `messages`, as a client applies them. */
const viewsOf = (
  messages: readonly ServerMessage[],
  conversationId: ConversationId,
): readonly ConversationView[] => {
  let view: ConversationView | undefined;

  return Arr.flatMap(framesOf(messages, conversationId), (frame) => {
    if (frame.type === "view") view = frame.view;
    else if (view !== undefined) view = applyImmutable(view, frame.ops);

    return view === undefined ? [] : [view];
  });
};

// SAFETY: `pi.live` is pi's live document, with its shape.
const liveOf = (view: ConversationView) => (view.docs["pi.live"] ?? {}) as LiveState;

/** The agent of a conversation that has made no choices of its own. */
const NO_AGENT: AgentState = {};

// SAFETY: `pi.agent` is pi's agent document, with its shape.
const agentOf = (view: ConversationView) =>
  (view.docs["pi.agent"] as AgentState | undefined) ?? NO_AGENT;

/** What a client shows of conversation `conversationId` once it got `messages`: its frames merged into a transcript. */
const shownOf = (
  messages: readonly ServerMessage[],
  conversationId: ConversationId,
): SessionView => {
  const mirror = new ConversationMirror(() => Promise.reject(new Error("No pages in these tests")));

  for (const frame of framesOf(messages, conversationId)) mirror.receive(frame);

  return mirror.started ? mirror.view() : EMPTY_VIEW;
};

/** The text of each assistant message a view shows, in order. */
const answers = (view: SessionView): string[] =>
  Arr.flatMap(view.messages, (message) =>
    message.role === "assistant"
      ? [
          Arr.join(
            Arr.flatMap(message.parts, (part) => (part.type === "text" ? [part.text] : [])),
            "",
          ),
        ]
      : [],
  );

/**
 * The Runs conversation `conversationId`'s views among `messages` show, in order: the inputs each started with, the
 * inputs it settles (`pi.live.run.inputs`, steers placed in it included), and whether it ended. A Run is told from the
 * next by its first input, as one can follow another in the same commit.
 */
const runsOf = (messages: readonly ServerMessage[], conversationId: ConversationId) => {
  const runs: { started: readonly number[]; inputs: readonly number[]; ended: boolean }[] = [];

  for (const view of viewsOf(messages, conversationId)) {
    const run = liveOf(view).run;
    const last = runs.at(-1);
    const open = last !== undefined && !last.ended ? last : undefined;

    if (run === undefined) {
      if (open !== undefined) open.ended = true;

      continue;
    }

    const first = run.inputs[0];

    if (open !== undefined && (first === undefined || first === open.started[0])) {
      // A Run that answered keeps no inputs while its `afterRun` tasks run.
      if (run.inputs.length > 0) open.inputs = run.inputs;

      continue;
    }

    if (open !== undefined) open.ended = true;

    runs.push({ started: run.inputs, inputs: run.inputs, ended: false });
  }

  return runs;
};

const runEnds = (conversationId: ConversationId) => (messages: readonly ServerMessage[]) =>
  Arr.filter(runsOf(messages, conversationId), (run) => run.ended).length;

/** A submit's answer. */
const Submitted = Schema.Struct({
  type: Schema.Literal("result"),
  result: Schema.Struct({ submissionId: Schema.Finite }),
});

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
  it("streams a submitted prompt's conversation view, then its changes, through to the final answer", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["Hello there"]));

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch", id: "watch", conversationId: root });
    expect(await client.answer("watch")).toEqual({ type: "result", id: "watch", result: null });

    const [first] = frames(client.received);

    expect(first?.type).toBe("view");

    client.send({ type: "submit", id: "submit", input: "hi", requestId: "turn-1" });
    expect(await client.answer("submit")).toMatchObject({
      type: "result",
      result: { submissionId: expect.any(Number) },
    });

    const messages = await client.until((received) => runEnds(root)(received) === 1);

    // After the view, only its changes: a Run that starts, streams and ends.
    expect(Arr.map(frames(messages).slice(1), (frame) => frame.type)).not.toContain("view");
    expect(runsOf(messages, root)).toHaveLength(1);
    expect(answers(shownOf(messages, root))).toEqual(["Hello there"]);
    expect(shownOf(messages, root)).toMatchObject({ running: false, live: null, error: null });
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

/** The agent a fresh watch of the root opens with: its view's. */
const watchedAgent = async (client: Client) => {
  const root = await client.root();
  const from = client.received.length;

  client.send({ type: "watch", id: `watch-${from}`, conversationId: root });

  const [view] = viewsOf(
    await client.until((messages) => viewsOf(messages, root).length > 0, from),
    root,
  );

  return view === undefined ? undefined : agentOf(view);
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
  /** The agent each change of `pi.agent` in the views among `messages` shows, in order, after the first view's. */
  const agents = (messages: readonly ServerMessage[], conversationId: ConversationId) => {
    const shown = Arr.map(viewsOf(messages, conversationId), agentOf);

    return Arr.filter(shown, (agent, index) => index > 0 && agent !== shown[index - 1]);
  };

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

    const messages = await client.until(
      (received) => agents(received, root).at(-1)?.model?.modelId === "claude-opus-5-5",
    );

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

    const messages = await client.until((received) => runEnds(root)(received) === 2);

    expect(runsOf(messages, root)).toEqual([
      { started: [a], inputs: [a, b], ended: true },
      { started: [c], inputs: [c], ended: true },
    ]);
    // The steer reached the model in the first Run, after the tool call it was submitted during.
    expect(answers(shownOf(messages, root))).toEqual(["", "steered", "followed up"]);
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

    // Over `MAX_STORED_INPUT_BYTES`, though under the 8 MiB a row holds (workerd#7493): refused before it is stored.
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

    const messages = await client.until((received) => runEnds(root)(received) === 1);

    expect(answers(shownOf(messages, root))).toEqual(["Still here"]);
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

    const messages = await client.until((received) => runEnds(root)(received) === 2);

    expect(answers(shownOf(messages, root))).toEqual(["first", "queued"]);
  });
});

describe("an abort", () => {
  it("ends the running Run without an answer, and shows no error for it", async () => {
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

    const messages = await client.until((received) => runEnds(root)(received) === 1);
    const last = viewsOf(messages, root).at(-1);

    expect(last === undefined ? undefined : liveOf(last).runFailure?.reason).toBe("aborted");
    expect(shownOf(messages, root)).toMatchObject({ running: false, error: null });
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true);
  });
});

describe("a watch", () => {
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

    expect(frames(client.received.slice(before))).toEqual([]);
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

    // Waking it would restart a recorded watch, and send its view.
    expect(await recordedWatches(stub)).toEqual([{ watches: [] }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(frames(client.received.slice(before))).toEqual([]);
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

    // Waking restarts the watches: the root's with a view, the other's not at all.
    expect(await recordedWatches(stub)).toEqual([{ watches: [root] }]);

    // The root's view and the error, not any two messages: the root's Todo List and App calls may come first.
    const woken = await client.until(
      (messages) =>
        framesOf(messages, root).length > 0 &&
        Arr.some(messages, (message) => message.type === "error"),
      before,
    );

    expect(woken).toContainEqual({
      type: "error",
      conversationId: gone,
      message: expect.any(String),
    });
    expect(Arr.map(framesOf(woken, root), (frame) => frame.type)).toEqual(["view"]);

    // The next wake does not retry it. The root's view says the wake restarted the watches, and the answer to a
    // command sent after the wake comes after all it sent, an error included.
    await evictDurableObject(stub);

    const again = client.received.length;

    await recordedWatches(stub);
    client.send({ type: "configure", id: "after" });

    const rewoken = await client.until(
      (messages) =>
        framesOf(messages, root).length > 0 &&
        Arr.some(messages, (message) => "id" in message && message.id === "after"),
      again,
    );

    expect(Arr.filter(rewoken, (message) => message.type === "error")).toEqual([]);
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

    await poll(() => client.pongs() > 0);
    expect(client.pongs()).toBe(1);
    expect(constructions.get(stub.id.toString())).toBe(instances);
  });

  it("survives hibernation: the woken Session sends a new view and keeps streaming on the same socket", async () => {
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
    const [first] = frames(after);

    expect(first?.type).toBe("view");
    // Merged into what the client had, the transcript goes on from where it was.
    expect(answers(shownOf(client.received, root))).toEqual(["Before the nap", "After the nap"]);
  });

  it("restarts for a client that reconnects after an eviction closed its socket, with the resumed Run's changes", async () => {
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
    const [first] = frames(messages);

    // The view holds the transcript so far, then the resumed Run streams to its answer.
    expect(first?.type === "view" ? first.view.entries.length : 0).toBeGreaterThan(0);
    expect(answers(shownOf(messages, root)).at(-1)).toBe("recovered");
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
});

type ChangesMessage = Extract<ServerMessage, { type: "changes" }>;

/** The `changes` messages among `messages`, in order. */
const changeLists = (messages: readonly ServerMessage[]) =>
  Arr.filter(messages, (message): message is ChangesMessage => message.type === "changes");

/** One repo's Changes: a file edited, as the Workspace DO lists it, or its last list, "may be out of date". */
const repoChanges = (path: string, stale = false) => ({
  repo: "app",
  head: { commit: "a".repeat(40), branch: "main" },
  files: [{ path, status: "modified" as const, additions: 1, deletions: 1 }],
  more: 0,
  stale,
});

const setChanges = (stub: DurableObjectStub<TestSession>, fixture: ChangesFixture) =>
  runInDurableObject(stub, (instance: TestSession) => instance.setChanges(fixture));

const changesCalls = (stub: DurableObjectStub<TestSession>) =>
  runInDurableObject(stub, (instance: TestSession) => instance.changesCalls());

describe("a Changes watch", () => {
  it("lists the Changes once for every client that watches them, and sends each the list", async () => {
    const stub = fresh();

    // The first listing waits until all three watch, however slowly a loaded runner sends their watches.
    await setChanges(stub, { running: { repos: [repoChanges("a.ts")] }, held: true });

    const first = await connect(stub);
    const second = await connect(stub);
    const third = await connect(stub);

    first.send({ type: "watch_changes", id: "watch" });
    second.send({ type: "watch_changes", id: "watch" });
    third.send({ type: "watch_changes", id: "watch" });
    expect(await first.answer("watch")).toEqual({ type: "result", id: "watch", result: null });
    await second.answer("watch");
    await third.answer("watch");
    await runInDurableObject(stub, (instance: TestSession) => instance.releaseChanges());

    const sent = { type: "changes", repos: [repoChanges("a.ts")], startingContainer: false };

    // The second and third watches came while the first listing ran: one more after it, for all three, where one
    // listing per client would make three. Wait for both: the second can land before a busy runner looks for the first.
    for (const client of [first, second, third]) {
      expect(
        changeLists(await client.until((messages) => changeLists(messages).length >= 2)),
      ).toEqual([sent, sent]);
    }

    expect(await changesCalls(stub)).toEqual([false, false]);
    expect(await recordedWatches(stub)).toEqual([
      { watches: [], changes: true },
      { watches: [], changes: true },
      { watches: [], changes: true },
    ]);

    // A refresh (the page regained focus) is one listing, and is answered once its list is sent.
    await setChanges(stub, { running: { repos: [repoChanges("b.ts")] } });
    first.send({ type: "refresh_changes", id: "refresh" });
    await first.answer("refresh");

    const listsB = (messages: readonly ServerMessage[]) =>
      Arr.some(changeLists(messages), (list) => list.repos[0]?.files[0]?.path === "b.ts");

    await first.until(listsB);
    await second.until(listsB);
    await third.until(listsB);
    expect(await changesCalls(stub)).toEqual([false, false, false]);

    second.send({ type: "unwatch_changes", id: "unwatch" });
    await second.answer("unwatch");
    expect(await recordedWatches(stub)).toEqual(
      expect.arrayContaining([
        { watches: [], changes: true },
        { watches: [], changes: false },
      ]),
    );
  });

  it("lists them again a while after an agent's writes, once for a burst", async () => {
    const stub = fresh();

    await setChanges(stub, { running: { repos: [repoChanges("a.ts")] } });

    const client = await connect(stub);

    client.send({ type: "watch_changes", id: "watch" });
    await client.until((messages) => changeLists(messages).length === 1);

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.wrote();
      instance.wrote();
      instance.wrote();
    });
    await client.until((messages) => changeLists(messages).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 3 * CHANGES_TEST_DEBOUNCE_MS));

    expect(changeLists(client.received)).toHaveLength(2);
    expect(await changesCalls(stub)).toEqual([false, false]);
  });

  it("shows a repo that needs a stopped Container as last listed, and starts it only for the owner's Refresh", async () => {
    const stub = fresh();

    await setChanges(stub, {
      running: { repos: [repoChanges("now.ts")] },
      stopped: { repos: [repoChanges("before.ts", true)] },
    });

    const client = await connect(stub);

    client.send({ type: "watch_changes", id: "watch" });
    expect(
      changeLists(await client.until((messages) => changeLists(messages).length === 1)),
    ).toEqual([
      { type: "changes", repos: [repoChanges("before.ts", true)], startingContainer: false },
    ]);

    // An agent's write never starts it.
    await runInDurableObject(stub, (instance: TestSession) => instance.wrote());
    await client.until((messages) => changeLists(messages).length === 2);
    expect(await changesCalls(stub)).toEqual([false, false]);

    const before = client.received.length;

    client.send({ type: "refresh_changes", id: "refresh", manual: true });
    await client.answer("refresh");

    // "Starting the Container…" over the last list, then the fresh one.
    expect(
      changeLists(await client.until((messages) => changeLists(messages).length === 2, before)),
    ).toEqual([
      { type: "changes", repos: [repoChanges("before.ts", true)], startingContainer: true },
      { type: "changes", repos: [repoChanges("now.ts")], startingContainer: false },
    ]);
    expect(await changesCalls(stub)).toEqual([false, false, true]);
  });

  it("tells the watchers when a listing fails, and keeps the watch", async () => {
    const stub = fresh();

    await setChanges(stub, { running: { repos: [repoChanges("a.ts")] } });

    const client = await connect(stub);

    client.send({ type: "watch_changes", id: "watch" });
    await client.until((messages) => changeLists(messages).length === 1);
    await setChanges(stub, { running: { repos: [] }, fails: true });

    const before = client.received.length;

    client.send({ type: "refresh_changes", id: "refresh" });
    await client.answer("refresh");

    const failed = {
      type: "error",
      changes: true,
      message: "Listing the Changes failed: The Workspace is unreachable",
    };

    expect(
      await client.until(
        (messages) => Arr.some(messages, (message) => message.type === "error"),
        before,
      ),
    ).toEqual(expect.arrayContaining([failed]));
    expect(changeLists(client.received.slice(before))).toEqual([]);

    await setChanges(stub, { running: { repos: [repoChanges("b.ts")] } });
    client.send({ type: "refresh_changes", id: "again" });
    await client.answer("again");
    await client.until((messages) => changeLists(messages).length === 2);
    expect(changeLists(client.received).at(-1)?.repos).toEqual([repoChanges("b.ts")]);
  });

  it("answers a file's two sides, or why it cannot", async () => {
    const stub = fresh();
    const client = await connect(stub);

    client.send({ type: "change_file", id: "file", repo: "app", path: "a.ts" });
    expect(await client.answer("file")).toEqual({
      type: "result",
      id: "file",
      result: { old: null, new: { kind: "text", text: "app/a.ts\n" } },
    });

    client.send({ type: "change_file", id: "missing", repo: "app", path: "missing" });
    expect(await client.answer("missing")).toEqual({
      type: "error",
      id: "missing",
      message: "No such file in the Workspace's repos",
    });
  });

  it("survives hibernation: the woken Session lists them again on the same socket", async () => {
    const stub = fresh();

    await setChanges(stub, { running: { repos: [repoChanges("a.ts")] } });

    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "watch_changes", id: "watch" });
    await client.until((messages) => changeLists(messages).length === 1);
    await evictDurableObject(stub);

    const before = client.received.length;

    // A message wakes it.
    client.send({ type: "unwatch", id: "wake", conversationId: root });
    await client.answer("wake");

    expect(
      changeLists(await client.until((messages) => changeLists(messages).length === 1, before)),
    ).toEqual([{ type: "changes", repos: [repoChanges("a.ts")], startingContainer: false }]);
  });

  it("watches a conversation's Changes beside the Session's, sharing the listing of their one Workspace and naming the conversation as asked", async () => {
    const stub = fresh();

    await setChanges(stub, { running: { repos: [repoChanges("a.ts")] } });

    const client = await connect(stub);
    const root = await client.root();
    const sent = { type: "changes", repos: [repoChanges("a.ts")], startingContainer: false };

    client.send({ type: "watch_changes", id: "session" });
    client.send({ type: "watch_changes", id: "conversation", conversationId: root });
    await client.answer("session");
    expect(await client.answer("conversation")).toEqual({
      type: "result",
      id: "conversation",
      result: null,
    });

    // The Session's list and the conversation's, in either order, beside any other list of the Session's.
    const listsBoth = (messages: readonly ServerMessage[]) =>
      Arr.some(changeLists(messages), (list) => list.conversationId === root) &&
      Arr.some(changeLists(messages), (list) => list.conversationId === undefined);

    const lists = changeLists(await client.until(listsBoth));

    expect(lists).toEqual(expect.arrayContaining([sent, { ...sent, conversationId: root }]));
    // The root works in the Session's Workspace: its watch shares the Session's listing, which never runs more than
    // once at a time (a second watch's ask is folded into one more after it).
    expect((await changesCalls(stub)).length).toBeLessThanOrEqual(2);
    expect(await recordedWatches(stub)).toEqual([
      { watches: [], changes: true, conversationChanges: [root] },
    ]);

    // A refresh and a file of the conversation's Changes.
    client.send({ type: "refresh_changes", id: "refresh", conversationId: root });
    expect(await client.answer("refresh")).toEqual({ type: "result", id: "refresh", result: null });
    client.send({
      type: "change_file",
      id: "file",
      conversationId: root,
      repo: "app",
      path: "a.ts",
    });
    expect(await client.answer("file")).toEqual({
      type: "result",
      id: "file",
      result: { old: null, new: { kind: "text", text: "app/a.ts\n" } },
    });

    // Both watches outlive hibernation.
    await evictDurableObject(stub);

    const before = client.received.length;

    client.send({ type: "unwatch", id: "wake", conversationId: root });
    await client.answer("wake");
    // A list of the Session's from before the eviction may land first: wait for both, not for any two.
    expect(changeLists(await client.until(listsBoth, before))).toEqual(
      expect.arrayContaining([sent, { ...sent, conversationId: root }]),
    );

    client.send({ type: "unwatch_changes", id: "unwatch", conversationId: root });
    await client.answer("unwatch");
    expect(await recordedWatches(stub)).toEqual([
      { watches: [], changes: true, conversationChanges: [] },
    ]);
  });

  it("refuses the Changes of a conversation that is not the root or a subagent's", async () => {
    const stub = fresh();
    const client = await connect(stub);
    // SAFETY: a number the Session never gave out, to see it refused.
    const stranger = ((await client.root()) + 40) as ConversationId;

    for (const message of [
      { type: "watch_changes", id: "watch", conversationId: stranger },
      { type: "refresh_changes", id: "refresh", conversationId: stranger },
      { type: "change_file", id: "file", conversationId: stranger, repo: "app", path: "a.ts" },
    ] as const) {
      client.send(message);
      expect(await client.answer(message.id)).toEqual({
        type: "error",
        id: message.id,
        message: `Conversation ${stranger} is not the root or a subagent of this Session`,
      });
    }

    // Nothing is watched.
    expect(await recordedWatches(stub)).toEqual([{ watches: [] }]);
  });

  it("ends a conversation's Changes watch that outlived its subagent, telling the client which, and keeps the others", async () => {
    const stub = fresh();

    await setChanges(stub, { running: { repos: [repoChanges("a.ts")] } });

    const client = await connect(stub);
    // SAFETY: a number the Session never gave out: a subagent deleted while the object hibernated.
    const gone = ((await client.root()) + 40) as ConversationId;

    client.send({ type: "watch_changes", id: "session" });
    await client.answer("session");
    // As the attachment of a socket that watched it before the subagent was deleted.
    await runInDurableObject(stub, (_instance: TestSession, state) => {
      for (const socket of state.getWebSockets()) {
        socket.serializeAttachment({ watches: [], changes: true, conversationChanges: [gone] });
      }
    });
    await evictDurableObject(stub);

    const before = client.received.length;

    client.send({ type: "unwatch", id: "wake", conversationId: await client.root() });
    await client.answer("wake");

    const received = await client.until(
      (messages) =>
        Arr.some(messages, (message) => message.type === "error") &&
        changeLists(messages).length >= 1,
      before,
    );

    // Not a Session-wide failure: the Changes watch it names ended.
    expect(Arr.filter(received, (message) => message.type === "error")).toEqual([
      {
        type: "error",
        changes: true,
        ended: true,
        conversationId: gone,
        message: `Changes watch of conversation ${gone} ended: Conversation ${gone} is not the root or a subagent of this Session`,
      },
    ]);
    expect(changeLists(received)).toEqual([
      { type: "changes", repos: [repoChanges("a.ts")], startingContainer: false },
    ]);
    expect(await recordedWatches(stub)).toEqual([
      { watches: [], changes: true, conversationChanges: [] },
    ]);
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
  it("sends the list after the view, and again each time the agent changes it", async () => {
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

    // Empty until the agent first uses the tool, and sent after the conversation's view.
    await client.until((messages) => todoLists(messages, root).length === 1);
    expect(todoLists(client.received, root)).toEqual([[]]);
    const order = Arr.map(client.received, (message) => message.type);

    expect(order.indexOf("todos")).toBeGreaterThan(order.indexOf("view"));

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

  it("does not outlive an unwatch that comes while the view is being made", async () => {
    const stub = fresh();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script([ADD_TASKS, "Done."]),
    );

    const client = await connect(stub);
    const root = await client.root();

    // Both commands are on the socket before the first view is sent.
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

describe("entries", () => {
  it("answers a page of the root's transcript within the bounds, in the order asked for", async () => {
    const stub = fresh();
    const client = await connect(stub);
    const root = await client.root();

    client.send({ type: "submit", id: "submit", input: "hi", requestId: "turn-1" });
    await submitted(client, "submit");
    await idle(stub);
    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.answer("watch");

    const entries = viewsOf(client.received, root)[0]?.entries ?? [];
    const newest = entries.at(-1)?.id;

    if (newest === undefined) throw new Error("The view has no entries");

    client.send({ type: "entries", id: "all", query: { order: "ascending" }, limit: 200 });
    client.send({
      type: "entries",
      id: "two",
      query: { maxEntryId: newest, order: "descending" },
      limit: 2,
    });

    const ids = Arr.map(entries, (entry) => entry.id);

    // The whole transcript fits one page, as the view's window holds it, and nothing is left.
    expect(await client.answer("all")).toEqual({
      type: "result",
      id: "all",
      result: { items: entries },
    });
    // The newest two, newest first, and a continuation, as more are left.
    expect(await client.answer("two")).toEqual({
      type: "result",
      id: "two",
      result: {
        items: Arr.map(Arr.reverse(ids.slice(-2)), (id) => expect.objectContaining({ id })),
        next: expect.any(Object),
      },
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

describe("the approval_requests message", () => {
  const ask = {
    id: "7",
    conversationId: 1,
    tool: "settings_mcp_add",
    target: "Environment Default",
    change: "MCP server files: add",
    before: "None",
    after: "{}",
    reason: "Needed",
    expected: { value: null, after: {} },
  };

  it("carries a request's notes to every client, and leaves out the value the call checks once approved", () => {
    const message = approvalRequests([{ ...ask, notes: ["Runs: node server.js."] }]);

    expect(message).toMatchObject({
      type: "approval_requests",
      requests: [{ id: "7", notes: ["Runs: node server.js."] }],
    });

    expect(JSON.stringify(message)).not.toContain("expected");
  });
});
