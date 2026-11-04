// An App View's request in `McpHost` (`docs/architecture/mcp-apps.md` → An App View's calls): the host's own checks, made
// again after the Session's. A `tools/call` or `resources/read` of origin `app` is sent only to a server that is not
// switched off or `hidden`, for a tool whose `_meta.ui.visibility` includes `app`, and only while the server is the one the
// call's record names (`ctx.viewHash`); what reaches the engine declares nothing a server could answer with a request of
// its own. Over real Durable Object SQLite and a scripted engine.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off globalTimers:off newPromise:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpHostRequestInput,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import { viewHash } from "../view-hash.ts";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { EngineScript, TestMcpHost } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

let counter = 0;

/** Named as the main Worker names one; `environment` is the id it is for. */
const freshHost = () => {
  const environment = `view${counter++}`;

  return { environment, host: env.MCP_HOSTS.getByName(`mcp:${environment}`) };
};

const urlOf = (name: string) => `https://${name}.example/mcp`;

const entry = (name: string, server: Readonly<Record<string, Schema.Json>> = {}): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: urlOf(name), headers: {}, ...server },
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

/** A tool for both, one only an App sees, one only the model sees, and one that says nothing of it. */
const TOOLS = [
  {
    name: "both",
    inputSchema: { type: "object" },
    _meta: { ui: { visibility: ["model", "app"] } },
  },
  { name: "refresh", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
  { name: "private", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["model"] } } },
  { name: "plain", inputSchema: { type: "object" } },
] as const;

const found = (): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {}, resources: {} },
    tools: TOOLS,
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: { era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 } },
  } as typeof McpEngineDiscoverResult.Encoded,
});

const completed: typeof McpEngineRequestResult.Encoded = {
  kind: "complete",
  result: { kind: "inline", value: { content: [{ type: "text", text: "ok" }] } },
  cacheable: true,
  fetchedAt: Date.now(),
  state: {},
};

/** A host whose set is `entries`, each discovered with `TOOLS`. */
const discovered = async (...entries: ReadonlyArray<McpSetEntry>) => {
  const { host, environment } = freshHost();

  await host.apply(setOf(...entries));

  for (const each of entries) await host.scriptEngine(urlOf(each.name), [found()]);

  await host.requestStart({
    caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
    waitFor: entries.map((each) => each.name),
    waitMs: 5000,
  });

  return Object.assign(host, { environment });
};

const CTX = {
  origin: "app",
  callId: "call-1",
  session: "s-1",
  conversation: "1",
  workspace: "ws:w-1",
} as const;

const toolCall = (
  server: string,
  tool: string,
  ctx: { readonly origin?: "app" | "agent"; readonly viewHash?: string } = {},
): typeof McpHostRequestInput.Encoded => ({
  op: "tools/call",
  server,
  params: { name: tool, arguments: { q: "x" } },
  ctx: { ...CTX, ...ctx },
});

const readOf = (server: string): typeof McpHostRequestInput.Encoded => ({
  op: "resources/read",
  server,
  params: { uri: "ui://docs/page" },
  ctx: CTX,
});

const tagOf = async (
  host: Awaited<ReturnType<typeof discovered>>,
  input: typeof McpHostRequestInput.Encoded,
) => (await host.request(input, {}))._tag;

describe("an App View's request to the host", () => {
  it("sends a tool whose visibility includes app, as the App's own request that asks for no task and no question", async () => {
    const host = await discovered(entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      { result: completed },
      { result: completed },
      { result: completed },
    ]);

    for (const tool of ["both", "refresh", "plain"]) {
      expect(await tagOf(host, toolCall("docs", tool))).toBe("Completed");
    }

    const sent = await host.engineRequests();

    expect(sent).toHaveLength(3);

    for (const each of sent) {
      expect(each.request.ctx).toEqual({ origin: "app", conversation: "1", workspace: "ws:w-1" });
    }
  });

  it("refuses a tool only the model sees, sending nothing", async () => {
    const host = await discovered(entry("docs"));

    expect(await host.request(toolCall("docs", "private"), {})).toEqual({
      _tag: "NotAllowed",
      message: "Tool private of MCP server docs is not for App Views",
    });

    expect(await host.engineRequests()).toEqual([]);

    // The same tool is the model's to call: only an App View's request is held to the visibility.
    await host.scriptRequest(urlOf("docs"), [{ result: completed }]);
    expect(await tagOf(host, toolCall("docs", "private", { origin: "agent" }))).toBe("Completed");
  });

  it("refuses a server that is hidden or switched off, a tool and a read alike, and one that is unknown", async () => {
    const host = await discovered(
      entry("docs"),
      entry("shy", { exposure: "hidden" }),
      entry("off", { enabled: false }),
    );

    for (const server of ["shy", "off"]) {
      expect(await tagOf(host, toolCall(server, "both"))).toBe("NotAllowed");
      expect(await tagOf(host, readOf(server))).toBe("NotAllowed");
    }

    expect(await tagOf(host, toolCall("nowhere", "both"))).toBe("UnknownServer");
    expect(await tagOf(host, toolCall("docs", "missing"))).toBe("NotAllowed");
    expect(await host.engineRequests()).toEqual([]);
  });

  it("sends a request that names the origin of the server it is for, and no other", async () => {
    const host = await discovered(entry("docs"));

    const named = viewHash({
      environment: host.environment,
      source: "owner",
      normalizedName: "docs",
    });

    await host.scriptRequest(urlOf("docs"), [{ result: completed }]);
    expect(await tagOf(host, toolCall("docs", "both", { viewHash: named }))).toBe("Completed");
  });

  it("is ServerChanged, sending nothing, for a server that is not the one the record names", async () => {
    const host = await discovered(entry("docs"));

    // What a call's `Completed.app.viewHash` is for the server `docs` of this host: the record's pin.
    await host.scriptRequest(urlOf("docs"), [{ result: completed }]);

    const asked = await host.request(
      toolCall("docs", "both", { viewHash: "zzzzzzzzzzzzzzzzzzzzzzzzzz" }),
      {},
    );

    expect(asked).toMatchObject({ _tag: "ServerChanged", conn: "conn-docs" });
    expect(
      await tagOf(host, {
        ...readOf("docs"),
        ctx: { ...CTX, viewHash: "zzzzzzzzzzzzzzzzzzzzzzzzzz" },
      }),
    ).toBe("ServerChanged");

    expect(await host.engineRequests()).toEqual([]);
  });
});
