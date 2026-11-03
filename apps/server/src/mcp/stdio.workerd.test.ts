// A stdio server at the host (`docs/architecture/mcp-connections.md` → The stdio bridge, Discovery and the MCP inventory,
// Storage) over real Durable Object SQLite and a scripted engine: discovered only on a live caller's demand, in that
// caller's Workspace, with the entry's `env` resolved and the Workspace's Repos as Roots; its calls in the caller's
// Workspace, its rows per Workspace with the spawn id; an older bridge `failed`.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalTimers:off newPromise:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpHostRequest,
  McpRequestStart,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import type { EngineScript, RequestScript, TestMcpHost } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

let counter = 0;

/** A host named as the main Worker names one, that no earlier test has touched. */
const freshHost = () => env.MCP_HOSTS.getByName(`mcp:stdio${counter++}`);

type Host = ReturnType<typeof freshHost>;

const MINUTE = 60_000;

const WORKSPACE = "ws:aaaa1111";

const ELSEWHERE = "ws:bbbb2222";

/** What the host's scripts of a stdio server are keyed by. */
const keyOf = (name: string) => `stdio:${name}`;

const entry = (name: string, server: Readonly<Record<string, Schema.Json>> = {}): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "stdio", command: "npx", args: ["-y", "some-server"], env: {}, ...server },
  hash: `hash-${name}`,
  conn: `conn-${name}`,
  identity: `identity-${name}`,
});

let revision = 1;

const setOf = (...entries: ReadonlyArray<McpSetEntry>): McpApplySet => ({
  kind: "set",
  hash: entries.map((each) => `${each.name}:${each.hash}`).join("|"),
  revision: revision++,
  entries,
});

type Encoded = typeof McpEngineDiscoverResult.Encoded;

/** A discovery that found `tools`, on the child with spawn id `spawn` and no session row (a Modern server). */
const found = (
  tools: ReadonlyArray<string>,
  extra: Partial<Encoded> & { readonly spawn?: string } = {},
): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it, with the fields `extra` overrides.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {} },
    tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {
      era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 },
    },
    ...extra,
  } as Encoded,
});

const failedWith = (error: Readonly<Record<string, Schema.Json>>): EngineScript => ({
  // SAFETY: a failure as it crosses the edge; the host decodes it.
  result: { kind: "failed", error, state: {} } as Encoded,
});

const completed = (
  text: string,
  extra: Partial<typeof McpEngineRequestResult.Encoded> = {},
): RequestScript => ({
  // SAFETY: a completed answer, encoded as the engine sends it, with the fields `extra` adds.
  result: {
    kind: "complete",
    result: { kind: "inline", value: { content: [{ type: "text", text }] } },
    cacheable: true,
    fetchedAt: Date.now(),
    state: {},
    ...extra,
  } as typeof McpEngineRequestResult.Encoded,
});

const caller = (workspace: string) => ({ session: "s-1", conversation: "1", workspace });

const start = (host: Host, workspace: string = WORKSPACE, more: Partial<McpRequestStart> = {}) =>
  host.requestStart({ caller: caller(workspace), ...more });

/** `requestStart` as a Session that built its tools before: it waits for nothing. */
const restart = (host: Host, workspace: string = WORKSPACE) =>
  start(host, workspace, { known: "built" });

const stateOf = async (host: Host, name: string, workspace: string = WORKSPACE) =>
  (await restart(host, workspace)).servers[name]?.state;

/** Long enough for a discovery that was started to reach the engine. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

/** Wait for every discovery in flight to end. */
const settled = (host: Host) => host.servers({ parts: [], waitMs: 10_000 });

/** A `tools/call` of `tool` on `server`, from `workspace` (none: a call that named no Workspace). */
const call = (
  server: string,
  tool: string,
  workspace: string = WORKSPACE,
): typeof McpHostRequest.Encoded => ({
  op: "tools/call",
  server,
  params: { name: tool, arguments: {} },
  ctx: { origin: "agent", callId: "call-1", session: "s-1", conversation: "1", workspace },
});

/** A host with `local` (a stdio server) in its set, discovered in `WORKSPACE` with `tools`. */
const discovered = async (tools: ReadonlyArray<string>, ...more: ReadonlyArray<EngineScript>) => {
  const host = freshHost();

  await host.apply(setOf(entry("local")));
  await host.scriptEngine(keyOf("local"), [found(tools), ...more]);
  await start(host, WORKSPACE, { waitFor: ["local"], waitMs: 5000 });
  await settled(host);

  return host;
};

describe("discovery", () => {
  it("is made on a live caller's demand, in the caller's Workspace, the Container started for it", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("local", { cwd: "/workspace/app", env: { TOKEN: "${TOKEN}" } })));
    await host.scriptValues("local", {
      status: "values",
      env: { TOKEN: "resolved-1234" },
      headers: {},
      missing: [],
      redact: ["resolved-1234"],
      repos: [
        { directory: "app", slug: "ian/app" },
        { directory: "lib", slug: "ian/lib" },
      ],
    });
    await host.scriptEngine(keyOf("local"), [found(["search"])]);

    const answer = await start(host, WORKSPACE, { waitFor: ["local"], waitMs: 5000 });

    expect(answer.servers.local?.state).toBe("connected");
    expect((await host.engineCalls()).map((each) => each.target)).toEqual([
      {
        kind: "stdio",
        conn: "conn-local",
        name: "local",
        workspace: WORKSPACE,
        start: true,
        command: "npx",
        args: ["-y", "some-server"],
        env: { TOKEN: "resolved-1234" },
        cwd: "/workspace/app",
        roots: [
          { uri: "file:///workspace/app", name: "ian/app" },
          { uri: "file:///workspace/lib", name: "ian/lib" },
        ],
        redact: ["resolved-1234"],
        timeoutMs: 60_000,
      },
    ]);
    // The Registry was told the Workspace, whose Repos it answers.
    expect(await host.valueAsks()).toMatchObject([{ server: "local", workspace: WORKSPACE }]);
    expect(await host.dump()).not.toContain("resolved-1234");
  });

  it("is not made by a set, a reload, or a read that names no Workspace: nothing starts a Container for it", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("local")));
    await host.scriptEngine(keyOf("local"), [found(["search"])]);
    await host.apply({ kind: "reload" });
    await host.servers({ parts: [], waitMs: 1000 });

    expect(await host.engineCalls()).toEqual([]);
    expect(await stateOf(host, "local", "")).toBe("not_discovered");
    expect(await host.engineCalls()).toEqual([]);
  });

  it("reads an older bridge as the server failed, with what to do", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("local")));
    await host.scriptEngine(keyOf("local"), [
      failedWith({
        _tag: "Unsupported",
        message: "this Container runs an older bridge; restart it",
      }),
    ]);

    await start(host, WORKSPACE, { waitFor: ["local"], waitMs: 5000 });

    const [server] = (await settled(host)).servers;

    expect(server).toMatchObject({
      state: "failed",
      error: "this Container runs an older bridge; restart it",
    });
  });

  it("reads a Workspace that is gone as unavailable, to be asked again after the backoff", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("local")));
    await host.scriptEngine(keyOf("local"), [
      failedWith({ _tag: "Unreachable", message: "The Workspace no longer exists", status: 404 }),
      found(["search"]),
    ]);
    await start(host, WORKSPACE, { waitFor: ["local"], waitMs: 5000 });
    await settled(host);

    expect(await stateOf(host, "local")).toBe("unavailable");

    // Held back 30 s: the next demand finds it there.
    expect(await host.engineCalls()).toHaveLength(1);
    await host.advance(31_000);
    await restart(host);
    await settled(host);

    expect(await stateOf(host, "local")).toBe("connected");
  });

  it("tries a failed server again on a demand once a minute has passed, not before", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("local")));
    await host.scriptEngine(keyOf("local"), [
      failedWith({ _tag: "ProtocolViolation", message: "not MCP" }),
      found(["search"]),
    ]);
    await start(host, WORKSPACE, { waitFor: ["local"], waitMs: 5000 });
    await settled(host);

    expect(await stateOf(host, "local")).toBe("failed");
    await host.advance(30_000);
    await restart(host);
    await settled(host);
    expect(await host.engineCalls()).toHaveLength(1);

    await host.advance(31_000);
    await restart(host);
    await settled(host);
    expect(await host.engineCalls()).toHaveLength(2);
    expect(await stateOf(host, "local")).toBe("connected");
  });

  it("skips a server whose ${NAME} resolves to nothing, as an HTTP one is", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("local", { env: { TOKEN: "${TOKEN}" } })));
    await host.scriptValues("local", {
      status: "values",
      env: { TOKEN: "${TOKEN}" },
      headers: {},
      missing: ["TOKEN"],
    });

    const answer = await start(host, WORKSPACE, { waitFor: ["local"], waitMs: 5000 });

    expect(answer.servers.local?.state).toBe("skipped");
    expect(await host.engineCalls()).toEqual([]);
  });
});

const notRunning = () =>
  failedWith({
    _tag: "Unreachable",
    message: "The Workspace's Container is stopped",
    stopped: true,
  });

/** The `start` of each discovery the engine was asked for, in order. */
const starts = async (host: Host) =>
  (await host.engineCalls()).map((each) =>
    each.target.kind === "stdio" ? each.target.start : null,
  );

describe("a refresh of what is kept", () => {
  it("never starts a Container: past its TTL a connected server is asked only where its process runs, and stands if not", async () => {
    const host = await discovered(["search"]);

    await host.scriptEngine(keyOf("local"), [notRunning(), found(["search", "more"])]);
    await host.advance(11 * MINUTE);
    await restart(host);
    await settled(host);

    // Asked without starting the Container, which was stopped: the state and the inventory stand, and nothing failed.
    expect(await starts(host)).toEqual([true, false]);

    const [server] = (await host.servers({ parts: ["status", "tools"] })).servers;

    expect(server).toMatchObject({ state: "connected", counts: { tools: 1 } });
    expect(server?.status?.failures).toBe(0);
    expect(server?.error).toBeUndefined();
    expect(await host.endedProcesses()).toEqual([]);

    // Held back a minute, then asked again; this time the process runs, and the refresh lands.
    await restart(host);
    await settled(host);
    expect(await starts(host)).toEqual([true, false]);
    await host.advance(61_000);
    await restart(host);
    await settled(host);
    expect(await starts(host)).toEqual([true, false, false]);
    expect((await host.servers({ parts: [] })).servers[0]).toMatchObject({
      state: "connected",
      counts: { tools: 2 },
    });
  });

  it("never starts a Container for an unavailable server that has an inventory, nor counts the stop as a failure", async () => {
    const host = await discovered(["search"]);

    await host.scriptEngine(keyOf("local"), [
      failedWith({ _tag: "Unreachable", message: "down", status: 502 }),
      notRunning(),
    ]);
    await host.advance(11 * MINUTE);
    await restart(host);
    await settled(host);
    expect(await stateOf(host, "local")).toBe("unavailable");

    // After its backoff: asked again without starting the Container.
    await host.advance(31_000);
    await restart(host);
    await settled(host);

    expect(await starts(host)).toEqual([true, false, false]);

    const [server] = (await host.servers({ parts: ["status"] })).servers;

    expect(server).toMatchObject({ state: "unavailable", counts: { tools: 1 } });
    expect(server?.status?.failures).toBe(1);
  });

  it("counts a refusal that is not the Container's stop (a bridge that does not answer) as a failure of the refresh, the inventory kept", async () => {
    const host = await discovered(["search"]);

    await host.scriptEngine(keyOf("local"), [
      failedWith({ _tag: "Unreachable", message: "The Container's MCP bridge does not answer" }),
    ]);
    await host.advance(11 * MINUTE);
    await restart(host);
    await settled(host);

    const [server] = (await host.servers({ parts: ["status", "tools"] })).servers;

    expect(server).toMatchObject({ state: "unavailable", counts: { tools: 1 } });
    expect(server?.status?.failures).toBe(1);
  });

  it("tells #478's seam when the refresh finds its Workspace gone, and a first discovery too", async () => {
    const host = freshHost();
    const gone = { _tag: "Unreachable", message: "The Workspace no longer exists", status: 404 };

    await host.apply(setOf(entry("local")));
    await host.scriptEngine(keyOf("local"), [
      failedWith(gone),
      found(["search"]),
      failedWith(gone),
    ]);
    await start(host, WORKSPACE, { waitFor: ["local"], waitMs: 5000 });
    await settled(host);
    expect(await host.endedProcesses()).toEqual([
      { conn: "conn-local", workspace: WORKSPACE, spawn: undefined },
    ]);

    await host.advance(31_000);
    await restart(host);
    await settled(host);
    await host.advance(11 * MINUTE);
    await restart(host);
    await settled(host);

    expect(await host.endedProcesses()).toHaveLength(2);
    expect(await stateOf(host, "local")).toBe("connected");
  });
});

describe("discoveries per Workspace", () => {
  it("runs at most 2 stdio discoveries at once in a Workspace: the third waits for a slot of its Workspace", async () => {
    const host = freshHost();
    const names = ["a", "b", "c"];

    await host.apply(setOf(...names.map((name) => entry(name))));

    for (const name of names) {
      await host.scriptEngine(keyOf(name), [{ ...found(["search"]), hold: true }]);
    }

    await start(host, WORKSPACE);
    await vi.waitFor(async () => expect(await host.engineCalls()).toHaveLength(2));
    await pause();
    expect(await host.engineCalls()).toHaveLength(2);

    await host.release(keyOf("a"));
    await host.release(keyOf("b"));
    await vi.waitFor(async () => expect(await host.engineCalls()).toHaveLength(3));
    await host.release(keyOf("c"));
    await settled(host);

    expect(await stateOf(host, "c")).toBe("connected");
  });
});

describe("a reload", () => {
  it("keeps a connected stdio server's tools, expired, starts nothing, and the next demand refreshes them where the process runs", async () => {
    const host = await discovered(["search"]);
    const before = (await host.engineCalls()).length;

    await host.apply(JSON.parse('{"kind":"reload"}'));
    await settled(host);

    expect(await host.engineCalls()).toHaveLength(before);
    expect(await host.sessionRows("conn-local")).toEqual([]);

    // Still listed, and still built calls' tools: the reload took nothing away.
    const [server] = (await host.servers({ parts: ["tools"] })).servers;

    expect(server).toMatchObject({ state: "connected", counts: { tools: 1 } });

    await host.scriptRequest(keyOf("local"), [completed("found")]);
    expect(await host.request(call("local", "search"), {})).toMatchObject({ _tag: "Completed" });

    // The next live request refreshes it without starting the Container, and the new tools land.
    await host.scriptEngine(keyOf("local"), [found(["search", "next"])]);
    await restart(host);
    await settled(host);

    expect(await starts(host)).toEqual([true, false]);
    expect((await host.servers({ parts: [] })).servers[0]).toMatchObject({
      state: "connected",
      counts: { tools: 2 },
    });
  });

  it("leaves the tools served when the Container is stopped at that refresh: a quiet skip, no failure", async () => {
    const host = await discovered(["search"]);

    await host.apply(JSON.parse('{"kind":"reload"}'));
    await host.scriptEngine(keyOf("local"), [notRunning()]);
    await restart(host);
    await settled(host);

    const [server] = (await host.servers({ parts: ["status", "tools"] })).servers;

    expect(await starts(host)).toEqual([true, false]);
    expect(server).toMatchObject({ state: "connected", counts: { tools: 1 } });
    expect(server?.status?.failures).toBe(0);
  });

  it("clears the hold and the failures of a failed server that has an inventory, and keeps it", async () => {
    const host = await discovered(["search"]);

    await host.scriptEngine(keyOf("local"), [
      failedWith({ _tag: "ProtocolViolation", message: "not MCP" }),
    ]);
    await host.advance(11 * MINUTE);
    await restart(host);
    await settled(host);
    expect(await stateOf(host, "local")).toBe("failed");

    await host.apply(JSON.parse('{"kind":"reload","servers":["local"]}'));

    const [server] = (await host.servers({ parts: ["status", "tools"] })).servers;

    expect(server).toMatchObject({ state: "failed", counts: { tools: 1 } });
    expect(server?.status?.failures).toBe(0);
    expect(server?.status?.nextRetryAt).toBeUndefined();
  });

  it("puts a failed server with no inventory back to never discovered, and no demand from no Workspace discovers it", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("local")));
    await host.scriptEngine(keyOf("local"), [
      failedWith({ _tag: "ProtocolViolation", message: "not MCP" }),
      found(["search"]),
    ]);
    await start(host, WORKSPACE, { waitFor: ["local"], waitMs: 5000 });
    await settled(host);
    expect(await stateOf(host, "local")).toBe("failed");

    await host.apply(JSON.parse('{"kind":"reload","servers":["local"]}'));
    expect(await stateOf(host, "local", "")).toBe("not_discovered");
    expect(await host.engineCalls()).toHaveLength(1);

    // At once, not a minute after its failure: the reload cleared it.
    await start(host, WORKSPACE, { waitFor: ["local"], waitMs: 5000 });
    await settled(host);
    expect(await stateOf(host, "local")).toBe("connected");
    expect(await starts(host)).toEqual([true, true]);
  });
});

describe("a call", () => {
  it("goes to the engine as a stdio target in the caller's Workspace, with that Workspace's rows", async () => {
    const host = await discovered(["search"]);

    await host.scriptRequest(keyOf("local"), [completed("found", { spawn: "spawn-1" })]);

    expect(await host.request(call("local", "search"), {})).toMatchObject({ _tag: "Completed" });

    const [sent] = await host.engineRequests();

    expect(sent?.target).toMatchObject({
      kind: "stdio",
      conn: "conn-local",
      workspace: WORKSPACE,
      start: true,
    });
    expect(sent?.request).toMatchObject({ ctx: { workspace: WORKSPACE } });
  });

  it("is never offered an MCP task, and a task request for it is unsupported until #494, sending nothing", async () => {
    const host = await discovered(["search"]);

    await host.scriptRequest(keyOf("local"), [completed("found")]);

    const offered = call("local", "search");

    await host.request({ ...offered, ctx: { ...offered.ctx, allowTask: true } }, {});

    expect((await host.engineRequests())[0]?.request.ctx).not.toHaveProperty("allowTask");

    const asked = await host.request(
      {
        op: "tasks/get",
        server: "local",
        params: { taskId: "task-1", tool: "search", conn: "conn-local" },
        ctx: offered.ctx,
      },
      {},
    );

    expect(asked).toMatchObject({ _tag: "HostUnsupported", op: "tasks/get" });
    expect(await host.engineRequests()).toHaveLength(1);
  });

  it("is refused when it names no Workspace: a stdio server runs in the caller's", async () => {
    const host = await discovered(["search"]);

    expect(await host.request(call("local", "search", ""), {})).toMatchObject({
      _tag: "NotAllowed",
    });
    expect(await host.engineRequests()).toEqual([]);
  });

  it("keeps the spawn id with the Workspace's row, and the rows of two Workspaces apart", async () => {
    const host = await discovered(["search"]);
    const session = { v: 1, sessionId: "session-1" };

    await host.scriptRequest(keyOf("local"), [
      completed("a", { spawn: "spawn-1", state: { session } }),
      completed("b", { spawn: "spawn-9", state: { session: { v: 1, sessionId: "session-9" } } }),
    ]);
    await host.request(call("local", "search"), {});
    await host.request(call("local", "search", ELSEWHERE), {});

    expect(await host.sessionRows("conn-local")).toEqual([
      { workspace: WORKSPACE, spawn: "spawn-1" },
      { workspace: ELSEWHERE, spawn: "spawn-9" },
    ]);
    expect(await host.prior("conn-local", WORKSPACE)).toMatchObject({ session });
    expect(await host.prior("conn-local", ELSEWHERE)).toMatchObject({
      session: { sessionId: "session-9" },
    });
    // An HTTP server's row is the one with no Workspace: a stdio server's is never read as it.
    expect(await host.prior("conn-local")).not.toHaveProperty("session");
  });

  it("keeps a spawn id of a Modern server, which has no session, without passing it as a row", async () => {
    const host = await discovered(["search"]);

    await host.scriptRequest(keyOf("local"), [completed("a", { spawn: "spawn-3" })]);
    await host.request(call("local", "search"), {});

    expect(await host.sessionRows("conn-local")).toEqual([
      { workspace: WORKSPACE, spawn: "spawn-3" },
    ]);
    expect(await host.prior("conn-local", WORKSPACE)).not.toHaveProperty("session");
  });

  it("reads a Workspace that is gone from the call's own answer", async () => {
    const host = await discovered(["search"]);

    await host.scriptRequest(keyOf("local"), [
      {
        // SAFETY: a failure as it crosses the edge, encoded.
        result: {
          kind: "failed",
          error: { _tag: "Unreachable", message: "The Workspace no longer exists", status: 404 },
          state: {},
        } as typeof McpEngineRequestResult.Encoded,
      },
    ]);

    expect(await host.request(call("local", "search"), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Unreachable", status: 404 },
    });
  });

  it("forgets the rows of a Workspace unused for 7 days at the next call in any", async () => {
    const host = await discovered(["search"]);

    await host.scriptRequest(keyOf("local"), [
      completed("a", { spawn: "spawn-1" }),
      completed("b", { spawn: "spawn-2" }),
    ]);
    await host.request(call("local", "search", ELSEWHERE), {});
    await host.advance(8 * 24 * 60 * MINUTE);
    await host.request(call("local", "search"), {});

    expect(await host.sessionRows("conn-local")).toEqual([
      { workspace: WORKSPACE, spawn: "spawn-2" },
    ]);
  });
});
