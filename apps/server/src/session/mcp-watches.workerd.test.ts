// Resource watches in a Session end to end (`docs/architecture/mcp-in-a-session.md` → Resource watches): a model's read
// with `watch: true` goes Session → host (over a scripted engine, which holds the watch) and the Session lists it, tells
// every client (`mcp_watches`, after `hello` too), and takes the owner's ✕ (`mcp_watch_end`) through the host's
// `end_watches`; a host that ended the watch itself is heard of at the conversation's next request start.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
} from "@cloudpid/mcp/types";
import { type ClientMessage, ServerMessageJson, type ServerMessage } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EngineScript } from "../mcp/host.fixture.ts";
import type { TestMcpHost } from "../mcp/host.fixture.ts";
import { poll } from "../poll.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
    }
  }
}

const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

const DOCS = "https://docs.example/mcp";
const FILE = "file:///a.txt";

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

/** A discovery of `docs`, a Modern server with resources that it can send updates for. */
const FOUND: EngineScript = {
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { resources: { subscribe: true } },
    tools: [],
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: { era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 } },
  } as typeof McpEngineDiscoverResult.Encoded,
};

/** The engine's answer to a read of `FILE`: its contents, hashed. */
const CONTENTS: typeof McpEngineRequestResult.Encoded = {
  kind: "complete",
  result: { kind: "inline", value: { contents: [{ uri: FILE, text: "text" }] } },
  cacheable: false,
  fetchedAt: Date.now(),
  state: {},
  sha256: "aaa",
};

/** A Session in a fresh Environment whose host holds `docs`, and whose model reads `FILE` watching it. */
const watching = async () => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.script({ hash: SET.hash, signInsRevision: 0 });
  await host.scriptEngine(DOCS, [FOUND]);
  await host.scriptListen(DOCS, [{ era: "modern" }]);
  await host.scriptRequest(DOCS, [{ op: "resources/read", result: CONTENTS }]);
  await host.apply(SET);

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
    instance.script([
      `call:read_mcp_resource:${JSON.stringify({ server: "docs", uri: FILE, watch: true })}`,
      "watching",
    ]);
    await instance.submit({ requestId: "turn-1", text: "watch the file" });
  });
  await settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

  return { environment, host, stub };
};

const decode = Schema.decodeUnknownEffect(ServerMessageJson);

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

  const until = async (done: (messages: readonly ServerMessage[]) => boolean) => {
    await poll(
      () => done(received),
      () => `Never received the expected messages: ${JSON.stringify(received)}`,
    );

    return received;
  };

  return {
    received,
    until,
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    /** The newest `mcp_watches` list. */
    watches: () =>
      Arr.findLast(received, (message) => message.type === "mcp_watches").pipe(
        Option.flatMap((found) =>
          found.type === "mcp_watches" ? Option.some(found.watches) : Option.none(),
        ),
        Option.getOrElse(() => []),
      ),
  };
};

describe("a Resource watch in a Session", () => {
  it("is listed once the host has started it, and sent to a client after hello", async () => {
    const { stub, host } = await watching();

    expect(await host.watchRows()).toMatchObject([{ server: "docs", uri: FILE, state: "active" }]);
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.watchList())).toEqual(
      [{ conversationId: expect.any(Number), server: "docs", uri: FILE }],
    );

    const client = await connect(stub);

    await client.until((messages) => messages.some((each) => each.type === "mcp_watches"));
    expect(client.watches()).toEqual([
      { conversationId: expect.any(Number), server: "docs", uri: FILE },
    ]);
  });

  it("is ended by the owner's ✕ at the host, and the list is told to every client", async () => {
    const { stub, host } = await watching();
    const client = await connect(stub);

    await client.until(() => client.watches().length === 1);

    const [entry] = client.watches();

    if (entry === undefined) throw new Error("No watch listed");

    client.send({
      type: "mcp_watch_end",
      id: "end-1",
      conversationId: entry.conversationId,
      server: "docs",
      uri: FILE,
    });
    await client.until((messages) =>
      messages.some((each) => each.type === "result" && each.id === "end-1"),
    );

    expect(client.watches()).toEqual([]);
    expect(await host.watchRows()).toEqual([]);
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.watchList())).toEqual(
      [],
    );
  });

  it("is dropped from the list when the host ended it, and the model is told at its next request", async () => {
    const { stub, host, environment } = await watching();

    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.watchList()),
    ).toHaveLength(1);

    // The server stopped sending updates for it: the host ends the watch itself, saying why.
    await host.apply({
      kind: "end_watches",
      session: `mcp-${environment}`,
      reason: "the server no longer sends updates for it",
    });

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["noted"]);
      await instance.submit({ requestId: "turn-2", text: "anything new?" });
    });
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );

    expect(await runInDurableObject(stub, (instance: TestSession) => instance.watchList())).toEqual(
      [],
    );

    // The conversation was told in a notice, with the URI and why.
    const notices = (
      await runInDurableObject(stub, (instance: TestSession) => instance.rootEntries())
    ).filter((entry) => entry.kind === "cloudpid.mcp-resource-watches");

    expect(notices).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ notice: "Resource watches" }),
        text: expect.stringContaining(`${FILE} (the server no longer sends updates for it)`),
      }),
    ]);
  });

  it("is ended silently at the host when the active branch moves off its conversation", async () => {
    const { stub, host } = await watching();

    expect(await host.watchRows()).toHaveLength(1);

    const tree = await runInDurableObject(stub, (instance: TestSession) => instance.tree());
    const prompt = tree.nodes.find((node) => node.role === "user");

    // "Before" the owner's message is a new branch, off the conversation that holds the watch.
    const went = await runInDurableObject(stub, (instance: TestSession) =>
      instance.navigate({ entryId: prompt?.id ?? 0, position: "before" }),
    );

    expect(went).toHaveProperty("navigated");
    await settles(async () => expect(await host.watchRows()).toEqual([]));
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.watchList())).toEqual(
      [],
    );
  });
});
