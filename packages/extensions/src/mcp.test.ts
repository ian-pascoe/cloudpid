// The `mcp` extension through real runs (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension, Exposure): a
// scripted model on a Harness with `tool_search`, whose MCP tools `McpTools` builds from an in-memory host at each
// request start.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off
import { HostFailed, McpHostCompleted, type McpProgress } from "@cloudpid/mcp/types";
import { type Extension, LiveDoc } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import { type McpRequestStartInput, makeMcpTools } from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { answer, call, context, openSubagentHarness } from "./subagents/harness.fixture.ts";
import { fixedToolSearchSettings, reloadToolSearch, ToolSearch } from "./tool-search.ts";

/** A server whose four tools each have one Exposure, and one only an MCP App sees. */
const DOCS: FakeMcpServer = {
  name: "Docs-Site",
  description: "The product docs",
  instructions: "Search before fetching.",
  exposure: "codemode",
  toolExposure: { search: "direct", fetchPage: "deferred", secret: "hidden" },
  tools: [
    { name: "search", description: "Search the docs" },
    { name: "fetchPage", description: "Fetch one page of the docs" },
    { name: "secret", description: "Never offered" },
    { name: "summarize", description: "Summarize a page of the docs" },
    { name: "widget", description: "An App's own tool", _meta: { ui: { visibility: ["app"] } } },
  ],
};

/** A request start for the root conversation, with `servers` servers and the offered tools. */
const startOf = (
  servers: number,
  offered: ReadonlyArray<string> = [],
  ready: Effect.Effect<void> = Effect.void,
): McpRequestStartInput => ({
  caller: { session: "s1", conversation: "0", workspace: "ws:w1" },
  servers,
  offered,
  ready,
});

/** The deferred tools the latest request's prompt names. */
const deferredIn = (system: string | undefined) =>
  system?.split("<deferred_tools>").at(-1)?.split("</deferred_tools>")[0] ?? "";

/** A Harness with `tool_search` and an `mcp` extension the test installs again, as the Session does. */
const open = async (script: Parameters<typeof openSubagentHarness>[0]) => {
  const session = await openSubagentHarness(script, {}, [
    await Effect.runPromise(ToolSearch(["read"]).pipe(Effect.provide(fixedToolSearchSettings([])))),
  ]);

  /** Install `mcp`, then `tool-search` over every installed extension, as the Session's reinstall does. */
  const install = (mcp: Extension, offered: ReadonlyArray<string> = []) => {
    session.registry.install(mcp);
    session.registry.install(
      reloadToolSearch(session.registry.snapshot().installed(), { offered }),
    );
  };

  return { ...session, install };
};

describe("Exposure", () => {
  it("offers direct tools, defers deferred ones, keeps codemode ones from tool_search, and registers no hidden one", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    const session = await open((request) => {
      if (request.text === "load") return call(["tool_search", { query: "docs page" }]);

      return answer("ok");
    });

    const built = await Effect.runPromise(tools.requestStart(startOf(1)));

    session.install(Option.getOrThrow(built));

    await session.prompt("hello");

    const [first] = session.requests;

    expect(first?.tools).toContain("mcp__docs_site__search");
    expect(first?.tools).not.toContain("mcp__docs_site__fetch_page");
    expect(first?.tools).not.toContain("mcp__docs_site__summarize");

    const registered = session.registry.snapshot().extension("mcp")?.tools ?? [];

    expect(
      registered.map((tool) => [tool.name, tool.deferred ?? false, tool.callers ?? "all"]),
    ).toEqual([
      ["mcp__docs_site__search", false, "all"],
      ["mcp__docs_site__fetch_page", true, "all"],
      ["mcp__docs_site__summarize", true, ["tools"]],
    ]);

    // `deferred_tools` names no MCP tool: their family by the first `_` would lump every server together.
    expect(deferredIn(first?.system)).not.toContain("mcp__");

    // `tool_search` loads the deferred tool, never the codemode one, which matches the query as well.
    await session.prompt("load");

    const last = session.requests.at(-1);

    expect(last?.tools).toContain("mcp__docs_site__fetch_page");
    expect(last?.tools).not.toContain("mcp__docs_site__summarize");
  });

  it("lifts a codemode tool to direct when tools.offered names it", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    const built = Option.getOrThrow(
      await Effect.runPromise(tools.requestStart(startOf(1, ["mcp__docs_site__summarize"]))),
    );

    const summarize = built.tools?.find((tool) => tool.name === "mcp__docs_site__summarize");

    expect(summarize?.deferred).toBeUndefined();
    expect(summarize?.callers).toBeUndefined();
  });
});

describe("a request start", () => {
  it("makes no host call for an Environment with no MCP servers", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    expect(Option.isNone(await Effect.runPromise(tools.requestStart(startOf(0))))).toBe(true);
    expect(host.calls).toEqual([]);
  });

  it("awaits the Workspace call before any host call", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);
    const order: Array<string> = [];

    await Effect.runPromise(
      tools.requestStart(
        startOf(
          1,
          [],
          Effect.sync(() => {
            order.push(`ready after ${host.calls.length} host calls`);
          }),
        ),
      ),
    );

    expect(order).toEqual(["ready after 0 host calls"]);
  });

  it("waits only at the first, for servers with no inventory whose tools may be direct, and opens the window once", async () => {
    const host = fakeMcpHost([
      DOCS,
      { name: "pending", state: "connecting", tools: [], exposure: "direct" },
      { name: "quiet", state: "connecting", tools: [] },
    ]);

    const tools = makeMcpTools(host.client);

    await Effect.runPromise(tools.requestStart(startOf(3)));
    await Effect.runPromise(tools.requestStart(startOf(3)));

    const starts = host.calls.flatMap((each) =>
      each.method === "requestStart" ? [each.input] : [],
    );

    expect(starts[0]).toMatchObject({ windowOpened: true, waitFor: ["pending"], waitMs: 10_000 });
    expect(starts[0]?.known).toBeUndefined();
    expect(starts[1]?.windowOpened).toBeUndefined();
    expect(starts[1]?.waitFor).toBeUndefined();
    expect(starts[1]?.known).toBeTypeOf("string");
  });

  it("builds again only when the version, the offered tools or the features change, byte-identical over unchanged tools", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);
    const again = makeMcpTools(host.client);

    const first = Option.getOrThrow(await Effect.runPromise(tools.requestStart(startOf(1))));

    // Unchanged: nothing to install.
    expect(Option.isNone(await Effect.runPromise(tools.requestStart(startOf(1))))).toBe(true);

    // Another runtime building over the same inventory declares the very same tools.
    const rebuilt = Option.getOrThrow(await Effect.runPromise(again.requestStart(startOf(1))));

    const declared = (extension: Extension) =>
      JSON.stringify(
        (extension.tools ?? []).map(({ name, description, parameters, deferred, callers }) => ({
          name,
          description,
          parameters,
          deferred,
          callers,
        })),
      );

    expect(declared(rebuilt)).toBe(declared(first));

    // `codemode` is installed again with the servers as its namespaces.
    expect(again.namespaces()).toEqual([
      {
        name: "mcp__docs_site",
        prefix: "mcp__docs_site",
        description: "The product docs",
        instructions: "Search before fetching.",
      },
    ]);

    // The offered tools changed: built again.
    expect(Option.isSome(await Effect.runPromise(tools.requestStart(startOf(1, ["mcp__*"]))))).toBe(
      true,
    );

    // The inventory changed: built again, with the new tool.
    host.set([{ ...DOCS, tools: [...DOCS.tools, { name: "index" }] }]);

    const grown = Option.getOrThrow(
      await Effect.runPromise(tools.requestStart(startOf(1, ["mcp__*"]))),
    );

    expect(grown.tools?.map((tool) => tool.name)).toContain("mcp__docs_site__index");
  });

  it("offers no MCP tools from an older host without the features they use, and keeps them through a host failure", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    const built = Option.getOrThrow(await Effect.runPromise(tools.requestStart(startOf(1))));

    expect(built.tools?.length).toBe(3);

    host.fail(true);
    expect(Option.isNone(await Effect.runPromise(tools.requestStart(startOf(1))))).toBe(true);

    host.fail(false);
    host.features(["inventory"]);

    const older = Option.getOrThrow(await Effect.runPromise(tools.requestStart(startOf(1))));

    expect(older.tools).toEqual([]);
  });
});

describe("a call", () => {
  it("sends the call with its Session and Workspace, and gives the model the text", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    const session = await open((request) =>
      request.text === "search"
        ? call(["mcp__docs_site__search", { query: "effect" }])
        : answer("ok"),
    );

    session.install(Option.getOrThrow(await Effect.runPromise(tools.requestStart(startOf(1)))));

    await session.prompt("search");

    const sent = host.calls.flatMap((each) => (each.method === "request" ? [each.input] : []));

    expect(sent).toEqual([
      {
        op: "tools/call",
        server: "Docs-Site",
        params: { name: "search", arguments: { query: "effect" } },
        ctx: expect.objectContaining({
          origin: "agent",
          conversation: "1",
          session: "s1",
          workspace: "ws:w1",
        }),
      },
    ]);
    expect(await session.texts("toolResult")).toEqual(['search {"query":"effect"}']);
  });

  it("puts progress in the running call's details, and Stop resolves untilAborted", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);
    const progressed = Promise.withResolvers<void>();
    let aborted = false;

    host.answer(async (_input, hooks) => {
      await hooks.onProgress?.({ progress: 1, total: 2, message: "half" } satisfies McpProgress);
      progressed.resolve();
      await hooks.untilAborted?.();
      aborted = true;

      return HostFailed.make({ message: "cancelled" });
    });

    const session = await open((request) =>
      request.text === "search" ? call(["mcp__docs_site__search", {}]) : answer("ok"),
    );

    session.install(Option.getOrThrow(await Effect.runPromise(tools.requestStart(startOf(1)))));

    const submitted = await session.root.submit({ type: "input", content: "search" }, context);

    await progressed.promise;

    const live = await session.harness.snapshot(LiveDoc, session.root.id, context);

    expect(live?.tools?.[0]?.details).toMatchObject({
      progress: { progress: 1, total: 2, message: "half" },
    });

    await session.root.abort(context);
    await submitted.wait(context);

    expect(aborted).toBe(true);
  });

  it("reads a completed result's structuredContent as JSON when it has no content, and an error as an error", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);
    let next = 0;

    host.answer(async () =>
      McpHostCompleted.make({
        result: {
          kind: "inline",
          value:
            next++ === 0
              ? { content: [], structuredContent: { count: 2 } }
              : { content: [{ type: "text", text: "no such page" }], isError: true },
        },
      }),
    );

    const session = await open((request) =>
      request.text === "twice"
        ? call(["mcp__docs_site__search", {}], ["mcp__docs_site__search", {}])
        : answer("ok"),
    );

    session.install(Option.getOrThrow(await Effect.runPromise(tools.requestStart(startOf(1)))));

    await session.prompt("twice");

    const results = (await session.entries()).flatMap((entry) =>
      (entry.model ?? []).flatMap((message) =>
        message.role === "toolResult" ? [[message.isError, message.content]] : [],
      ),
    );

    expect(results).toEqual([
      [false, [{ type: "text", text: '{"count":2}' }]],
      [true, [{ type: "text", text: "no such page" }]],
    ]);
  });
});
