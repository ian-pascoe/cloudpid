// The owner's preview of a resource link end to end (`docs/architecture/mcp-in-a-session.md` → Resource links and embedded
// resources): a client's `mcp_resource_read` goes Session → host → the real `McpEngine` → a fake server, and is answered with
// the contents; a page that is not visible, a server that is hidden and a socket that asks too often are refused before
// the host is asked; and the Session says in `hello` that it takes the message, so a client sends it to none that does not.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { runInDurableObject } from "cloudflare:test";
import { decodeSlotHeld, PREVIEW_SLOT_OVER } from "@cloudpid/extensions/mcp";
import { env } from "cloudflare:workers";
import { modernServer, rpcMethods } from "@cloudpid/mcp/testing";
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  MAX_MCP_RESOURCE_PER_MINUTE,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineScript, RequestScript, TestMcpHost } from "../mcp/host.fixture.ts";
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

const NOTES = "file:///notes.md";

const setOf = (exposure: string): McpApplySet => ({
  kind: "set",
  hash: `h-${exposure}`,
  revision: 1,
  entries: [
    {
      name: "docs",
      source: { kind: "global" },
      server: { type: "http", url: "https://docs.example/mcp", headers: {}, exposure },
      hash: "hash-docs",
      conn: "conn-docs",
      identity: "identity-docs",
    },
  ],
});

/** A Session over a server whose one resource is `notes.md`, after one turn has built its tools from the inventory. */
const withPreview = async (exposure = "direct", notes = "# Notes\n\nhello") => {
  const server = modernServer({
    resources: [
      {
        uri: NOTES,
        name: "notes",
        mimeType: "text/markdown",
        contents: [{ uri: NOTES, mimeType: "text/markdown", text: notes }],
      },
    ],
  });

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(new Request(input, init)),
  );

  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.useRealEngine();
  await host.apply(setOf(exposure));

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await runInDurableObject(stub, (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
  });

  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.script(["done"]);
    await instance.submit({ requestId: `turn-${counter++}`, text: "hi" });
  });
  await settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

  return { stub, host, server };
};

const STDIO_KEY = "stdio:local";

const stdioEntry: McpSetEntry = {
  name: "local",
  source: { kind: "global" },
  server: { type: "stdio", command: "docs-server", args: [], env: {} },
  hash: "hash-local",
  conn: "conn-local",
  identity: "identity-local",
};

const discovered: EngineScript = {
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { resources: {} },
    tools: [],
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: { era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 } },
  } as typeof McpEngineDiscoverResult.Encoded,
};

/** The engine's answer to a read when the stdio server's Container is stopped: the bridge's `stopped` refusal, as it crosses the edge. */
const containerStopped: RequestScript = {
  op: "resources/read",
  // SAFETY: a failure as it crosses the edge; the host decodes it.
  result: {
    kind: "failed",
    error: { _tag: "Unreachable", message: "The Workspace's Container is stopped", stopped: true },
    state: {},
  } as typeof McpEngineRequestResult.Encoded,
};

/**
 * A Session over a stdio server `local` whose Container is stopped, in the Workspace `ws:test`: the host's engine is a
 * script, so what is asserted is what the Session and the host ask of the engine, which a Container that is stopped would
 * be started by if they asked it to (the engine's and the bridge's own refusals are `apps/mcp-worker`'s and
 * `workspace/mcp-bridge.workerd.test.ts`'s).
 */
const withStoppedContainer = async () => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.apply({ kind: "set", hash: "h-stdio", revision: 1, entries: [stdioEntry] });
  await host.scriptEngine(STDIO_KEY, [discovered]);
  await host.scriptRequest(STDIO_KEY, [containerStopped]);

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await runInDurableObject(stub, (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
  });
  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.script(["done"]);
    await instance.submit({ requestId: `turn-${counter++}`, text: "hi" });
  });
  await settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

  return { stub, host };
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
    for (let attempt = 0; attempt < 500; attempt++) {
      if (done(received)) return received;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Never received the expected messages: ${JSON.stringify(received)}`);
  };

  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));

  const answer = async (id: string) => {
    const answered = (message: ServerMessage) => message.type === "result" && message.id === id;
    const messages = await until(Arr.some(answered));

    return Arr.findFirst(messages, answered).pipe(Option.getOrUndefined);
  };

  /** The page says it is visible, as a tab does when it connects. */
  const visible = async (value = true) => {
    const id = `visible-${counter++}`;

    send({ type: "page_visible", id, visible: value });
    await answer(id);
  };

  /** A preview's read, and its answer. */
  const read = async (uri: string, server = "docs", path?: string) => {
    const id = `read-${counter++}`;

    send(
      path === undefined
        ? { type: "mcp_resource_read", id, server, uri }
        : { type: "mcp_resource_read", id, server, uri, path },
    );

    const answered = await answer(id);

    return answered?.type === "result" ? answered.result : undefined;
  };

  return { received, until, visible, read };
};

/** What a test puts back when it ends. */
const afterTest: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();

  for (const restore of afterTest.splice(0)) restore();
});

describe("a resource preview over the Session's socket", () => {
  it("says in hello that it takes mcp_resource_read, so a client sends it only to a Session that does", async () => {
    const { stub } = await withPreview();
    const client = await connect(stub);

    await client.until((messages) => messages[0]?.type === "hello");

    expect(client.received[0]).toMatchObject({ type: "hello", resourcePreviews: true });
  });

  it("reads the resource through the host and answers its contents, writing nothing into the conversation", async () => {
    const { stub } = await withPreview();
    const client = await connect(stub);
    const before = await runInDurableObject(stub, (instance: TestSession) => instance.tree());

    await client.visible();

    expect(await client.read(NOTES)).toEqual({
      status: "contents",
      contents: [{ uri: NOTES, mimeType: "text/markdown", text: "# Notes\n\nhello" }],
    });
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.tree())).toEqual(
      before,
    );
  });

  it("refuses a page that has not said it is visible, and a server that is not there, without a read", async () => {
    const { stub, server } = await withPreview();
    const client = await connect(stub);

    const reads = () => rpcMethods(server).filter((method) => method === "resources/read").length;

    expect(await client.read(NOTES)).toMatchObject({ status: "unavailable", reason: "hidden" });

    await client.visible();
    expect(await client.read(NOTES, "elsewhere")).toMatchObject({
      status: "unavailable",
      reason: "unavailable",
    });
    expect(reads()).toBe(0);
  });

  it("refuses a hidden server's resource", async () => {
    const { stub, server } = await withPreview("hidden");
    const client = await connect(stub);

    await client.visible();

    expect(await client.read(NOTES)).toMatchObject({ status: "unavailable", reason: "hidden" });
    expect(rpcMethods(server).filter((method) => method === "resources/read")).toEqual([]);
  });

  it("never wakes a stdio server's stopped Container: the read says it may not start it, and the chip says why", async () => {
    const { stub, host } = await withStoppedContainer();
    const client = await connect(stub);

    await client.visible();

    const answer = await client.read("file:///a.md", "local");

    expect(answer).toMatchObject({ status: "unavailable", reason: "stopped" });
    expect(answer).toMatchObject({ message: expect.stringContaining("never starts it") });

    // The one read that reached the engine said the target may not start the Container (`start: false`), so the bridge
    // answers a stopped one `stopped` and wakes nothing.
    const reads = (await host.engineRequests()).filter(
      (each) => each.request.op === "resources/read",
    );

    expect(reads.map((each) => (each.target.kind === "stdio" ? each.target.start : null))).toEqual([
      false,
    ]);
  });

  it("reads a Result Spill by its URI when the Workspace has no file at its path, as a link is", async () => {
    const { stub, server } = await withPreview();
    const client = await connect(stub);

    await client.visible();

    expect(await client.read(NOTES, "docs", "/workspace/.cloudpid/tmp/tmp-a1/mcp-b2.md")).toEqual({
      status: "contents",
      contents: [{ uri: NOTES, mimeType: "text/markdown", text: "# Notes\n\nhello" }],
    });
    expect(rpcMethods(server).filter((method) => method === "resources/read")).toHaveLength(1);
  });

  it("holds the isolate's decode slot of a large read until its answer is sent, and lets it go after", async () => {
    // The host returns a result over 1 MiB as a stream, which a preview reads under the slot.
    const text = "x".repeat(PREVIEW_SLOT_OVER + 4096);
    const { stub } = await withPreview("direct", text);
    const client = await connect(stub);

    await client.visible();

    // What the slot's state is as each answer goes out on the socket.
    const held: Array<boolean> = [];

    // oxlint-disable-next-line typescript/unbound-method -- called back with the socket as `this`.
    const send = WebSocket.prototype.send;

    afterTest.push(() => {
      WebSocket.prototype.send = send;
    });

    // The Session's sockets and this test run in the one isolate, so the patch reaches the Session's sends.
    WebSocket.prototype.send = function (data) {
      if (Predicate.isString(data) && data.startsWith('{"type":"result","id":"read-')) {
        held.push(decodeSlotHeld());
      }

      return send.call(this, data);
    };

    expect(await client.read(NOTES)).toMatchObject({ status: "contents" });
    expect(held).toEqual([true]);

    // The send was the last of it: the slot is free once the answer is out.
    await settles(async () => expect(decodeSlotHeld()).toBe(false));
  });

  it("limits the reads of a socket in a minute", async () => {
    const { stub } = await withPreview();
    const client = await connect(stub);

    await client.visible();

    for (let index = 0; index < MAX_MCP_RESOURCE_PER_MINUTE; index++) {
      expect(await client.read(NOTES)).toMatchObject({ status: "contents" });
    }

    expect(await client.read(NOTES)).toMatchObject({ status: "unavailable", reason: "limit" });
  });
});
