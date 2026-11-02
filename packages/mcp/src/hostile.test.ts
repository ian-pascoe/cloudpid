/**
 * A hostile server (`docs/architecture/mcp.md` → Testing and tracing; `docs/architecture/mcp-connections.md` →
 * Failures and cuts, Requests and Legacy sessions): cut streams, oversize bodies, bad headers and odd error bodies,
 * against `list` and `callTool` in both eras.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { AGENT, HOST, recordingClock, run, TARGET, testDeps, failedWith } from "./core.fixture.ts";
import {
  type FakeServer,
  fetchTo,
  hostileServer,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  type RpcBody,
  rpcMethods,
  sse,
} from "./fakes.fixture.ts";
import { Cut, NotFound, ProtocolViolation, ServerError, TooLarge, Unreachable } from "./types.ts";
import { connect } from "./index.ts";

const MiB = 1024 * 1024;

/** `base`, except that its first `times` requests for `method` get `answer`. */
const answering = (
  base: FakeServer,
  method: string,
  answer: (rpc: RpcBody) => Response,
  times = Number.POSITIVE_INFINITY,
) => {
  let answered = 0;

  return hostileServer(base, (_request, rpc) => {
    if (rpc?.method !== method || answered >= times) {
      return undefined;
    }

    answered += 1;

    return answer(rpc);
  });
};

/** How a `tools/list` walk and an `echo` call end: their values, or the errors they failed with. */
const attempt = (server: FakeServer, clock = recordingClock().clock) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

      const listed = yield* connection.list("tools", HOST).pipe(
        Effect.map((tools) => ({ tools: tools.value.map((tool) => tool.name) })),
        Effect.catch((error) => Effect.succeed({ failed: error })),
      );

      const called = yield* connection
        .callTool({ name: "echo", arguments: { text: "hi" } }, AGENT)
        .pipe(
          Effect.map((result) => ({ content: result.value.content })),
          Effect.catch((error) => Effect.succeed({ failed: error })),
        );

      return { listed, called };
    }),
    clock,
  );

const bases: ReadonlyArray<readonly [string, () => FakeServer]> = [
  ["Modern", modernServer],
  ["Legacy stateless", legacyStatelessServer],
  ["Legacy stateful", legacyStatefulServer],
];

const progress = (rpc: RpcBody) => ({
  jsonrpc: "2.0",
  method: "notifications/message",
  params: { level: "info", data: `working on ${String(rpc.id)}` },
});

/** A body of `bytes` bytes, streamed with no `Content-Length`. */
const streamOf = (bytes: number, prefix: string) => {
  let sent = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === 0) {
        controller.enqueue(new TextEncoder().encode(prefix));
      }

      const chunk = Math.min(MiB, bytes - sent);

      if (chunk <= 0) {
        controller.close();

        return;
      }

      controller.enqueue(new Uint8Array(chunk).fill(32));
      sent += chunk;
    },
  });
};

describe.each(bases)("a hostile %s server", (_name, base) => {
  it("cuts a call's stream before its answer: cut at once, and it may have run", async () => {
    const server = answering(base(), "tools/call", (rpc) => sse([progress(rpc)]));

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(Cut, { mayHaveRun: true }));
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(1);
  });

  it("cuts a list page's stream once: the page is asked for again", async () => {
    const server = answering(base(), "tools/list", (rpc) => sse([progress(rpc)]), 1);

    const { listed } = await attempt(server);

    expect(listed).toEqual({ tools: ["echo", "shout"] });
  });

  it("breaks the connection under a call: cut, and it may have run", async () => {
    const server = hostileServer(base(), (_request, rpc) => {
      if (rpc?.method === "tools/call") {
        throw new TypeError("network connection lost");
      }

      return undefined;
    });

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(Cut, { mayHaveRun: true }));
  });

  it("claims a Content-Length over 16 MiB: too large, unread", async () => {
    const server = answering(
      base(),
      "tools/call",
      () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "content-length": String(17 * MiB) },
        }),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(TooLarge, { limit: 16 * MiB }));
  });

  it.each([
    ["JSON", "application/json", '{"jsonrpc":"2.0","id":0,"result":{"content":[],"x":"'],
    ["SSE", "text/event-stream", 'event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{"x":"'],
  ])("streams a %s answer over 16 MiB: too large", async (_kind, contentType, prefix) => {
    const server = answering(
      base(),
      "tools/call",
      () => new Response(streamOf(17 * MiB, prefix), { headers: { "content-type": contentType } }),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(TooLarge, { limit: 16 * MiB }));
  });

  it("answers with the wrong content type: not an MCP server", async () => {
    const server = answering(
      base(),
      "tools/call",
      () => new Response("hello", { headers: { "content-type": "text/plain" } }),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(ProtocolViolation));
  });

  it("answers a call with an HTML 400: a server error with the status", async () => {
    const server = answering(
      base(),
      "tools/call",
      () => new Response("<h1>Bad</h1>", { status: 400, headers: { "content-type": "text/html" } }),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(ServerError, { status: 400 }));
  });

  it("answers a call with a JSON-RPC error: a server error with the code", async () => {
    const server = answering(base(), "tools/call", (rpc) =>
      Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32000, message: "Broken" } }),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(ServerError, { code: -32000, message: "Broken" }));
  });

  it("does not know the tool: not found", async () => {
    const server = answering(base(), "tools/call", (rpc) =>
      Response.json({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32602, message: "Unknown tool" },
      }),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(NotFound, { code: -32602 }));
  });

  it("answers a list page 503 once: retried after 1 s; a call's 503 is not retried", async () => {
    const listOnce = answering(base(), "tools/list", () => new Response(null, { status: 503 }), 1);
    const server = answering(listOnce, "tools/call", () => new Response(null, { status: 503 }));
    const { clock, slept } = recordingClock();

    const { listed, called } = await attempt(server, clock);

    expect(listed).toEqual({ tools: ["echo", "shout"] });
    expect(slept).toEqual([1000]);
    expect(called).toEqual(failedWith(Unreachable, { status: 503 }));
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(1);
  });
});
