// A resource read that never starts a Container (`docs/architecture/mcp-in-a-session.md` → Resource links and embedded
// resources; `docs/architecture/mcp-connections.md` → The stdio bridge): `ctx.start: false`, which the owner's preview sends,
// reaches the engine as a stdio target that may not start the Container, and a Container that is not running is answered
// `Unreachable` with `stopped`, as the bridge's `stopped` refusal is. A read without it is a call's: it may start the
// Container, as every call has. The host lists `no_start` so a Session can tell a host that takes the key from one that
// would drop it.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalTimers:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import {
  MCP_HOST_FEATURES,
  type McpApplySet,
  type McpEngineDiscoverResult,
  type McpEngineRequestResult,
  type McpHostResourceRequest,
  type McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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

const WORKSPACE = "ws:aaaa1111";

const KEY = "stdio:local";

const entry: McpSetEntry = {
  name: "local",
  source: { kind: "global" },
  server: { type: "stdio", command: "docs-server", args: [], env: {} },
  hash: "hash-local",
  conn: "conn-local",
  identity: "identity-local",
};

const set: McpApplySet = { kind: "set", hash: "h", revision: 1, entries: [entry] };

const found: EngineScript = {
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

const read: RequestScript = {
  op: "resources/read",
  // SAFETY: a completed read, encoded as the engine sends it.
  result: {
    kind: "complete",
    result: { kind: "inline", value: { contents: [{ uri: "file:///a.md", text: "# A" }] } },
    cacheable: false,
    fetchedAt: Date.now(),
    state: {},
  } as typeof McpEngineRequestResult.Encoded,
};

const stopped: RequestScript = {
  op: "resources/read",
  // SAFETY: a failure as it crosses the edge; the host decodes it.
  result: {
    kind: "failed",
    error: { _tag: "Unreachable", message: "The Workspace's Container is stopped", stopped: true },
    state: {},
  } as typeof McpEngineRequestResult.Encoded,
};

/** A host whose stdio server `local` was discovered in `WORKSPACE`. */
const hostWithLocal = async () => {
  const host = env.MCP_HOSTS.getByName(`mcp:preview${counter++}`);

  await host.apply(set);
  await host.scriptEngine(KEY, [found]);
  await host.requestStart({
    caller: { session: "s-1", conversation: "1", workspace: WORKSPACE },
    waitFor: ["local"],
    waitMs: 5000,
  });
  await host.servers({ parts: [], waitMs: 10_000 });

  return host;
};

const readOf = (
  more: { readonly start?: boolean } = {},
): typeof McpHostResourceRequest.Encoded => ({
  op: "resources/read",
  server: "local",
  params: { uri: "file:///a.md" },
  ctx: { origin: "owner", session: "s-1", conversation: "1", workspace: WORKSPACE, ...more },
});

/** The `start` of the target of each engine request, in order. */
const starts = async (host: Awaited<ReturnType<typeof hostWithLocal>>) =>
  (await host.engineRequests()).map((each) =>
    each.target.kind === "stdio" ? each.target.start : null,
  );

describe("a read that may not start the Container", () => {
  it("lists the feature that says the host takes `ctx.start`", () => {
    expect(MCP_HOST_FEATURES).toContain("no_start");
  });

  it("is sent to a stdio server as a target that may not start the Container, and reads it where it runs", async () => {
    const host = await hostWithLocal();

    await host.scriptRequest(KEY, [read]);

    const answer = await host.request(readOf({ start: false }), {});

    expect(answer).toMatchObject({
      _tag: "Completed",
      result: { kind: "inline", value: { contents: [{ uri: "file:///a.md", text: "# A" }] } },
    });
    expect(await starts(host)).toEqual([false]);
  });

  it("is answered as stopped when the Container is not running, and starts nothing", async () => {
    const host = await hostWithLocal();

    await host.scriptRequest(KEY, [stopped]);

    expect(await host.request(readOf({ start: false }), {})).toMatchObject({
      _tag: "CallFailed",
      error: { _tag: "Unreachable", stopped: true },
    });
    expect(await starts(host)).toEqual([false]);
  });

  it("is a call's, which may start the Container, without `start: false`", async () => {
    const host = await hostWithLocal();

    await host.scriptRequest(KEY, [read]);
    await host.request(readOf(), {});

    expect(await starts(host)).toEqual([true]);
  });

  it("is refused for a stdio server when the read names no Workspace: there is no Container to read in", async () => {
    const host = await hostWithLocal();

    expect(
      await host.request(
        { ...readOf({ start: false }), ctx: { origin: "owner", start: false } },
        {},
      ),
    ).toMatchObject({ _tag: "NotAllowed" });
    expect(await host.engineRequests()).toEqual([]);
  });
});
