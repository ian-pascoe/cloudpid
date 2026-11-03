/**
 * The `prior` rows (`docs/architecture/mcp.md` → Protocol eras, Deploys; `docs/architecture/mcp-connections.md` →
 * Storage, Requests and Legacy sessions): a Modern server reconnects with no round trip, a Legacy session goes on with
 * no `initialize`, a row of an unknown format `v` reads as absent, and a Legacy era row is probed again once 24 h old.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { AGENT, HOST, completed, memoryStore, run, TARGET, testDeps } from "./core.fixture.ts";
import {
  ECHO_TOOL,
  type FakeServer,
  fetchTo,
  hostileServer,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  rpcMethods,
} from "./fakes.fixture.ts";
import { connect, type McpDeps, type RowStore } from "./index.ts";

const HOUR = 60 * 60 * 1000;

const now = () => Effect.runSync(Clock.currentTimeMillis);

/** Connects with `deps`, lists the tools and calls `echo`; returns the era and what was called. */
const listAndCall = (deps: McpDeps) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(TARGET, deps);
      const tools = yield* connection.list("tools", HOST);

      const called = yield* connection.callTool(
        { tool: ECHO_TOOL, arguments: { text: "hi" } },
        AGENT,
      );

      return {
        era: connection.era,
        tools: tools.value.map((tool) => tool.name),
        called: completed(called).value.content,
        capabilities: connection.capabilities,
        instructions: connection.instructions,
      };
    }),
  );

const count = (server: FakeServer, method: string) =>
  rpcMethods(server).filter((sent) => sent === method).length;

describe("the era row", () => {
  it("lets a Modern server reconnect with no round trip", async () => {
    const server = modernServer();
    const eras = memoryStore();
    const deps = testDeps(fetchTo(server), { eras: eras.store });

    await listAndCall(deps);

    expect(eras.current()).toMatchObject({ v: 1, era: "modern", version: "2026-07-28" });

    const again = await listAndCall(deps);

    expect(again.era).toBe("modern");
    expect(again.called).toEqual([{ type: "text", text: "hi" }]);
    expect(count(server, "server/discover")).toBe(1);
  });

  it("reads a row of an unknown format as absent, and probes again", async () => {
    const server = modernServer();
    const eras = memoryStore({ v: 99, era: "legacy", version: "2025-11-25", probedAt: now() });

    const connected = await listAndCall(testDeps(fetchTo(server), { eras: eras.store }));

    expect(connected.era).toBe("modern");
    expect(count(server, "server/discover")).toBe(1);
    expect(count(server, "initialize")).toBe(0);
    expect(eras.current()).toMatchObject({ v: 1, era: "modern" });
  });

  it("initializes a Legacy server with no probe while its row is under 24 h old", async () => {
    const server = legacyStatelessServer();

    const eras = memoryStore({
      v: 1,
      era: "legacy",
      version: "2025-11-25",
      probedAt: now() - HOUR,
    });

    const connected = await listAndCall(testDeps(fetchTo(server), { eras: eras.store }));

    expect(connected.era).toBe("legacy");
    expect(count(server, "server/discover")).toBe(0);
    expect(count(server, "initialize")).toBe(1);
  });

  it("probes a Legacy server again once its row is 24 h old", async () => {
    const server = legacyStatelessServer();
    const probedAt = now() - 25 * HOUR;
    const eras = memoryStore({ v: 1, era: "legacy", version: "2025-11-25", probedAt });

    await listAndCall(testDeps(fetchTo(server), { eras: eras.store }));

    expect(count(server, "server/discover")).toBe(1);
    expect(eras.current()).toMatchObject({ v: 1, era: "legacy" });
    expect(eras.current()).not.toMatchObject({ probedAt });
  });

  it("probes again when a Legacy-cached server now speaks Modern", async () => {
    const server = modernServer();
    const eras = memoryStore({ v: 1, era: "legacy", version: "2025-11-25", probedAt: now() });

    const connected = await listAndCall(testDeps(fetchTo(server), { eras: eras.store }));

    expect(connected.era).toBe("modern");
    expect(eras.current()).toMatchObject({ v: 1, era: "modern" });
  });
});

describe("the Legacy session row", () => {
  it("goes on with a session with no initialize, serving the server's capabilities from the row", async () => {
    const server = legacyStatefulServer();
    const sessions = memoryStore();
    const deps = testDeps(fetchTo(server), { sessions: sessions.store });

    await listAndCall(deps);

    expect(sessions.current()).toMatchObject({
      v: 1,
      sessionId: "session-1",
      protocolVersion: "2025-11-25",
    });

    const again = await listAndCall(deps);

    expect(again.called).toEqual([{ type: "text", text: "hi" }]);
    expect(again.capabilities).toEqual({ tools: { listChanged: true } });
    expect(again.instructions).toBe("Use the echo tool.");
    expect(count(server, "initialize")).toBe(1);
  });

  it("reads a row of an unknown format as absent, and initializes again", async () => {
    const server = legacyStatefulServer();
    const sessions = memoryStore({ v: 2, sessionId: "session-9", protocolVersion: "2025-11-25" });

    await listAndCall(testDeps(fetchTo(server), { sessions: sessions.store }));

    expect(count(server, "initialize")).toBe(1);
    expect(sessions.current()).toMatchObject({ v: 1, sessionId: "session-1" });
  });

  it("initializes again and sends the request once more when the server forgot the session", async () => {
    const server = legacyStatefulServer();
    const sessions = memoryStore();
    const deps = testDeps(fetchTo(server), { sessions: sessions.store });

    await listAndCall(deps);
    server.forget();

    const again = await listAndCall(deps);

    expect(again.called).toEqual([{ type: "text", text: "hi" }]);
    expect(count(server, "initialize")).toBe(2);
    // Two pages, then the first page refused with 404 and sent again, then the second.
    expect(count(server, "tools/list")).toBe(5);
    expect(sessions.current()).toMatchObject({ sessionId: "session-2" });
  });
});

describe("an era drop", () => {
  /** A Modern server that answers its first `tools/call` with `refusal`. */
  const refusingCallOnce = (refusal: (id: string | number | undefined) => Response) => {
    let refused = false;

    return hostileServer(modernServer(), (_request, rpc) => {
      if (rpc?.method !== "tools/call" || refused) {
        return undefined;
      }

      refused = true;

      return refusal(rpc.id);
    });
  };

  /** A Modern era row, from connecting once to a Modern server. */
  const modernRow = async () => {
    const eras = memoryStore();

    await listAndCall(testDeps(fetchTo(modernServer()), { eras: eras.store }));

    return eras;
  };

  it("probes again and sends the request once more when a Modern-cached server now speaks Legacy", async () => {
    const eras = await modernRow();
    const server = legacyStatelessServer();

    const connected = await listAndCall(testDeps(fetchTo(server), { eras: eras.store }));

    expect(connected.era).toBe("legacy");
    expect(connected.called).toEqual([{ type: "text", text: "hi" }]);
    expect(eras.current()).toMatchObject({ v: 1, era: "legacy" });
  });

  it.each([
    ["404", () => new Response("Not found", { status: 404 })],
    ["405", () => new Response(null, { status: 405 })],
    ["400 with no Modern error", () => new Response("Bad request", { status: 400 })],
    [
      "-32022",
      (id: string | number | undefined) =>
        Response.json(
          {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32022,
              message: "Unsupported protocol version",
              data: { supported: ["2026-07-28"], requested: "2026-07-28" },
            },
          },
          { status: 400 },
        ),
    ],
  ])("sends a refused call once more after a %s", async (_name, refusal) => {
    const eras = await modernRow();
    const server = refusingCallOnce(refusal);

    const connected = await listAndCall(testDeps(fetchTo(server), { eras: eras.store }));

    expect(connected.called).toEqual([{ type: "text", text: "hi" }]);
    expect(count(server, "server/discover")).toBe(1);
    expect(count(server, "tools/call")).toBe(2);
  });

  it("probes again and sends a refused call once more on a connection that probed Modern itself", async () => {
    const server = refusingCallOnce(() => new Response("Not found", { status: 404 }));
    const eras = memoryStore();
    const writes: Array<string> = [];

    const store: RowStore = {
      get: eras.store.get,
      set: (row) =>
        Effect.andThen(
          Effect.sync(() => writes.push("set")),
          eras.store.set(row),
        ),
      drop: Effect.andThen(
        Effect.sync(() => writes.push("drop")),
        eras.store.drop,
      ),
    };

    const connected = await listAndCall(testDeps(fetchTo(server), { eras: store }));

    expect(connected.called).toEqual([{ type: "text", text: "hi" }]);
    expect(count(server, "server/discover")).toBe(2);
    expect(count(server, "tools/call")).toBe(2);
    expect(writes).toEqual(["set", "drop", "set"]);
    expect(eras.current()).toMatchObject({ v: 1, era: "modern" });
  });
});
