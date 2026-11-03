// MCP tools in a Session end to end (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension; ADR-0030): a
// Session's request start builds its `mcp` extension from its Environment's `McpHost`, and the model's call goes
// Session → host → the real `McpEngine` → a fake MCP server, with its progress in the running call's `details` and Stop
// cancelling it at the server. Over a scripted engine: an eviction keeps the tools and declarations a resumed call
// was shown, each Context Window's first request pulls the set, a settings change during a request start is the one
// installed, and a Workspace that does not answer keeps the host uncalled.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { legacyStatefulServer, PROGRESS_TOOL } from "@cloudpid/mcp/testing";
import type { McpApplySet, McpEngineDiscoverResult } from "@cloudpid/mcp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineScript } from "../mcp/host.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

/** `vi.waitFor`, with room for a loaded CI runner. */
const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

let counter = 0;

/** The set of an Environment with one HTTP server, `docs`, whose tools are all `direct`. */
const SET: McpApplySet = {
  kind: "set",
  hash: "h1",
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
};

const DOCS = "https://docs.example/mcp";

/** A discovery of `docs` that found the tool `work`. */
const FOUND: EngineScript = {
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {} },
    tools: [{ name: "work", inputSchema: { type: "object" } }],
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {
      era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 },
    },
  } as typeof McpEngineDiscoverResult.Encoded,
};

/**
 * A Session in a fresh Environment whose host holds `SET` over a scripted engine that finds `work` on `docs` (holding
 * the discovery until released when `hold`), and a Registry whose pull answers the set's hash.
 */
const scripted = async (
  options: {
    readonly hold?: boolean;
    readonly exposure?: string;
    readonly offered?: ReadonlyArray<string>;
  } = {},
) => {
  const environment = `env-${counter++}`;
  const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);

  await host.script({ hash: SET.hash, signInsRevision: 0 });
  await host.scriptEngine(DOCS, [{ ...FOUND, hold: options.hold === true }]);
  const { exposure } = options;

  await host.apply(
    exposure === undefined
      ? SET
      : {
          ...SET,
          entries: SET.entries.map((entry) => ({
            ...entry,
            server: { ...entry.server, exposure },
          })),
        },
  );

  const stub = env.SESSIONS.getByName(`mcp-${environment}`);

  await runInDurableObject(stub, (instance: TestSession, state) => {
    instance.mcpEnvironment(environment, 1);

    if (options.offered !== undefined) {
      state.storage.kv.put("mcp-global", { tools: { offered: options.offered } });
    }
  });

  return { environment, host, stub };
};

const idle = (stub: DurableObjectStub<TestSession>) =>
  settles(async () =>
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("an MCP tool in a Session", () => {
  it("is offered from the host's inventory, and its call reaches the server with progress, until Stop cancels it", async () => {
    const environment = `env-${counter++}`;
    const host = env.MCP_HOSTS.getByName(`mcp:${environment}`);
    const cancelled: Array<string> = [];

    // Every outbound `fetch` of the test Worker, the engine's included, reaches the fake server.
    const server = legacyStatefulServer({ moreTools: [PROGRESS_TOOL], cancelled });

    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      server.handle(new Request(input, init)),
    );

    await host.useRealEngine();
    await host.apply(SET);

    const stub = env.SESSIONS.getByName(`mcp-${environment}`);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.mcpEnvironment(environment, 1);
      instance.script(['call:mcp__docs__progress:{"steps":2,"hang":true}', "stopped"]);
      await instance.submit({ requestId: "turn-1", text: "report progress" });
    });

    // The first request waited for the server's discovery: its tools were offered, `direct`.
    const offered = await runInDurableObject(stub, (instance: TestSession) =>
      instance.offeredTools(),
    );

    expect(offered[0]).toEqual(expect.arrayContaining(["mcp__docs__echo", "mcp__docs__progress"]));

    // The Workspace was marked used before the host was called, and `codemode` was installed with the server.
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.mcpReady())).toBe(1);
    expect(
      await runInDurableObject(stub, (instance: TestSession) => instance.codemodeNamespaces()),
    ).toEqual([
      expect.objectContaining({
        name: "mcp__docs",
        prefix: "mcp__docs",
        instructions: "Use the echo tool.",
      }),
    ]);

    // The server's progress reaches the running call's details.
    await settles(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestSession) => instance.liveToolDetails()),
      ).toEqual([
        expect.objectContaining({
          server: "docs",
          tool: "progress",
          progress: expect.objectContaining({ total: 2 }),
        }),
      ]),
    );

    // Stop resolves the call's `untilAborted`: the engine cancels the request, and the server sees it.
    await runInDurableObject(stub, (instance: TestSession) => instance.abortRoot());

    await settles(async () => expect(cancelled).toEqual(["progress"]));
    await settles(async () =>
      expect(await runInDurableObject(stub, (instance: TestSession) => instance.idle())).toBe(true),
    );
  });

  it("keeps the tools and declarations a call was shown across an eviction, and settles the resumed call", async () => {
    const { environment, host, stub } = await scripted();

    await host.scriptRequest(DOCS, [
      {
        result: {
          kind: "complete",
          result: { kind: "inline", value: { content: [{ type: "text", text: "late" }] } },
          cacheable: true,
          fetchedAt: Date.now(),
          state: {},
        },
        hold: true,
      },
    ]);

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["call:mcp__docs__work:{}", "done"]);
      await instance.submit({ requestId: "turn-1", text: "work" });
    });

    // The call reached the engine, which holds it: the Session (and the host with it) goes away mid-call. Eviction
    // would wait for the held call to drain, so the objects are aborted instead; their storage stays.
    await settles(async () => expect(await host.engineRequests()).toHaveLength(1));
    await abortAllDurableObjects();

    const after = env.SESSIONS.getByName(`mcp-${environment}`);
    const hostAfter = env.MCP_HOSTS.getByName(`mcp:${environment}`);

    expect(await runDurableObjectAlarm(after)).toBe(true);
    await idle(after);

    const [declarations, systems, results] = await runInDurableObject(
      after,
      async (instance: TestSession) =>
        [
          instance.requestDeclarations(),
          instance.requestSystemMessages(),
          await instance.toolResults(),
        ] as const,
    );

    // The resumed Run's request was shown what the first was, its prompt unchanged.
    expect(declarations).toHaveLength(2);
    expect(declarations[1]).toEqual(declarations[0]);
    expect(declarations[0]).toContain("mcp__docs__work");
    expect(systems[1]).toBe(systems[0]);
    // The extension's own words, which say the `mcp.sent` marker was found, not pi-durable's for a tool that cannot replay.
    expect(results.at(-1)).toMatch(
      /mcp__docs__work was interrupted and may have partially run; it was not sent again\./,
    );
    // The tools came back from what the Session kept: the start called no host, and the call did not run again.
    expect(await hostAfter.asked()).toEqual([]);
    expect(await hostAfter.engineRequests()).toEqual([]);
  });

  it("pulls the set at the first request of each Context Window", async () => {
    const { host, stub } = await scripted();

    await runInDurableObject(stub, async (instance: TestSession, state) => {
      state.storage.kv.put("mcp-global", { compaction: { keepRecentTokens: 1 } });
      instance.script(["First answer.", "Same window.", "The summary.", "Later answer."]);
      await instance.prompt({ requestId: "one", text: "First" });
      await instance.prompt({ requestId: "same", text: "Again" });
    });

    expect(await host.asked()).toHaveLength(1);

    await runInDurableObject(stub, (instance: TestSession) => instance.command("compact", ""));
    await settles(async () => {
      const kinds = await runInDurableObject(stub, async (instance: TestSession) =>
        (await instance.rootEntries()).map((entry) => entry.kind),
      );

      expect(kinds).toContain("pi.compaction");
    });

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.prompt({ requestId: "two", text: "Later" }),
    );

    expect(await host.asked()).toHaveLength(2);
  });

  it("installs the settings in force when a request start ends, not those it started with", async () => {
    // A `deferred` server, which the offered set first names: a build for that set offers its tool directly.
    const { host, stub } = await scripted({
      hold: true,
      exposure: "deferred",
      offered: ["mcp__docs__*"],
    });

    await runInDurableObject(stub, (instance: TestSession) => {
      instance.script(["done"]);
      void instance.submit({ requestId: "turn-1", text: "hi" });
    });

    // The first request waits for the discovery; the offered set changes meanwhile, and tool_search is installed for it.
    await settles(async () => expect(await host.engineCalls()).toHaveLength(1));
    await runInDurableObject(stub, (instance: TestSession) => instance.mcpOffered(["echo"]));
    await host.release(DOCS);
    await idle(stub);

    const [offered, namespaces] = await runInDurableObject(
      stub,
      (instance: TestSession) => [instance.offeredTools(), instance.codemodeNamespaces()] as const,
    );

    // The request was built for the new set: echo offered, the server's tool deferred behind tool_search.
    expect(offered).toHaveLength(1);
    expect(offered[0]).toEqual(expect.arrayContaining(["echo", "tool_search"]));
    expect(offered[0]).not.toContain("mcp__docs__work");
    expect(namespaces).toEqual([expect.objectContaining({ name: "mcp__docs" })]);
  });

  it("calls no host while the Workspace does not answer, and keeps the tools it was built with", async () => {
    const { host, stub } = await scripted();

    const answer = await runInDurableObject(stub, (instance: TestSession) => {
      instance.mcpWorkspaceFails(true);
      instance.script(["answered"]);

      return instance.prompt({ requestId: "turn-1", text: "hi" });
    });

    expect(answer).toMatchObject({ status: "answered", text: "answered" });
    expect(await host.asked()).toEqual([]);
    expect(await host.engineCalls()).toEqual([]);

    const [ready, offered] = await runInDurableObject(
      stub,
      (instance: TestSession) => [instance.mcpReady(), instance.offeredTools()] as const,
    );

    expect(ready).toBe(0);
    expect(offered[0]?.some((name) => name.startsWith("mcp__"))).toBe(false);
  });

  it("keeps a Context Window open across a restart: its next request pulls nothing", async () => {
    const { environment, host, stub } = await scripted();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["First answer.", "Later answer."]);
      await instance.prompt({ requestId: "one", text: "First" });
    });

    expect(await host.asked()).toHaveLength(1);

    // Both objects go away; their storage stays, the host's record of what it was asked does not.
    await abortAllDurableObjects();

    const after = env.SESSIONS.getByName(`mcp-${environment}`);
    const hostAfter = env.MCP_HOSTS.getByName(`mcp:${environment}`);

    await runInDurableObject(after, (instance: TestSession) =>
      instance.prompt({ requestId: "two", text: "Later" }),
    );

    expect(await hostAfter.asked()).toEqual([]);
    expect(
      await runInDurableObject(after, (instance: TestSession) => instance.offeredTools()),
    ).toEqual([
      expect.arrayContaining(["mcp__docs__work"]),
      expect.arrayContaining(["mcp__docs__work"]),
    ]);
  });

  it("tells the conversation of a set change with exactly one notice, and never changes the section it was shown", async () => {
    const { environment, host, stub } = await scripted({ exposure: "codemode" });

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["First answer.", "Second answer.", "Third answer."]);
      await instance.prompt({ requestId: "one", text: "First" });
    });

    // A second server joins the set: its line is not in the section the conversation was shown.
    await host.apply({
      ...SET,
      hash: "h2",
      revision: 2,
      entries: [
        ...SET.entries.map((entry) => ({
          ...entry,
          server: { ...entry.server, exposure: "codemode" },
        })),
        {
          name: "search",
          source: { kind: "global" },
          server: {
            type: "http",
            url: "https://search.example/mcp",
            headers: {},
            exposure: "deferred",
          },
          hash: "hash-search",
          conn: "conn-search",
          identity: "identity-search",
        },
      ],
    });

    await runInDurableObject(stub, async (instance: TestSession) => {
      await instance.prompt({ requestId: "two", text: "Second" });
      await instance.prompt({ requestId: "three", text: "Third" });
    });

    const notices = async (target: DurableObjectStub<TestSession>) =>
      (await runInDurableObject(target, (instance: TestSession) => instance.rootEntries())).filter(
        (entry) => entry.kind === "cloudpid.mcp-servers",
      );

    const systems = await runInDurableObject(stub, (instance: TestSession) =>
      instance.requestSection("mcp_servers"),
    );

    expect(await notices(stub)).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ notice: "MCP servers changed" }),
        text: expect.stringContaining("- mcp__search (connecting)"),
      }),
    ]);
    // The section the provider got is the one it was first shown, in every request.
    expect(systems[0]).toContain("- mcp__docs (codemode)");
    expect(systems[0]).not.toContain("mcp__search");
    expect(systems[1]).toBe(systems[0]);
    expect(systems[2]).toBe(systems[0]);

    // The object starts again: what the conversation's context holds is what keeps it from being told twice.
    await abortAllDurableObjects();

    const after = env.SESSIONS.getByName(`mcp-${environment}`);

    await runInDurableObject(after, async (instance: TestSession) => {
      instance.script(["Fourth answer."]);
      await instance.prompt({ requestId: "four", text: "Fourth" });
    });

    expect(await notices(after)).toHaveLength(1);
  });

  it("writes the notice of a settings read's change before it installs the build", async () => {
    const { stub } = await scripted({ exposure: "codemode" });

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["First answer."]);
      await instance.prompt({ requestId: "one", text: "First" });
      instance.mcpOrderClear();
      // Offering the server's tools lifts them to direct: its line goes, and the conversation is told so.
      await instance.mcpOffered(["mcp__docs__*"]);
    });

    const { order, notices } = await runInDurableObject(stub, async (instance: TestSession) => ({
      order: instance.mcpOrder(),
      notices: (await instance.rootEntries()).filter(
        (entry) => entry.kind === "cloudpid.mcp-servers",
      ),
    }));

    expect(order.indexOf("announce")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("install")).toBeGreaterThan(order.indexOf("announce"));
    expect(notices).toEqual([
      expect.objectContaining({ text: expect.stringContaining("No MCP server is listed now.") }),
    ]);
  });

  it("keeps the tools it built when its Workspace cannot be looked up", async () => {
    const { stub } = await scripted();

    const offered = await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["First answer.", "Later answer."]);
      await instance.prompt({ requestId: "one", text: "First" });
      instance.mcpWorkspaceUnknown(true);
      await instance.prompt({ requestId: "two", text: "Later" });

      return instance.offeredTools();
    });

    expect(offered).toEqual([
      expect.arrayContaining(["mcp__docs__work"]),
      expect.arrayContaining(["mcp__docs__work"]),
    ]);
    // The second start marked no Workspace, so called no host.
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.mcpReady())).toBe(1);
  });
});
