/**
 * The core's listen, in both eras (`docs/architecture/mcp-in-a-session.md` → Resource watches; `docs/architecture/
 * mcp-connections.md` → Requests and Legacy sessions → Listens): a Modern server's `subscriptions/listen` and a Legacy
 * server's `resources/subscribe` with its GET stream, the events each carries, how each ends, and the Legacy server that
 * cannot send updates.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off unnecessaryEffectGen:off
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";
import { failedWith, run, settled, TARGET, testDeps } from "./core.fixture.ts";
import {
  type FakeOptions,
  fetchTo,
  hostileServer,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  rpcMethods,
} from "./fakes.fixture.ts";
import { connect } from "./index.ts";
import { type McpListenEvent, TimedOut, Unsupported } from "./types.ts";

const URI = "file:///notes.md";

const OTHER = "file:///other.md";

/**
 * How long a wait for the events lasts: a deadline well under the tests' timeout, not a count of polls, which a loaded
 * runner's slow timers stretch or cut short (#632).
 */
const WAIT = { timeout: 10_000, interval: 10 };

/** Waits until `events` holds `count` of them (the notifications reach the client a moment after they are sent). */
const until = (events: ReadonlyArray<McpListenEvent>, count: number) =>
  vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(count), WAIT);

/** Waits until `events` holds the update of `uri` and a change of the `list`. */
const untilHeard = (
  events: ReadonlyArray<McpListenEvent>,
  uri: string,
  list: "tools" | "prompts" | "resources",
) =>
  vi.waitFor(() => {
    expect(events).toContainEqual({ kind: "resource_updated", uri });
    expect(events).toContainEqual({ kind: "list_changed", list });
  }, WAIT);

/**
 * `fetchTo(server)` whose streamed answers end when their request is aborted, as a real connection's do: the in-process
 * answer would otherwise stay open on the server for ever, and the session would keep a GET stream nobody reads.
 */
const hangingUp =
  (server: Parameters<typeof fetchTo>[0]): typeof fetch =>
  async (input, init) => {
    const response = await fetchTo(server)(input, init);
    const { body, signal } = { body: response.body, signal: init?.signal };

    if (body === null || signal === null || signal === undefined) return response;

    const reader = body.getReader();

    let over = false;

    const hung = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));

        if (over) return;

        if (chunk.done) {
          over = true;
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      },
      start: (controller) => {
        const hangUp = () => {
          void reader.cancel().catch(() => undefined);

          if (!over) controller.close();

          over = true;
        };

        // A request aborted before its answer came is hung up on as the answer does.
        if (signal.aborted) hangUp();
        else signal.addEventListener("abort", hangUp, { once: true });
      },
      cancel: (reason) => reader.cancel(reason),
    });

    return new Response(hung, response);
  };

const subscriptions = () => {
  const subscribed: Array<string> = [];
  const unsubscribed: Array<string> = [];

  return { subscribed, unsubscribed };
};

describe("a Modern server's listen", () => {
  it("opens a subscriptions/listen with the filter, says what the server honors, and hears an update and a list change", async () => {
    const server = modernServer({ resources: [], prompts: [], subscriptions: subscriptions() });
    const events: Array<McpListenEvent> = [];

    const honored = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        const listening = yield* connection.listen(
          { resourceSubscriptions: [URI], promptsListChanged: true },
          (event) => events.push(event),
        );

        server.notify.resourceUpdated(URI);
        server.notify.promptsChanged();
        yield* Effect.promise(() => until(events, 2));
        yield* listening.close;

        return listening.honored;
      }),
    );

    expect(honored).toEqual({ resourceSubscriptions: [URI], promptsListChanged: true });
    expect(events).toEqual([
      { kind: "resource_updated", uri: URI },
      { kind: "list_changed", list: "prompts" },
    ]);
    expect(rpcMethods(server)).toContain("subscriptions/listen");
    expect(rpcMethods(server)).not.toContain("resources/subscribe");
  });

  it("says closed `local` once the caller closes it, and stops telling of events", async () => {
    const server = modernServer({ subscriptions: subscriptions() });
    const events: Array<McpListenEvent> = [];

    const ended = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        const listening = yield* connection.listen({ resourceSubscriptions: [URI] }, (event) =>
          events.push(event),
        );

        yield* listening.close;
        server.notify.resourceUpdated(URI);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));

        return yield* listening.closed;
      }),
    );

    expect(ended).toBe("local");
    expect(events).toEqual([]);
  });

  it("fails a listen the server never acknowledges as timed out", async () => {
    const base = modernServer();

    // A listen the server answers with nothing: the stream opens and stays silent.
    const silent = hostileServer(base, (request, rpc) =>
      rpc?.method === "subscriptions/listen"
        ? new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), {
            headers: { "content-type": "text/event-stream" },
          })
        : undefined,
    );

    const outcome = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(silent)));

        return yield* settled(connection.listen({ resourceSubscriptions: [URI] }, () => undefined));
      }),
    );

    expect(outcome).toEqual(failedWith(TimedOut));
  }, 20_000);
});

describe("a Legacy server's listen", () => {
  const withSubscriptions = (options: FakeOptions = {}) => {
    const log = subscriptions();

    return { log, server: legacyStatefulServer({ resources: [], subscriptions: log, ...options }) };
  };

  it("subscribes each URI with the GET stream open, and hears an update and a list change on it", async () => {
    const { log, server } = withSubscriptions();
    const events: Array<McpListenEvent> = [];

    const honored = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        const listening = yield* connection.listen(
          { resourceSubscriptions: [URI, OTHER], resourcesListChanged: true },
          (event) => events.push(event),
        );

        yield* Effect.promise(() => server.update(URI));
        yield* Effect.promise(() => server.listChanged("resources"));
        // The server also announces a change of its tools with each call.
        yield* Effect.promise(() => untilHeard(events, URI, "resources"));
        yield* listening.close;

        return listening.honored;
      }),
    );

    expect(honored.resourceSubscriptions).toEqual([URI, OTHER]);
    expect(honored.resourcesListChanged).toBe(true);
    expect(log.subscribed.toSorted()).toEqual([URI, OTHER]);
    expect(log.unsubscribed.toSorted()).toEqual([URI, OTHER]);
    expect(events).toContainEqual({ kind: "resource_updated", uri: URI });
    expect(events).toContainEqual({ kind: "list_changed", list: "resources" });
  });

  it("leaves out a URI the server refuses to subscribe", async () => {
    const log = { ...subscriptions(), refuse: [OTHER] };
    const server = legacyStatefulServer({ resources: [], subscriptions: log });

    const honored = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        const listening = yield* connection.listen(
          { resourceSubscriptions: [URI, OTHER] },
          () => undefined,
        );

        yield* listening.close;

        return listening.honored;
      }),
    );

    expect(honored.resourceSubscriptions).toEqual([URI]);
  });

  it("honors no URI of a server that does not declare resources.subscribe, and sends no subscribe", async () => {
    const server = legacyStatefulServer({ resources: [] });

    const honored = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        const listening = yield* connection.listen(
          { resourceSubscriptions: [URI] },
          () => undefined,
        );

        yield* listening.close;

        return listening.honored;
      }),
    );

    expect(honored.resourceSubscriptions).toEqual([]);
    expect(rpcMethods(server)).not.toContain("resources/subscribe");
  });

  it("says closed `remote` when the server cuts the GET stream, and does not open it again", async () => {
    const { server } = withSubscriptions();

    const { ended, gets } = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        const listening = yield* connection.listen(
          { resourceSubscriptions: [URI] },
          () => undefined,
        );

        yield* Effect.promise(() => server.cutStreams());

        return {
          ended: yield* listening.closed,
          gets: server.received.filter((each) => each.method === "GET").length,
        };
      }),
    );

    expect(ended).toBe("remote");
    expect(gets).toBe(1);
  });

  it("opens the GET stream of a connection made from a session row, which an earlier connection initialized", async () => {
    const { log, server } = withSubscriptions();
    const deps = testDeps(hangingUp(server));

    await run(
      Effect.gen(function* () {
        yield* connect(TARGET, deps);
      }),
    );

    // The server notices the first connection's GET stream is gone.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const honored = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, deps);

        const listening = yield* connection.listen(
          { resourceSubscriptions: [URI] },
          () => undefined,
        );

        yield* listening.close;

        return listening.honored;
      }),
    );

    expect(honored.resourceSubscriptions).toEqual([URI]);
    expect(log.subscribed).toEqual([URI]);
    // One `initialize`, so the second connection resumed the session.
    expect(rpcMethods(server).filter((method) => method === "initialize")).toHaveLength(1);
  });

  it("cannot send updates when the server has no sessions, its GET stream being 405", async () => {
    const server = legacyStatelessServer({ resources: [] });

    const outcome = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        return yield* settled(connection.listen({ resourceSubscriptions: [URI] }, () => undefined));
      }),
    );

    expect(outcome).toEqual(failedWith(Unsupported, { message: "The server cannot send updates" }));
    expect(rpcMethods(server)).not.toContain("resources/subscribe");
  });

  it("cannot send updates when the server answers the GET stream 405 for its session", async () => {
    const { server: base } = withSubscriptions();

    const refusing = hostileServer(base, (request) =>
      request.method === "GET" ? new Response(null, { status: 405 }) : undefined,
    );

    const outcome = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(refusing)));

        return yield* settled(connection.listen({ resourceSubscriptions: [URI] }, () => undefined));
      }),
    );

    expect(outcome).toEqual(failedWith(Unsupported, { message: "The server cannot send updates" }));
    expect(rpcMethods(refusing)).not.toContain("resources/subscribe");
  });
});
