// The `mcp` extension through real runs (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension, Exposure, Calls
// and results): a scripted model on a Harness with `tool_search` and `codemode`, whose MCP tools `McpTools` builds from
// an in-memory host at each request start and installs as the Session does.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off
import { HostFailed, McpHostCompleted, type McpProgress } from "@cloudpid/mcp/types";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { type Extension, LiveDoc } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { HostLost, type McpHostClientService, makeMcpTools, memoryMcpToolsStore } from "./mcp.ts";
import {
  build,
  codemodeWith,
  DOCS,
  deferredIn,
  detailsOf,
  ISSUES,
  open,
  results,
  startOf,
} from "./mcp.fixture.ts";
import { fakeMcpHost } from "./mcp.testing.ts";
import { mcpServersIntro } from "./mcp/servers.ts";
import {
  answer,
  call,
  context,
  fakeSubagentWorkspaces,
  openSubagentHarness,
} from "./subagents/harness.fixture.ts";
import { fixedToolSearchSettings, ToolSearch } from "./tool-search.ts";

describe("Exposure", () => {
  it("offers direct tools, defers deferred ones, keeps codemode ones from tool_search, and registers no hidden one", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    const session = await open((request) => {
      if (request.text === "load") return call(["tool_search", { query: "docs page" }]);

      return answer("ok");
    });

    await session.start(tools);
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
      await build(tools, startOf(1, { offered: ["mcp__docs_site__summarize"] })),
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

    expect(Option.isNone(await build(tools, startOf(0)))).toBe(true);
    expect(host.calls).toEqual([]);
  });

  it("awaits the Workspace call before any host call, and calls nothing when it did not answer", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);
    const order: Array<string> = [];

    const ready = (answered: boolean) =>
      Effect.sync(() => {
        order.push(`ready after ${host.calls.length} host calls`);

        return answered;
      });

    const built = Option.getOrThrow(await build(tools, startOf(1, { ready: ready(true) })));

    expect(order).toEqual(["ready after 0 host calls"]);

    const before = host.calls.length;

    host.set([{ ...DOCS, tools: [...DOCS.tools, { name: "index" }] }]);

    // The Workspace did not answer: no host call, and the tools stay as they were built.
    expect(Option.isNone(await build(tools, startOf(1, { ready: ready(false) })))).toBe(true);
    expect(host.calls.length).toBe(before);
    expect(built.tools?.length).toBe(3);
  });

  it("waits only at the first, for servers with no inventory whose tools may be direct", async () => {
    const host = fakeMcpHost([
      DOCS,
      { name: "pending", state: "connecting", tools: [], exposure: "direct" },
      { name: "quiet", state: "connecting", tools: [] },
    ]);

    const tools = makeMcpTools(host.client);

    await build(tools, startOf(3));
    await build(tools, startOf(3));

    const starts = host.calls.flatMap((each) =>
      each.method === "requestStart" ? [each.input] : [],
    );

    expect(starts[0]).toMatchObject({ waitFor: ["pending"], waitMs: 10_000 });
    expect(starts[0]?.known).toBeUndefined();
    expect(starts[1]?.waitFor).toBeUndefined();
    expect(starts[1]?.known).toBeTypeOf("string");
  });

  it("opens the window once per Context Window, whatever restarts come between", async () => {
    const host = fakeMcpHost([DOCS]);
    const store = memoryMcpToolsStore();
    const tools = makeMcpTools(host.client, store);

    await build(tools, startOf(1));
    await build(tools, startOf(1));
    // A compaction or a Rollover started a new window.
    await build(tools, startOf(1, { window: "42" }));
    await build(tools, startOf(1, { window: "42" }));
    // Another conversation's first.
    await build(
      tools,
      startOf(1, { caller: { session: "s1", conversation: "7", workspace: "ws:w1" } }),
    );
    // The object started again, over what it kept: the window is still open; a new one opens.
    await build(makeMcpTools(host.client, store), startOf(1, { window: "42" }));
    await build(makeMcpTools(host.client, store), startOf(1, { window: "43" }));

    const opened = host.calls.flatMap((each) =>
      each.method === "requestStart" ? [each.input.windowOpened ?? false] : [],
    );

    expect(opened).toEqual([true, false, true, false, true, false, true]);
  });

  it("builds again only when the version, the offered tools or the features change", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    expect(Option.isSome(await build(tools))).toBe(true);

    // Unchanged: nothing to install.
    expect(Option.isNone(await build(tools))).toBe(true);

    // The offered tools changed: built again.
    expect(Option.isSome(await build(tools, startOf(1, { offered: ["mcp__*"] })))).toBe(true);

    // The inventory changed: built again, with the new tool.
    host.set([{ ...DOCS, tools: [...DOCS.tools, { name: "index" }] }]);

    const grown = Option.getOrThrow(await build(tools, startOf(1, { offered: ["mcp__*"] })));

    expect(grown.tools?.map((tool) => tool.name)).toContain("mcp__docs_site__index");
  });

  it("does not build again for a prompts-only change: the prompts version moves, the version and the tools do not", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    expect(Option.isSome(await build(tools))).toBe(true);

    const versions = async () => {
      const read = await Effect.runPromise(host.client.servers({ parts: ["prompts"] }));

      if (Predicate.isTagged(read, "HostFailed")) throw new Error(read.message);

      return { version: read.version, promptsVersion: read.promptsVersion };
    };

    const before = await versions();

    // The server grew a prompt: its prompts version moves, its inventory version does not.
    host.set([{ ...DOCS, prompts: [{ name: "summarize", description: "Summarize a page" }] }]);

    const after = await versions();

    expect(after.version).toBe(before.version);
    expect(after.promptsVersion).not.toBe(before.promptsVersion);

    // The `mcp` extension is not installed again.
    expect(Option.isNone(await build(tools))).toBe(true);
  });

  it("offers no MCP tools from an older host without the features they use, and keeps them through a host failure", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    const built = Option.getOrThrow(await build(tools));

    expect(built.tools?.length).toBe(3);

    host.fail(true);
    expect(Option.isNone(await build(tools))).toBe(true);

    host.fail(false);
    host.features(["inventory"]);

    const older = Option.getOrThrow(await build(tools));

    expect(older.tools).toEqual([]);
  });

  it("keeps the later read of two in flight, whichever answers last", async () => {
    const host = fakeMcpHost([DOCS]);
    const gates: Array<PromiseWithResolvers<void>> = [];

    // Each `servers` read of the inventory waits for the test to let it answer.
    const client: McpHostClientService = {
      ...host.client,
      servers: (input) =>
        input.parts.length === 0
          ? host.client.servers(input)
          : Effect.promise(() => {
              const gate = Promise.withResolvers<void>();

              gates.push(gate);

              return gate.promise;
            }).pipe(Effect.andThen(host.client.servers(input))),
    };

    const tools = makeMcpTools(client);
    const first = Effect.runPromise(tools.requestStart(startOf(1)));

    await new Promise((resolve) => setTimeout(resolve, 0));
    host.set([{ ...DOCS, tools: [...DOCS.tools, { name: "index" }] }]);

    const second = Effect.runPromise(
      tools.requestStart(
        startOf(1, { caller: { session: "s1", conversation: "7", workspace: "ws:w1" } }),
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    // The later read answers first, then the earlier one, with an older inventory.
    gates[1]?.resolve();
    await second;
    gates[0]?.resolve();
    await first;

    const built = Option.getOrThrow(tools.reinstall([]));

    expect(built.mcp.tools?.map((tool) => tool.name)).toContain("mcp__docs_site__index");
  });

  it("keeps what an unchanged start confirmed over a read sent before it", async () => {
    const host = fakeMcpHost([DOCS]);
    const gate = Promise.withResolvers<void>();
    let gated = false;

    // The next inventory read answers what the host held when it was sent, once the test lets it.
    const client: McpHostClientService = {
      ...host.client,
      servers: (input) =>
        input.parts.length === 0 || !gated
          ? host.client.servers(input)
          : host.client.servers(input).pipe(Effect.tap(() => Effect.promise(() => gate.promise))),
    };

    const tools = makeMcpTools(client);

    await Effect.runPromise(tools.requestStart(startOf(1)));

    // The host moves on, and a start's read of it is in flight; the host moves back before another start.
    gated = true;
    host.set([{ ...DOCS, tools: [...DOCS.tools, { name: "index" }] }]);

    const stale = Effect.runPromise(tools.requestStart(startOf(1)));

    await new Promise((resolve) => setTimeout(resolve, 0));
    gated = false;
    host.set([DOCS]);
    await Effect.runPromise(
      tools.requestStart(
        startOf(1, { caller: { session: "s1", conversation: "7", workspace: "ws:w1" } }),
      ),
    );

    gate.resolve();
    await stale;

    const built = Option.getOrThrow(tools.reinstall([]));

    expect(built.mcp.tools?.map((tool) => tool.name)).not.toContain("mcp__docs_site__index");
  });
});

describe("a server as a codemode namespace", () => {
  it("is named mcp__<server> with the entry's description and the server's instructions, and answers to its - and _ spellings but not the bare name", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);

    const session = await open((request) =>
      request.text === "describe"
        ? call([
            "codemode",
            {
              code: `console.log(JSON.stringify([
                await describeNamespace("mcp__docs_site"),
                await describeNamespace("mcp__docs-site"),
                (await describeNamespace("docs_site")) ?? null,
              ]))`,
            },
          ])
        : answer("ok"),
    );

    // `codemode` is deferred unless offered, as in a Session.
    await session.start(tools, startOf(1, { offered: ["codemode"] }));
    await session.prompt("describe");

    const [result] = await session.texts("toolResult");
    // SAFETY: what the script above printed, JSON.
    const found = JSON.parse(/\[.*\]/s.exec(result ?? "")?.[0] ?? "[]") as ReadonlyArray<unknown>;

    expect(found[0]).toMatchObject({
      name: "mcp__docs_site",
      description: "The product docs",
      instructions: "Search before fetching.",
    });
    expect(found[1]).toEqual(found[0]);
    expect(found[2]).toBeNull();
    // The call the section's intro teaches, `tools.mcp__<server>__<tool>(args)`, is what the namespace declares.
    expect(JSON.stringify(found[0])).toContain("mcp__docs_site__search");
    expect(
      mcpServersIntro({ resourceTools: false, signIn: false, codemodeDeferred: false }),
    ).toContain("tools.mcp__<server>__<tool>(args)");
  });

  it("has none for a server that is not discovered yet", async () => {
    const host = fakeMcpHost([{ ...DOCS, state: "connecting" }]);
    const tools = makeMcpTools(host.client);

    await Effect.runPromise(tools.requestStart(startOf(1)));

    expect(Option.getOrThrow(tools.reinstall([])).namespaces).toEqual([]);
  });
});

describe("a reinstall over unchanged tools", () => {
  it("changes nothing the provider gets: the same tool declarations and no new system prompt section", async () => {
    const host = fakeMcpHost([DOCS, { ...ISSUES, timeout: 30 }]);
    const tools = makeMcpTools(host.client);
    const session = await open(() => answer("ok"));

    expect(Option.isSome(await session.start(tools))).toBe(true);
    await session.prompt("one");

    // Another server's `timeout` changed: the version bumps, and the tools are built and installed again.
    host.set([DOCS, { ...ISSUES, timeout: 90 }]);
    expect(Option.isSome(await session.start(tools))).toBe(true);
    await session.prompt("two");

    const [first, second] = session.requests;

    const sections = (request: typeof first) =>
      request?.messages.filter((message) => message.role === "system").length ?? 0;

    expect(JSON.stringify(getCurrentTools(second?.messages ?? []))).toBe(
      JSON.stringify(getCurrentTools(first?.messages ?? [])),
    );
    // The second request's transcript carries the first's system messages and no new one: the prompt is as it was.
    expect(sections(second)).toBe(sections(first));
    expect(second?.system).toBe(first?.system);
    expect(first?.system).toContain("mcp__docs_site");
  });

  it("from what was kept, in a runtime that starts again, installs the very same tools without asking the host", async () => {
    const host = fakeMcpHost([DOCS]);
    const store = memoryMcpToolsStore();

    const declared = (built: Option.Option<Extension>) =>
      JSON.stringify(
        (Option.getOrThrow(built).tools ?? []).map(
          ({ name, description, parameters, deferred, callers }) => ({
            name,
            description,
            parameters,
            deferred,
            callers,
          }),
        ),
      );

    const before = await build(makeMcpTools(host.client, store));
    const calls = host.calls.length;

    // The host is out of reach, and its inventory moved on: the tools come back from what was kept.
    host.fail(true);

    const again = makeMcpTools(host.client, store).reinstall([]);

    expect(declared(Option.map(again, (built) => built.mcp))).toBe(declared(before));
    expect(Option.map(again, (built) => built.namespaces)).toEqual(
      Option.some([
        {
          name: "mcp__docs_site",
          prefix: "mcp__docs_site",
          description: "The product docs",
          instructions: "Search before fetching.",
        },
      ]),
    );
    expect(host.calls.length).toBe(calls);

    // Nothing kept: nothing to install.
    expect(Option.isNone(makeMcpTools(host.client).reinstall([]))).toBe(true);
  });

  it("keeps only what the build reads, never an entry's literal headers or OAuth secret", async () => {
    const host = fakeMcpHost([
      {
        ...DOCS,
        entry: {
          headers: { Authorization: "Bearer literal-token-123" },
          oauth: { clientId: "client", clientSecret: "literal-secret-456" },
          env: { API_KEY: "literal-key-789" },
        },
      },
    ]);

    const store = memoryMcpToolsStore();

    await build(makeMcpTools(host.client, store));

    const kept = store.load() ?? "";

    expect(kept).toContain("Docs-Site");
    expect(kept).not.toContain("literal-token-123");
    expect(kept).not.toContain("literal-secret-456");
    expect(kept).not.toContain("literal-key-789");
    expect(kept).not.toContain("https://");

    // Text an older build kept with the whole entry is read without it, and written again so.
    const older = JSON.stringify({
      ...JSON.parse(kept),
      servers: [
        {
          ...JSON.parse(kept).servers[0],
          server: { url: "https://x.test", headers: { Authorization: "Bearer literal-token-123" } },
        },
      ],
    });

    store.save(older);
    makeMcpTools(host.client, store);
    expect(store.load()).not.toContain("literal-token-123");

    // Text this build cannot read at all is nothing kept.
    store.save("{not json");
    expect(Option.isNone(makeMcpTools(host.client, store).reinstall([]))).toBe(true);
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

    await session.start(tools);
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

  it("names the Subagent Workspace a conversation works in for a stdio server's call", async () => {
    const host = fakeMcpHost([{ ...DOCS, entry: { type: "stdio", command: "npx" } }]);
    const tools = makeMcpTools(host.client);
    const workspaces = fakeSubagentWorkspaces();

    const session = await openSubagentHarness(
      (request) => {
        if (request.agent === "root") {
          return request.text === "go"
            ? call(["subagent", { task: "Work", workspace: "new" }])
            : answer("ok");
        }

        return request.text.endsWith("Work")
          ? call(["mcp__docs_site__search", { query: "in the child" }])
          : answer("done");
      },
      {},
      [
        await Effect.runPromise(
          ToolSearch(["read"]).pipe(Effect.provide(fixedToolSearchSettings([]))),
        ),
        codemodeWith([]),
      ],
      { workspaces: workspaces.host },
    );

    await Effect.runPromise(tools.requestStart(startOf(1)));
    Option.map(tools.reinstall([]), ({ mcp }) => session.registry.install(mcp));
    await session.prompt("go");
    await session.settle();

    const named = host.calls.flatMap((each) =>
      each.method === "request" && each.input.op === "tools/call"
        ? [[each.input.params.arguments, each.input.ctx.workspace]]
        : [],
    );

    expect(named).toEqual([[{ query: "in the child" }, "ws:00000001"]]);
  });

  it("names the Session's Workspace for an HTTP server's call, whichever Workspace the conversation works in", async () => {
    const host = fakeMcpHost([DOCS]);
    const tools = makeMcpTools(host.client);
    const workspaces = fakeSubagentWorkspaces();

    const session = await openSubagentHarness(
      (request) => {
        if (request.agent === "root") {
          return request.text === "go"
            ? call(["subagent", { task: "Work", workspace: "new" }])
            : answer("ok");
        }

        return request.text.endsWith("Work")
          ? call(["mcp__docs_site__search", { query: "in the child" }])
          : answer("done");
      },
      {},
      [
        await Effect.runPromise(
          ToolSearch(["read"]).pipe(Effect.provide(fixedToolSearchSettings([]))),
        ),
        codemodeWith([]),
      ],
      { workspaces: workspaces.host },
    );

    await Effect.runPromise(tools.requestStart(startOf(1)));
    Option.map(tools.reinstall([]), ({ mcp }) => session.registry.install(mcp));
    await session.prompt("go");
    await session.settle();

    const named = host.calls.flatMap((each) =>
      each.method === "request" && each.input.op === "tools/call"
        ? [[each.input.params.arguments, each.input.ctx.workspace]]
        : [],
    );

    expect(named).toEqual([[{ query: "in the child" }, "ws:w1"]]);
  });

  it("readies the caller's Workspace before a call to a stdio server, and sends nothing when it did not answer", async () => {
    const host = fakeMcpHost([{ ...DOCS, entry: { type: "stdio", command: "npx" } }, ISSUES]);
    const readied: Array<string> = [];
    let answers = true;

    const tools = makeMcpTools(host.client, memoryMcpToolsStore(), {
      ready: async (workspace) => {
        readied.push(workspace);

        return answers;
      },
    });

    const session = await open((request) => {
      if (request.text === "stdio") return call(["mcp__docs_site__search", { query: "q" }]);

      if (request.text === "http") return call(["mcp__issues__list", {}]);

      return answer("ok");
    });

    await session.start(tools);
    await session.prompt("stdio");
    await session.prompt("http");
    answers = false;
    await session.prompt("stdio");

    // Only the stdio server's calls are readied, with the Session's Workspace for a conversation with no other.
    expect(readied).toEqual(["ws:w1", "ws:w1"]);
    expect(
      host.calls.flatMap((each) => (each.method === "request" ? [each.input.server] : [])),
    ).toEqual(["Docs-Site", "issues"]);
    expect((await session.texts("toolResult")).at(-1)).toContain("did not answer");
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

    await session.start(tools);

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

    await session.start(tools);
    await session.prompt("twice");

    expect(await results(session)).toEqual([
      [false, [{ type: "text", text: '{"count":2}' }]],
      [true, [{ type: "text", text: "no such page" }]],
    ]);
  });

  it("reads a call whose host end was lost, or that outlived its timeout and slack, as maybe run, and cancels it", async () => {
    const host = fakeMcpHost([{ ...DOCS, timeout: 0.05 }]);
    const tools = makeMcpTools(host.client, memoryMcpToolsStore(), { slackMs: 0 });
    let calls = 0;
    let cancelled = false;

    host.answer(async (_input, hooks) => {
      if (calls++ === 0) return HostLost.make({ message: "The RPC broke" });

      // The host never answers: the Session gives up on it and tells it to cancel.
      await hooks.untilAborted?.();
      cancelled = true;

      return new Promise<never>(() => undefined);
    });

    const session = await open((request) =>
      request.text === "twice"
        ? call(["mcp__docs_site__search", {}], ["mcp__docs_site__search", {}])
        : answer("ok"),
    );

    await session.start(tools);
    await session.prompt("twice");

    const lost =
      "The MCP host was lost before the call's answer arrived; it may or may not have run.";

    expect(await results(session)).toEqual([
      [true, [{ type: "text", text: lost }]],
      [true, [{ type: "text", text: lost }]],
    ]);
    expect(cancelled).toBe(true);
    expect(await detailsOf(session)).toEqual([
      expect.objectContaining({ server: "Docs-Site", tool: "search", cut: "host_lost" }),
      expect.objectContaining({ server: "Docs-Site", tool: "search", cut: "host_lost" }),
    ]);
    // No cause, stack or RPC text reaches the model.
    expect(JSON.stringify(await results(session))).not.toContain("RPC");
  });

  it("waits past the timeout and slack while progress keeps coming", async () => {
    const host = fakeMcpHost([{ ...DOCS, timeout: 0.2 }]);
    const tools = makeMcpTools(host.client, memoryMcpToolsStore(), { slackMs: 0 });

    // Four notices 100 ms apart: 500 ms in all, past the 200 ms the Session waits without one.
    host.answer(async (_input, hooks) => {
      for (let step = 1; step <= 4; step++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        await hooks.onProgress?.({ progress: step, total: 4 } satisfies McpProgress);
      }

      await new Promise((resolve) => setTimeout(resolve, 100));

      return McpHostCompleted.make({
        result: { kind: "inline", value: { content: [{ type: "text", text: "done" }] } },
      });
    });

    const session = await open((request) =>
      request.text === "slow" ? call(["mcp__docs_site__search", {}]) : answer("ok"),
    );

    await session.start(tools);
    await session.prompt("slow");

    expect(await results(session)).toEqual([[false, [{ type: "text", text: "done" }]]]);
    expect((await detailsOf(session))[0]).not.toHaveProperty("cut");
  });
});
