// MCP tools in a Session end to end (`docs/architecture/mcp-in-a-session.md` → The `mcp` extension; ADR-0030): a
// Session's request start builds its `mcp` extension from its Environment's `McpHost`, and the model's call goes
// Session → host → the real `McpEngine` → a fake MCP server, with its progress in the running call's `details` and Stop
// cancelling it at the server.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { legacyStatefulServer, PROGRESS_TOOL } from "@cloudpid/mcp/testing";
import type { McpApplySet } from "@cloudpid/mcp/types";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
