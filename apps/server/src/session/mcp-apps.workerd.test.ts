// MCP App records in a Session end to end (`docs/architecture/mcp-apps.md` → App records, Socket messages): a model's call
// of an App tool goes Session → host → the real `McpEngine` → a fake App server, and the Session keeps its record, in
// its own storage and outside History, which a mount reads live, after the object restarts, and in a Fork. An App-only
// tool is never offered to the model; the sockets tell a client the inventory's App tools after `hello`, the App calls of a
// conversation when it is watched, and answer a mount and a page by hash.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { APP_MIME_TYPE, appTool, modernServer } from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import {
  type ClientMessage,
  type McpAppEntry,
  ServerMessageJson,
  type ServerMessage,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestMcpHost } from "../mcp/host.fixture.ts";
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

const URI = "ui://docs/app";
const PAGE = "<main>fixture</main>";

/** The set of an Environment with one HTTP server, `docs`, whose tools are all `direct`. */
const SET: McpApplySet = {
  kind: "set",
  hash: "h1",
  revision: 1,
  entries: [
    {
      name: "docs",
      source: { kind: "global" },
      server: { type: "http", url: "https://docs.example/mcp", headers: {}, exposure: "direct" },
      hash: "hash-docs",
      conn: "conn-docs",
      identity: "identity-docs",
    },
  ],
};

/** A server with the App tool `app`, the App-only tool `hidden` and `plain`, and the `ui://` page of both. */
const appServer = () =>
  modernServer({
    resources: [
      {
        uri: URI,
        name: "app",
        mimeType: APP_MIME_TYPE,
        contents: [{ uri: URI, mimeType: APP_MIME_TYPE, text: PAGE }],
      },
    ],
    moreTools: [
      appTool("app", URI),
      {
        ...appTool("hidden", URI),
        _meta: { ui: { resourceUri: URI, visibility: ["app"] } },
      },
    ],
  });

/** A Session over the real engine, whose outbound `fetch`es reach `server`, with its Environment's set applied. */
const overServer = async (server = appServer()) => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(new Request(input, init)),
  );

  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.useRealEngine();
  await host.apply(SET);

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await runInDurableObject(stub, (instance: TestSession) => {
    instance.mcpEnvironment(environment, 1);
  });

  return { stub, server, host };
};

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

/** The model calls `tool` with `args`, and the call is done. */
const callTool = async (
  stub: DurableObjectStub<TestSession>,
  tool: string,
  args: Record<string, string> = { text: "hi" },
) => {
  await runInDurableObject(stub, async (instance: TestSession) => {
    instance.script([`call:mcp__docs__${tool}:${JSON.stringify(args)}`, "done"]);
    await instance.submit({ requestId: `turn-${counter++}`, text: `call ${tool}` });
  });
  await idle(stub);
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

  return {
    received,
    send,
    until,
    /** The `result` of command `id`. */
    answer: async (id: string) => {
      const answered = (message: ServerMessage) => message.type === "result" && message.id === id;

      const messages = await until(Arr.some(answered));

      return Arr.findFirst(messages, answered).pipe(Option.getOrUndefined);
    },
    root: async () => {
      const [hello] = await until((messages) => messages[0]?.type === "hello");

      if (hello?.type !== "hello") throw new Error("No hello");

      return hello.root;
    },
  };
};

/** The newest App call of the root conversation. */
const lastCall = async (stub: DurableObjectStub<TestSession>): Promise<McpAppEntry> => {
  const entry = (await runInDurableObject(stub, (instance: TestSession) => instance.appCalls())).at(
    -1,
  );

  if (entry === undefined) throw new Error("No App call was recorded");

  return entry;
};

/**
 * Two calls of `app`: the host reads an App's page beside the first call and does not wait for the read, so it is the
 * second call's answer that holds the page's hash (`McpHost` → `request.ts`). Returns the second's entry.
 */
const calledTwice = async (
  stub: DurableObjectStub<TestSession>,
  host: DurableObjectStub<TestMcpHost>,
) => {
  await callTool(stub, "app");
  await settles(async () => expect(await host.appPages()).toHaveLength(1));
  await callTool(stub, "app");

  return lastCall(stub);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an MCP App call in a Session", () => {
  it("is kept as a record, which a mount reads live and after the object restarts", async () => {
    const { stub, host } = await overServer();
    const entry = await calledTwice(stub, host);

    expect(entry).toMatchObject({ server: "docs", tool: "app", state: "kept" });
    // The host had the App's page: the record pins it by hash.
    expect(entry.htmlHash).toEqual(expect.any(String));

    const mounted = await runInDurableObject(stub, (instance: TestSession) =>
      instance.appMount(entry.callId),
    );

    expect(mounted).toMatchObject({
      status: "record",
      record: {
        callId: entry.callId,
        server: "docs",
        tool: "app",
        arguments: { text: "hi" },
        htmlHash: entry.htmlHash,
        result: { content: [{ type: "text", text: "hi" }] },
      },
    });

    // The Session's own storage keeps it: it is the same after the object is evicted and woken.
    await evictDurableObject(stub);

    const replayed = await runInDurableObject(stub, (instance: TestSession) =>
      instance.appMount(entry.callId),
    );

    expect(replayed).toEqual(mounted);
  });

  it("is not recorded for a tool that has no App", async () => {
    const { stub } = await overServer();

    await callTool(stub, "echo");

    expect(await runInDurableObject(stub, (instance: TestSession) => instance.appCalls())).toEqual(
      [],
    );
  });

  it("never offers an App-only tool to the model, nor lists it in the inventory the model reads", async () => {
    const { stub } = await overServer();

    await callTool(stub, "app");

    const offered = await runInDurableObject(stub, (instance: TestSession) =>
      instance.offeredTools(),
    );

    expect(offered[0]).toEqual(expect.arrayContaining(["mcp__docs__app", "mcp__docs__echo"]));
    expect(offered[0]).not.toContain("mcp__docs__hidden");
  });

  it("is carried by a Fork, whose own mount reads the record as the source's", async () => {
    const { stub, host } = await overServer();
    const entry = await calledTwice(stub, host);
    const target = `fork-${counter++}`;

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.forkInto(target, { quiet: "none" }),
    );

    const copy = env.SESSIONS.getByName(target);
    const copied = await lastCall(copy);

    expect(copied).toMatchObject({ callId: entry.callId, tool: "app", state: "kept" });
    expect(
      await runInDurableObject(copy, (instance: TestSession) => instance.appMount(entry.callId)),
    ).toMatchObject({ status: "record", record: { arguments: { text: "hi" } } });
  });

  it("is left out of a Fork made before it, which carries the records of the earlier calls only", async () => {
    const { stub, host } = await overServer();

    await callTool(stub, "app");
    await settles(async () => expect(await host.appPages()).toHaveLength(1));
    await callTool(stub, "app");

    const calls = await runInDurableObject(stub, (instance: TestSession) => instance.appCalls());

    expect(calls).toHaveLength(2);

    // The second owner's message is where the Fork is made: before it, only the first call's result is copied.
    const tree = await runInDurableObject(stub, (instance: TestSession) => instance.tree());
    const second = tree.nodes.filter((node) => node.role === "user")[1];

    if (second === undefined) throw new Error("No second owner message");

    const target = `fork-${counter++}`;

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.forkInto(target, {
        point: { entryId: second.id, position: "before" },
        quiet: "none",
      }),
    );

    const copied = await runInDurableObject(
      env.SESSIONS.getByName(target),
      (instance: TestSession) => instance.appCalls(),
    );

    expect(copied.map((call) => call.callId)).toEqual([calls[0]?.callId]);
  });

  it("is bounded: a record over 1 MiB is cut, and one past the Session's 32 MiB leaves a stub", async () => {
    const { stub } = await overServer();

    const draft = (callId: string, size: number) => ({
      callId,
      server: "docs",
      tool: "app",
      conversation: "1",
      arguments: {},
      result: {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { a: "x".repeat(size) },
      },
    });

    // `huge` is cut to nothing but its text, so 33 records of about 1 MB fit under 32 MiB, and the 34th does not.
    await runInDurableObject(stub, async (instance: TestSession) => {
      await instance.appPut(draft("huge", 2 * 1024 * 1024));
      await instance.appPut(draft("first", 1_000_000));
    });

    for (let at = 0; at < 32; at++) {
      await runInDurableObject(stub, (instance: TestSession) =>
        instance.appPut(draft(`call-${at}`, 1_000_000)),
      );
    }

    // `huge` is mounted again, which makes `first` the least recently mounted; one more record tips the Session over.
    await runInDurableObject(stub, async (instance: TestSession) => {
      expect(await instance.appMount("huge")).toMatchObject({ status: "record" });
      await instance.appPut(draft("last", 1_000_000));
    });

    const calls = await runInDurableObject(stub, (instance: TestSession) => instance.appCalls());

    expect(calls.find((call) => call.callId === "huge")).toMatchObject({
      state: "kept",
      truncated: true,
    });
    // The least recently mounted went first, and is a stub that no longer has the call's data.
    expect(Arr.filter(calls, (call) => call.state === "evicted")).toEqual([
      expect.objectContaining({ callId: "first" }),
    ]);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.appMount("first")),
    ).toEqual({
      status: "stub",
      stub: {
        callId: "first",
        server: "docs",
        tool: "app",
        conversation: "1",
        at: expect.any(Number),
      },
    });
  }, 60_000);
});

describe("an MCP App call over the Session's socket", () => {
  it("tells the inventory's App tools after hello, the conversation's App calls on a watch, and answers a mount and a page", async () => {
    const { stub, host } = await overServer();
    const entry = await calledTwice(stub, host);
    const client = await connect(stub);
    const root = await client.root();

    // The App tools: `hidden` is an App tool the model is never offered, which the App View may call.
    const toolsMessage = await client.until((messages) =>
      Arr.some(messages, (message) => message.type === "mcp_app_tools"),
    );

    expect(Arr.findFirst(toolsMessage, (message) => message.type === "mcp_app_tools")).toEqual(
      Option.some({
        type: "mcp_app_tools",
        tools: [
          {
            name: "mcp__docs__app",
            server: "docs",
            tool: "app",
            uri: URI,
            visibility: ["model", "app"],
          },
          {
            name: "mcp__docs__hidden",
            server: "docs",
            tool: "hidden",
            uri: URI,
            visibility: ["app"],
          },
        ],
      }),
    );

    client.send({ type: "watch", id: "watch", conversationId: root });

    const watched = await client.until((messages) =>
      Arr.some(messages, (message) => message.type === "mcp_apps"),
    );

    expect(Arr.findFirst(watched, (message) => message.type === "mcp_apps")).toEqual(
      Option.some({ type: "mcp_apps", conversationId: root, apps: [expect.anything(), entry] }),
    );

    // A mount is answered with the record.
    client.send({ type: "mcp_app_mount", id: "mount", callId: entry.callId });
    expect(await client.answer("mount")).toMatchObject({
      type: "result",
      result: { status: "record", record: { callId: entry.callId, htmlHash: entry.htmlHash } },
    });

    client.send({ type: "mcp_app_mount", id: "mount-none", callId: "nope" });
    expect(await client.answer("mount-none")).toMatchObject({
      result: { status: "none" },
    });

    // The page under the record's hash is the host's; a hash no record pins is not served.
    client.send({ type: "mcp_app_html", id: "html", hash: entry.htmlHash ?? "" });
    expect(await client.answer("html")).toMatchObject({
      result: { status: "html", hash: entry.htmlHash, html: PAGE },
    });

    client.send({ type: "mcp_app_html", id: "html-none", hash: "sha256-not-pinned" });
    expect(await client.answer("html-none")).toMatchObject({ result: { status: "missing" } });

    // By the call, the page is the record's own server's, with the origin its View is served on.
    client.send({ type: "mcp_app_html", id: "html-call", callId: entry.callId });

    const byCall = await client.answer("html-call");

    expect(byCall).toMatchObject({
      result: { status: "html", hash: entry.htmlHash, html: PAGE, view: expect.any(String) },
    });
    expect(JSON.stringify(byCall)).toMatch(
      /"origin":"https:\/\/[a-z2-7]{26}(--[a-z0-9-]+)?\.ianpascoe\.app"|"origin":"http:\/\/127.0.0.1:1338"/,
    );

    client.send({ type: "mcp_app_html", id: "html-call-none", callId: "nope" });
    expect(await client.answer("html-call-none")).toMatchObject({ result: { status: "missing" } });

    client.send({ type: "mcp_app_html", id: "html-neither" });
    expect(await client.answer("html-neither")).toMatchObject({ result: { status: "missing" } });
  });

  it("sends a client with no App tools an empty list, and a watch no App calls", async () => {
    const stub = env.SESSIONS.getByName(`no-apps-${counter++}`);
    const client = await connect(stub);
    const root = await client.root();

    await client.until((messages) =>
      Arr.some(messages, (message) => message.type === "mcp_app_tools"),
    );
    expect(Arr.findFirst(client.received, (message) => message.type === "mcp_app_tools")).toEqual(
      Option.some({ type: "mcp_app_tools", tools: [] }),
    );

    client.send({ type: "watch", id: "watch", conversationId: root });
    await client.until((messages) => Arr.some(messages, (message) => message.type === "mcp_apps"));
    expect(Arr.findFirst(client.received, (message) => message.type === "mcp_apps")).toEqual(
      Option.some({ type: "mcp_apps", conversationId: root, apps: [] }),
    );

    // Without MCP servers, no page is served.
    client.send({ type: "mcp_app_html", id: "html", hash: "any" });
    expect(await client.answer("html")).toMatchObject({ result: { status: "missing" } });
  });
});
