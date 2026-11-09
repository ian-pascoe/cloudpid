// The owner's completion of an argument end to end (`docs/architecture/mcp-in-a-session.md` → Arguments and completions): a
// client's `mcp_complete` goes Session → host → the real `McpEngine` → a fake server, and is answered with the suggestions; a
// newer request for a field, or a cancel, cancels the older one at the server; a server that does not declare the capability is
// never asked, nor a stdio server's stopped Container started; and the Session says in `hello` that it takes the message, so a
// client sends it to none that does not.
// workerd's Durable Object, WebSocket and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off preferEffectArray:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { modernServer, rpcMethods } from "@cloudpid/mcp/testing";
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { type ClientMessage, ServerMessageJson, type ServerMessage } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineScript, RequestScript, TestMcpHost } from "../mcp/host.fixture.ts";
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

const setOf = (): McpApplySet => ({
  kind: "set",
  hash: "h-docs",
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
});

/** A Session over `server`, after one turn has built its tools from the inventory. */
const settled = async (stub: DurableObjectStub<TestSession>, environment: string) => {
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
};

/** What the fake's completions answer, and the arguments of the completions it was asked to cancel. */
const completing = (hangs = false) => {
  const cancelled: Array<string> = [];

  const complete = (params: {
    readonly argument: { readonly value: string };
    readonly context?:
      | { readonly arguments?: Readonly<Record<string, string>> | undefined }
      | undefined;
  }) => ({
    values: [`${params.argument.value}-1`, `${params.context?.arguments?.["owner"] ?? "-"}`],
    total: 5,
  });

  const server = modernServer({
    cancelled,
    prompts: [{ name: "review", arguments: [{ name: "repo" }], get: () => ({ messages: [] }) }],
    completions: hangs ? { hangs: true, complete } : { complete },
  });

  return { server, cancelled };
};

const withServer = async (server: ReturnType<typeof modernServer>) => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    server.handle(new Request(input, init)),
  );

  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.useRealEngine();
  await host.apply(setOf());

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await settled(stub, environment);

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
    capabilities: { prompts: {}, completions: {} },
    tools: [],
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: { era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 } },
  } as typeof McpEngineDiscoverResult.Encoded,
};

/** The engine's answer to a completion when the stdio server's Container is stopped: the bridge's `stopped` refusal. */
const containerStopped: RequestScript = {
  op: "completion/complete",
  // SAFETY: a failure as it crosses the edge; the host decodes it.
  result: {
    kind: "failed",
    error: { _tag: "Unreachable", message: "The Workspace's Container is stopped", stopped: true },
    state: {},
  } as typeof McpEngineRequestResult.Encoded,
};

const withStoppedContainer = async () => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.apply({ kind: "set", hash: "h-stdio", revision: 1, entries: [stdioEntry] });
  await host.scriptEngine(STDIO_KEY, [discovered]);
  await host.scriptRequest(STDIO_KEY, [containerStopped]);

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await settled(stub, environment);

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
    await poll(
      () => done(received),
      () => `Never received the expected messages: ${JSON.stringify(received)}`,
    );

    return received;
  };

  const send = (message: ClientMessage) => socket.send(JSON.stringify(message));

  const answerOf = async (id: string) => {
    const answered = (message: ServerMessage) => message.type === "result" && message.id === id;
    const messages = await until(Arr.some(answered));
    const found = Arr.findFirst(messages, answered).pipe(Option.getOrUndefined);

    return found?.type === "result" ? found.result : undefined;
  };

  /** A completion of `repo`'s value in the form's field `field`: its command id, and what answers it. */
  const complete = (
    value: string,
    more: { readonly server?: string; readonly field?: string; readonly requestId?: string } = {},
  ) => {
    const id = `complete-${counter++}`;

    send({
      type: "mcp_complete",
      id,
      requestId: more.requestId ?? id,
      field: more.field ?? "repo",
      server: more.server ?? "docs",
      ref: { type: "ref/prompt", name: "review" },
      argument: { name: "repo", value },
      context: { arguments: { owner: "ian" } },
    });

    return { id, answer: () => answerOf(id) };
  };

  return { received, until, send, complete, answerOf };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a completion over the Session's socket", () => {
  it("asks the server through the host and answers its suggestions with the other fields as context, writing nothing into the conversation", async () => {
    const { stub, server } = await withServer(completing().server);
    const client = await connect(stub);
    const before = await runInDurableObject(stub, (instance: TestSession) => instance.tree());

    expect(await client.complete("cl").answer()).toEqual({
      status: "ok",
      values: ["cl-1", "ian"],
      total: 5,
      hasMore: true,
    });
    expect(rpcMethods(server).filter((method) => method === "completion/complete")).toHaveLength(1);
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.tree())).toEqual(
      before,
    );
  });

  it("cancels the older request of a field when a newer one comes, at the server too", async () => {
    const { server, cancelled } = completing(true);
    const { stub } = await withServer(server);
    const client = await connect(stub);

    const older = client.complete("c", { field: "repo", requestId: "older" });

    await settles(async () =>
      expect(rpcMethods(server).filter((method) => method === "completion/complete")).toHaveLength(
        1,
      ),
    );

    client.complete("cl", { field: "repo", requestId: "newer" });

    expect(await older.answer()).toMatchObject({ status: "failed", values: [] });
    await settles(async () => expect(cancelled).toEqual(["repo"]));
  });

  it("cancels a request that mcp_complete_cancel names", async () => {
    const { server, cancelled } = completing(true);
    const { stub } = await withServer(server);
    const client = await connect(stub);
    const asked = client.complete("c", { requestId: "r1" });

    await settles(async () =>
      expect(rpcMethods(server).filter((method) => method === "completion/complete")).toHaveLength(
        1,
      ),
    );
    client.send({ type: "mcp_complete_cancel", id: `cancel-${counter++}`, requestId: "r1" });

    expect(await asked.answer()).toMatchObject({ status: "failed" });
    await settles(async () => expect(cancelled).toEqual(["repo"]));
  });

  it("never asks a server that does not declare completions, and has no such server answered", async () => {
    const quiet = modernServer({
      prompts: [{ name: "review", get: () => ({ messages: [] }) }],
    });

    const { stub, server } = await withServer(quiet);
    const client = await connect(stub);

    expect(await client.complete("cl").answer()).toMatchObject({
      status: "unsupported",
      values: [],
    });
    expect(await client.complete("cl", { server: "elsewhere" }).answer()).toMatchObject({
      status: "unsupported",
    });
    expect(rpcMethods(server)).not.toContain("completion/complete");
  });

  it("never wakes a stdio server's stopped Container: it says it is not running", async () => {
    const { stub, host } = await withStoppedContainer();
    const client = await connect(stub);

    expect(await client.complete("cl", { server: "local" }).answer()).toMatchObject({
      status: "not_running",
      values: [],
    });

    const asked = (await host.engineRequests()).filter(
      (each) => each.request.op === "completion/complete",
    );

    expect(asked.map((each) => (each.target.kind === "stdio" ? each.target.start : null))).toEqual([
      false,
    ]);
  });
});
