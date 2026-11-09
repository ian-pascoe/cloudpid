/**
 * A hostile server (`docs/architecture/mcp.md` → Testing and tracing; `docs/architecture/mcp-connections.md` →
 * Failures and cuts, Requests and Legacy sessions): cut streams, oversize bodies, bad headers and odd error bodies,
 * against `list` and `callTool` in both eras.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  AGENT,
  HOST,
  completed,
  recordingClock,
  run,
  TARGET,
  testDeps,
  failedWith,
} from "./core.fixture.ts";
import {
  ECHO_TOOL,
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
import { tapFetch, Verdicts } from "./tap.ts";

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
        .callTool({ tool: ECHO_TOOL, arguments: { text: "hi" } }, AGENT)
        .pipe(
          Effect.map((result) => ({ content: completed(result).value.content })),
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

  it("limits an App's read of its ui:// resource to 12 MiB, and every other read, an agent's of a ui:// one too, to 16", async () => {
    const readOf = (uri: string, bytes: number, app = false) =>
      run(
        Effect.gen(function* () {
          const server = answering(base(), "resources/read", (rpc) =>
            Response.json({
              jsonrpc: "2.0",
              id: rpc.id ?? null,
              result: {
                resultType: "complete",
                ttlMs: 0,
                cacheScope: "private",
                contents: [{ uri, mimeType: "text/plain", text: "x".repeat(bytes) }],
              },
            }),
          );

          const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

          return yield* connection.readResource(uri, AGENT, { app }).pipe(
            Effect.map(() => ({ read: true })),
            Effect.catch((error) => Effect.succeed({ failed: error })),
          );
        }),
      );

    expect(await readOf("ui://docs/app", 11 * MiB, true)).toEqual({ read: true });
    expect(await readOf("ui://docs/app", 13 * MiB, true)).toEqual(
      failedWith(TooLarge, { limit: 12 * MiB }),
    );
    // Who reads decides, not the URI: the agent's read of a ui:// resource has the 16 MiB every read has.
    expect(await readOf("ui://docs/app", 13 * MiB)).toEqual({ read: true });
    expect(await readOf("ui://docs/app", 17 * MiB)).toEqual(
      failedWith(TooLarge, { limit: 16 * MiB }),
    );
    expect(await readOf("file:///big.txt", 13 * MiB)).toEqual({ read: true });
    // An agent's read counts its bytes as they arrive, and stops at 16 MiB.
    expect(await readOf("file:///big.txt", 17 * MiB)).toEqual(
      failedWith(TooLarge, { limit: 16 * MiB }),
    );
  });

  it("still tracks a read whose params are not an object: a read-only request, retried", async () => {
    let sent = 0;
    let retried = 0;

    const wire = tapFetch(
      async () => {
        sent += 1;

        return new Response("{}", { status: sent === 1 ? 503 : 200 });
      },
      { now: () => 0, sleep: async () => undefined },
      new Verdicts(),
      { response: () => undefined, retried: () => (retried += 1) },
    );

    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: "x" });

    await wire("https://example.test/mcp", { method: "POST", body });

    expect({ sent, retried }).toEqual({ sent: 2, retried: 1 });
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

describe("a Legacy server's GET stream", () => {
  it("is closed at an event over 1 MiB, and the calls go on", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();

    const server = hostileServer(legacyStatefulServer(), (request) => {
      if (request.method !== "GET") {
        return undefined;
      }

      // One event that never ends, 64 KiB at a time, until the client lets go.
      let sent = 0;

      const body = new ReadableStream<Uint8Array>({
        pull: (controller) => {
          controller.enqueue(encoder.encode(sent === 0 ? "data: " : "x".repeat(64 * 1024)));
          sent += 1;
        },
        cancel: () => {
          cancelled = true;
        },
      });

      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });

    expect(await attempt(server)).toEqual({
      listed: { tools: ["echo", "shout"] },
      called: { content: [{ type: "text", text: "hi" }] },
    });
    await expect.poll(() => cancelled).toBe(true);
  });
});

const KiB = 1024;

type Json =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Json>
  | { readonly [key: string]: Json };

/** One SSE `message` event carrying `data` (a JSON-RPC message, or a batch of them), with an event id and a `retry` when given. */
const event = (data: Json, options: { id?: string; retry?: number } = {}) =>
  `${options.id === undefined ? "" : `id: ${options.id}\n`}${options.retry === undefined ? "" : `retry: ${options.retry}\n`}event: message\ndata: ${JSON.stringify(data)}\n\n`;

/** A priming event: an event id and a `retry`, no data (what a server that polls sends first). */
const priming = (id: string, retry?: number) =>
  `id: ${id}\n${retry === undefined ? "" : `retry: ${retry}\n`}data:\n\n`;

const stream = (...parts: ReadonlyArray<string>) =>
  new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } });

/** An SSE response of `parts`, each its own chunk, or split into chunks of `size` bytes. */
const chunked = (parts: ReadonlyArray<string>, size?: number) => {
  const encoded = new TextEncoder();
  const bytes = encoded.encode(parts.join(""));

  const sizes = size === undefined ? parts.map((part) => encoded.encode(part).byteLength) : [];

  let at = 0;
  let index = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const length = size ?? sizes[index];

        if (length === undefined || at >= bytes.byteLength) {
          controller.close();

          return;
        }

        controller.enqueue(bytes.slice(at, at + length));
        at += length;
        index += 1;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

/** An SSE response of `bytes`, cut into chunks of `size` bytes, which may split a multi-byte character. */
const byteChunks = (bytes: Uint8Array, size: number) => {
  let at = 0;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.byteLength) {
          controller.close();

          return;
        }

        controller.enqueue(bytes.slice(at, at + size));
        at += size;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

/** The start of an event that is exactly `bytes` bytes long (without its blank line), none of it a line ending. */
const eventOfSize = (bytes: number, filler = "x") =>
  `data: ${filler.repeat((bytes - 6) / new TextEncoder().encode(filler).byteLength)}`;

const answerOf = (rpc: RpcBody, text: string) => ({
  jsonrpc: "2.0",
  id: rpc.id ?? null,
  result: { content: [{ type: "text", text }] },
});

/** A notification of about `bytes` bytes. */
const bulky = (bytes: number) => ({
  jsonrpc: "2.0",
  method: "notifications/message",
  params: { level: "info", data: "x".repeat(bytes) },
});

/**
 * `base`, whose `tools/call` is answered with `first`, and whose `GET` carrying a `Last-Event-ID` is answered by
 * `resumed`, given the call's JSON-RPC message and the id it asked to resume after.
 */
const resumable = (
  base: FakeServer,
  first: (rpc: RpcBody) => Response,
  resumed: (rpc: RpcBody, lastEventId: string, resumes: number) => Response,
) => {
  let call: RpcBody | undefined;
  let resumes = 0;

  return hostileServer(base, (request, rpc) => {
    if (rpc?.method === "tools/call") {
      call = rpc;

      return first(rpc);
    }

    const lastEventId = request.headers.get("last-event-id");

    if (request.method === "GET" && lastEventId !== null && call !== undefined) {
      resumes += 1;

      return resumed(call, lastEventId, resumes);
    }

    return undefined;
  });
};

/** The `Last-Event-ID`s the server was asked to resume after. */
const resumedAfter = (server: FakeServer) =>
  server.received.flatMap((received) => {
    const id = received.headers.get("last-event-id");

    return received.method === "GET" && id !== null ? [id] : [];
  });

const callsOf = (server: FakeServer) =>
  rpcMethods(server).filter((method) => method === "tools/call");

const legacyBases = bases.filter(([name]) => name !== "Modern");

describe.each(legacyBases)("a %s server that ends a call's stream early", (_name, base) => {
  it("is resumed with GET and Last-Event-ID to the answer", async () => {
    const server = resumable(
      base(),
      (rpc) => stream(priming("a-1", 2000), event(progress(rpc), { id: "a-2" })),
      (rpc, lastEventId) =>
        stream(event(answerOf(rpc, `resumed after ${lastEventId}`), { id: "a-3" })),
    );

    const { clock, slept } = recordingClock();
    const { called } = await attempt(server, clock);

    expect(called).toEqual({ content: [{ type: "text", text: "resumed after a-2" }] });
    expect(resumedAfter(server)).toEqual(["a-2"]);
    expect(slept).toEqual([2000]);
    expect(callsOf(server)).toHaveLength(1);

    const resume = server.received.find((received) => received.headers.has("last-event-id"));
    const post = server.received.find((received) => received.rpc?.method === "tools/call");

    expect(resume?.headers.get("accept")).toContain("text/event-stream");
    expect(resume?.headers.get("mcp-session-id")).toEqual(post?.headers.get("mcp-session-id"));
    expect(resume?.headers.get("mcp-protocol-version")).toEqual(
      post?.headers.get("mcp-protocol-version"),
    );
  });

  it("is resumed again for as long as each resume brings an event id (SSE polling)", async () => {
    const server = resumable(
      base(),
      () => stream(priming("p-1", 500)),
      (rpc, lastEventId, resumes) =>
        resumes < 4
          ? stream(priming(`p-${resumes + 1}`))
          : stream(event(answerOf(rpc, `answered after ${lastEventId}`), { id: "p-5" })),
    );

    const { clock, slept } = recordingClock();
    const { called } = await attempt(server, clock);

    expect(called).toEqual({ content: [{ type: "text", text: "answered after p-4" }] });
    expect(resumedAfter(server)).toEqual(["p-1", "p-2", "p-3", "p-4"]);
    expect(slept).toEqual([500, 500, 500, 500]);
  });

  it.each([
    ["no retry", undefined, 1000],
    ["a retry under 0.5 s", 100, 500],
    ["a retry over 10 s", 60_000, 10_000],
    ["a retry of 3 s", 3000, 3000],
  ])("waits %s out: %s ms is %s ms", async (_what, retry, waited) => {
    const server = resumable(
      base(),
      () => stream(priming("a-1", retry)),
      (rpc) => stream(event(answerOf(rpc, "done"))),
    );

    const { clock, slept } = recordingClock();

    await attempt(server, clock);

    expect(slept).toEqual([waited]);
  });

  it("keeps the event an early end left unfinished from the first resumed one", async () => {
    const server = resumable(
      base(),
      (rpc) =>
        stream(
          priming("a-1"),
          `id: a-2\nevent: message\ndata: ${JSON.stringify(progress(rpc)).slice(0, 30)}`,
        ),
      (rpc) => stream(event(answerOf(rpc, "whole"), { id: "a-3" })),
    );

    const { called } = await attempt(server);

    expect(called).toEqual({ content: [{ type: "text", text: "whole" }] });
    expect(resumedAfter(server)).toEqual(["a-1"]);
  });

  it("keeps an event the early end left unfinished after a line ending from the first resumed one", async () => {
    // The unfinished event is a whole answer short of its blank line: dispatched, it would answer the call.
    const server = resumable(
      base(),
      (rpc) =>
        stream(
          priming("a-1"),
          `id: a-2\nevent: message\ndata: ${JSON.stringify(answerOf(rpc, "premature"))}\n`,
        ),
      (rpc) => stream(event(answerOf(rpc, "whole"), { id: "a-3" })),
    );

    const { called } = await attempt(server);

    expect(called).toEqual({ content: [{ type: "text", text: "whole" }] });
    expect(resumedAfter(server)).toEqual(["a-1"]);
  });

  it.each([
    ["a CR after the line's LF", "\n\r"],
    ["two CRs", "\r\r"],
  ])("settles a stream whose answer ends in %s, event id or not", async (_what, ending) => {
    // The SDK's parser holds a CR at the end of a chunk back for a LF, and has nothing to flush it with.
    for (const id of ["a-1", undefined]) {
      const server = resumable(
        base(),
        (rpc) =>
          stream(
            `${id === undefined ? "" : `id: ${id}\n`}event: message\ndata: ${JSON.stringify(answerOf(rpc, "bare CR"))}${ending}`,
          ),
        (rpc) => stream(event(answerOf(rpc, "never asked for"))),
      );

      const { called } = await attempt(server);

      expect(called).toEqual({ content: [{ type: "text", text: "bare CR" }] });
      expect(resumedAfter(server)).toEqual([]);
    }
  });

  it("does not dispatch an answer an early end left with its last line cut short", async () => {
    // The unfinished event is whole but for its last line, an `id:` cut short; its answer must not be dispatched.
    const server = resumable(
      base(),
      (rpc) =>
        stream(
          priming("a-1"),
          `event: message\ndata: ${JSON.stringify(answerOf(rpc, "premature"))}\nid: a-`,
        ),
      (rpc) => stream(event(answerOf(rpc, "whole"), { id: "a-3" })),
    );

    const { called } = await attempt(server);

    expect(called).toEqual({ content: [{ type: "text", text: "whole" }] });
    expect(resumedAfter(server)).toEqual(["a-1"]);
  });

  it("does not take an answer in an event the SDK ignores for the answer: another type is not read", async () => {
    const ignored = (rpc: RpcBody, id?: string) =>
      stream(
        `${id === undefined ? "" : `id: ${id}\n`}event: other\ndata: ${JSON.stringify(answerOf(rpc, "ignored"))}\n\n`,
      );

    // No event id: cut at once, not left waiting for its timeout.
    const bare = resumable(
      base(),
      (rpc) => ignored(rpc),
      (rpc) => stream(event(answerOf(rpc, "x"))),
    );

    expect((await attempt(bare)).called).toEqual(failedWith(Cut, { mayHaveRun: true }));

    // With one: resumed to the answer the SDK reads.
    const resumed = resumable(
      base(),
      (rpc) => ignored(rpc, "a-1"),
      (rpc) => stream(event(answerOf(rpc, "whole"), { id: "a-2" })),
    );

    expect((await attempt(resumed)).called).toEqual({ content: [{ type: "text", text: "whole" }] });
  });

  it("keeps a first resumed line from joining a whitespace-only line the early end left", async () => {
    const server = resumable(
      base(),
      () => stream(priming("a-1"), "  "),
      (rpc) => stream(`data: ${JSON.stringify(answerOf(rpc, "whole"))}\n\n`),
    );

    const { called } = await attempt(server);

    expect(called).toEqual({ content: [{ type: "text", text: "whole" }] });
  });

  it("is cut when a resume fails twice in a row, and it may have run", async () => {
    const server = resumable(
      base(),
      () => stream(priming("a-1")),
      () => new Response(null, { status: 503 }),
    );

    const { clock, slept } = recordingClock();
    const { called } = await attempt(server, clock);

    expect(called).toEqual(failedWith(Cut, { mayHaveRun: true }));
    expect(resumedAfter(server)).toEqual(["a-1", "a-1"]);
    expect(slept).toEqual([1000, 1000]);
    expect(callsOf(server)).toHaveLength(1);
  });

  it("is cut at once when the server cannot resume it (a 404 or 405)", async () => {
    const server = resumable(
      base(),
      () => stream(priming("a-1")),
      () => new Response(null, { status: 405 }),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(Cut, { mayHaveRun: true }));
    expect(resumedAfter(server)).toEqual(["a-1"]);
  });

  it("is cut when its resumes bring no new event: that is no progress either", async () => {
    const server = resumable(
      base(),
      () => stream(priming("a-1")),
      () => stream(priming("a-1")),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(Cut, { mayHaveRun: true }));
    expect(resumedAfter(server)).toEqual(["a-1", "a-1"]);
  });

  it("is cut when a resume breaks mid-stream and the next one fails", async () => {
    const server = resumable(
      base(),
      () => stream(priming("a-1")),
      (_rpc, _lastEventId, resumes) => {
        if (resumes > 1) throw new TypeError("network connection lost");

        return stream(priming("a-2"));
      },
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(Cut, { mayHaveRun: true }));
    expect(resumedAfter(server)).toEqual(["a-1", "a-2", "a-2"]);
  });

  it("is not resumed when its stream carried no event id: cut at once", async () => {
    const server = resumable(
      base(),
      (rpc) => stream(event(progress(rpc))),
      (rpc) => stream(event(answerOf(rpc, "never asked for"))),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(Cut, { mayHaveRun: true }));
    expect(resumedAfter(server)).toEqual([]);
  });

  it("counts the resumed bytes toward the 16 MiB budget", async () => {
    const chunk = 512 * KiB;

    const server = resumable(
      base(),
      () => stream(...Array.from({ length: 20 }, (_, i) => event(bulky(chunk), { id: `a-${i}` }))),
      (rpc) =>
        stream(
          ...Array.from({ length: 16 }, (_, i) => event(bulky(chunk), { id: `b-${i}` })),
          event(answerOf(rpc, "too late"), { id: "b-end" }),
        ),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(TooLarge, { limit: 16 * MiB }));
  });

  it("answers within the budget when the first stream and the resumed one fit in it", async () => {
    const chunk = 512 * KiB;

    const server = resumable(
      base(),
      () => stream(...Array.from({ length: 20 }, (_, i) => event(bulky(chunk), { id: `a-${i}` }))),
      (rpc) =>
        stream(
          ...Array.from({ length: 8 }, (_, i) => event(bulky(chunk), { id: `b-${i}` })),
          event(answerOf(rpc, "in time"), { id: "b-end" }),
        ),
    );

    const { called } = await attempt(server);

    expect(called).toEqual({ content: [{ type: "text", text: "in time" }] });
  });

  it("holds an event on the resumed stream to 1 MiB, though the first stream's may be larger", async () => {
    const answered = (resumedEvent: number) =>
      resumable(
        base(),
        (rpc) => stream(event(bulky(2 * MiB), { id: "a-1" }), event(progress(rpc), { id: "a-2" })),
        (rpc) =>
          stream(
            event(bulky(resumedEvent), { id: "b-1" }),
            event(answerOf(rpc, "ok"), { id: "b-2" }),
          ),
      );

    expect((await attempt(answered(512 * KiB))).called).toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect((await attempt(answered(MiB + 1))).called).toEqual(failedWith(TooLarge, { limit: MiB }));
  });
});

describe("a Modern server that ends a call's stream early", () => {
  it("is not resumed, event ids or not: cut at once", async () => {
    const server = resumable(
      modernServer(),
      (rpc) => stream(priming("a-1"), event(progress(rpc), { id: "a-2" })),
      (rpc) => stream(event(answerOf(rpc, "never asked for"))),
    );

    const { called } = await attempt(server);

    expect(called).toEqual(failedWith(Cut, { mayHaveRun: true }));
    expect(resumedAfter(server)).toEqual([]);
  });
});

describe("the tap's resumed stream", () => {
  const ENDPOINT = "https://example.test/mcp";
  const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: {} };

  const post = (wire: ReturnType<typeof tapFetch>, signal: AbortSignal | null = null) =>
    wire(ENDPOINT, {
      method: "POST",
      body: JSON.stringify(call),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "session-1",
        "mcp-protocol-version": "2025-11-25",
        authorization: "Bearer token",
      },
      signal,
    });

  it("hands the SDK only the request's own events: another request's answer is dropped", async () => {
    const resumeHeaders: Array<Headers> = [];

    const wire = tapFetch(
      async (_input, init) => {
        if (init?.method === "GET") {
          resumeHeaders.push(new Headers(init.headers));

          return stream(
            event({ jsonrpc: "2.0", id: 8, result: { stolen: true } }, { id: "a-2" }),
            event([
              { jsonrpc: "2.0", id: 9, result: {} },
              { jsonrpc: "2.0", id: 7, result: {} },
            ]),
            event({ jsonrpc: "2.0", id: null, error: { code: -1, message: "stolen" } }),
            event({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } }),
            event({ jsonrpc: "2.0", id: 7, result: { own: true } }, { id: "a-3" }),
          );
        }

        return stream(priming("a-1"));
      },
      { now: () => 0, sleep: async () => undefined },
      new Verdicts(),
    );

    const response = await post(wire);
    const text = await response.text();

    expect(text).not.toContain("stolen");
    expect(text).not.toContain('"id":8');
    expect(text).not.toContain('"id":9');
    expect(text).toContain('"own":true');
    expect(text).toContain("notifications/message");
    expect(resumeHeaders).toHaveLength(1);
    expect(resumeHeaders[0]?.get("last-event-id")).toBe("a-1");
    expect(resumeHeaders[0]?.get("authorization")).toBe("Bearer token");
    expect(resumeHeaders[0]?.get("mcp-session-id")).toBe("session-1");
    expect(resumeHeaders[0]?.get("content-type")).toBeNull();
  });

  it("keeps a CRLF split between chunks from ending an event", async () => {
    const wire = tapFetch(
      async (_input, init) =>
        init?.method === "GET"
          ? chunked([
              'id: a-2\r\ndata: {"jsonrpc":"2.0","id":7,\r',
              '\ndata: "result":{"own":true}}\r\n\r\n',
            ])
          : stream(priming("a-1")),
      { now: () => 0, sleep: async () => undefined },
      new Verdicts(),
    );

    const text = await (await post(wire)).text();

    expect(text).toContain('"id":7,\ndata: "result":{"own":true}}\n\n');
    expect(text).not.toContain("may or may not have run");
  });

  it("splits a stream fed in tiny chunks into the events it carries", async () => {
    const big = `data: ${"x".repeat(MiB - 1024)}`;
    const resumed = () => chunked([`${big}\n\n`, event(answerOf({ id: 7 }, "ok"))], 64);

    const wire = tapFetch(
      async (_input, init) => (init?.method === "GET" ? resumed() : stream(priming("a-1"))),
      { now: () => 0, sleep: async () => undefined },
      new Verdicts(),
    );

    const text = await (await post(wire)).text();

    expect(text).toContain('"id":7');
    expect(text).not.toContain("over 1 MiB");
  });

  it.each([
    ["a line ending and then the blank line", (event: string) => [`${event}\n`, "\n"]],
    ["the whole event and its blank line", (event: string) => [`${event}\n\n`]],
  ])(
    "holds a GET stream's event to 1 MiB, not a byte over, whether it arrives as %s",
    async (_what, split) => {
      const read = async (size: number) => {
        const wire = tapFetch(
          async () => chunked(split(eventOfSize(size))),
          { now: () => 0, sleep: async () => undefined },
          new Verdicts(),
        );

        return (await wire(ENDPOINT, { method: "GET" })).text();
      };

      expect((await read(MiB)).length).toBeGreaterThan(MiB);
      expect(await read(MiB + 1)).toBe("");
    },
  );

  it("reads a character split between chunks whole, on a resumed stream", async () => {
    const answer = new TextEncoder().encode(
      event({ jsonrpc: "2.0", id: 7, result: { text: "é" } }),
    );

    const split = answer.indexOf(0xc3) + 1;

    const wire = tapFetch(
      async (_input, init) =>
        init?.method === "GET" ? byteChunks(answer, split) : stream(priming("a-1")),
      { now: () => 0, sleep: async () => undefined },
      new Verdicts(),
    );

    expect(await (await post(wire)).text()).toContain('"text":"é"');
  });

  it("counts a character split between chunks once, on a GET stream", async () => {
    // Exactly 1 MiB of two-byte characters, in chunks that cut some of them in half.
    const bytes = new TextEncoder().encode(`${eventOfSize(MiB, "é")}\n\n`);

    const wire = tapFetch(
      async () => byteChunks(bytes, 65_537),
      { now: () => 0, sleep: async () => undefined },
      new Verdicts(),
    );

    expect((await (await wire(ENDPOINT, { method: "GET" })).text()).length).toBeGreaterThan(
      MiB / 2,
    );
  });

  it("is not opened once the request is aborted while it waits", async () => {
    const controller = new AbortController();
    let gets = 0;

    const wire = tapFetch(
      async (_input, init) => {
        if (init?.method === "GET") gets += 1;

        return stream(priming("a-1"));
      },
      {
        now: () => 0,
        sleep: async () => {
          controller.abort();
        },
      },
      new Verdicts(),
    );

    const response = await post(wire, controller.signal);

    await response.text();

    expect(gets).toBe(0);
  });
});
