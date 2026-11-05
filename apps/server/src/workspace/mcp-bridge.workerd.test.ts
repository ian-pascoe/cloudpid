// The Workspace DO's side of the Container MCP bridge (docs/architecture/mcp-connections.md → The stdio bridge, #382
// D5.1): a request the MCP engine made, handed to `mcpBridge(request, { start, use })` as the Workspaces Worker's
// `WorkspaceMcpBridge` entrypoint hands it, and answered from a fake bridge on the fake Container
// (`TestWorkspace.fakeBridge`), with the bridge token the launch record holds as its bearer.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalJsonInEffect:off newPromise:off globalTimers:off
import { env, exports } from "cloudflare:workers";
import { MCP_BRIDGE_CONFIG_HEADER } from "@cloudpid/sandbox-image/mcp-bridge";
import { describe, expect, it, vi } from "vitest";
import { workspacePreparation } from "./prepare.ts";
import type { WorkspaceMcpBridge } from "./worker.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
    }
  }
}

const TOKEN = "bridge-token-for-this-launch";

let objects = 0;

/**
 * A Workspace DO of its own, named as a Workspace's (`ws:<id>`), with a record of itself (but no use made of it), its
 * Container running (or not) with a bridge on it that expects `TOKEN`, which the launch record holds.
 */
const namedWorkspace = async (options: { running?: boolean; recorded?: boolean } = {}) => {
  objects += 1;

  const name = `ws:mcp-bridge-${objects}`;
  const stub = env.WORKSPACES.getByName(name);

  if (options.recorded !== false) await stub.markRecorded();

  await stub.fakeContainer({ running: options.running ?? true });
  await stub.fakeBridge({ token: TOKEN });
  await stub.seedLaunchRecord(TOKEN);

  return { name, stub };
};

const workspace = async (options: { running?: boolean; recorded?: boolean } = {}) =>
  (await namedWorkspace(options)).stub;

type Workspace = Awaited<ReturnType<typeof workspace>>;

const MCP = "http://bridge.internal/mcp";

/** A call: a POST to `/mcp` naming its server. */
const call = (body = '{"jsonrpc":"2.0","id":1,"method":"tools/call"}') =>
  new Request(MCP, {
    method: "POST",
    headers: { [MCP_BRIDGE_CONFIG_HEADER]: "e30", "content-type": "application/json" },
    body,
  });

/** The readying a Session does of a Workspace of an Environment with no Repos and no Skills, over its real Durable Object. */
const prepare = (name: string) =>
  workspacePreparation(env.WORKSPACES, () => undefined)(name, {
    repos: [],
    branch: "main",
    base: null,
    settings: {},
  });

const USE = { start: false, use: true } as const;
const NO_USE = { start: false, use: false } as const;

/** Whether the Workspace has noted activity (`IdleStop.noteActivity`), which only an owner's or an agent's action does. */
const noted = async (stub: Workspace) =>
  (await stub.storageKeys("cloudpid:container-last-activity")).length > 0;

describe("a use of the bridge", () => {
  it("is forwarded with the launch's token as its bearer, whatever the caller sent, and its answer passed back", async () => {
    const stub = await workspace();

    const request = new Request(`${MCP}?x=1`, {
      method: "POST",
      headers: {
        [MCP_BRIDGE_CONFIG_HEADER]: "e30",
        authorization: "Bearer the-callers",
        host: "elsewhere.example",
      },
      body: '{"jsonrpc":"2.0"}',
    });

    const response = await stub.mcpBridge(request, USE);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-cloudpid-spawn")).toBe("spawn-1");
    expect(await response.json()).toEqual({ ok: true });
    expect((await stub.bridgeState()).requests).toEqual([
      {
        method: "POST",
        path: "/mcp?x=1",
        authorization: `Bearer ${TOKEN}`,
        host: "localhost:17781",
        config: "e30",
        body: '{"jsonrpc":"2.0"}',
      },
    ]);
    // The Container ran already: nothing was started, and the bridge's health was not asked for before the request... once.
    expect((await stub.fakeContainerState()).scripts).toEqual([]);
  });

  it("polls no health for a Container found running, however slow its bridge: a status check never waits for it", async () => {
    const stub = await workspace();

    await stub.fakeBridge({ token: TOKEN, healthFailures: 5 });

    for (const options of [NO_USE, { start: true, use: false }]) {
      expect((await stub.mcpBridge(call(), options)).status).toBe(200);
    }

    expect((await stub.bridgeState()).healthPolls).toBe(0);
    expect((await stub.fakeContainerState()).scripts).toEqual([]);
  });

  it("touches the Container and holds it until the response body ends, as a command that may write holds it", async () => {
    const stub = await workspace();

    const response = await stub.mcpBridge(
      new Request(`${MCP}?stream=1`, { method: "POST", body: "{}" }),
      USE,
    );

    expect(await stub.mcpBridgeUses()).toEqual({ touch: 1, begin: 1, end: 0 });
    expect(await stub.mcpBridgeHolds()).toEqual({ open: 1, writing: 1 });
    expect(await stub.spareUsed()).toBe(true);

    const reader = response.body!.getReader();

    await stub.bridgeSend(0, "data: 1\n\n");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: 1\n\n");
    expect(await stub.mcpBridgeUses()).toEqual({ touch: 1, begin: 1, end: 0 });

    await stub.bridgeEnd(0);
    expect((await reader.read()).done).toBe(true);
    await vi.waitFor(async () =>
      expect(await stub.mcpBridgeUses()).toEqual({ touch: 1, begin: 1, end: 1 }),
    );
    expect(await stub.mcpBridgeHolds()).toEqual({ open: 0, writing: 0 });
    expect(await noted(stub)).toBe(false);
  });

  it("ends its hold when the response has no body", async () => {
    const stub = await workspace();

    const response = await stub.mcpBridge(call(), USE);

    await response.text();
    await vi.waitFor(async () =>
      expect(await stub.mcpBridgeUses()).toEqual({ touch: 1, begin: 1, end: 1 }),
    );
  });

  it("ends its hold when the caller cancels the response, and cancels the bridge's stream", async () => {
    const stub = await workspace();

    const response = await stub.mcpBridge(
      new Request(`${MCP}?stream=1`, { method: "POST", body: "{}" }),
      USE,
    );

    const reader = response.body!.getReader();

    await stub.bridgeSend(0, "data: 1\n\n");
    await reader.read();
    await reader.cancel();
    // The platform tells a stream of a cancel at the stream's next chunk, if not sooner.
    await stub.bridgeSend(0, "data: 2\n\n");
    await vi.waitFor(async () => expect((await stub.mcpBridgeUses()).end).toBe(1));
    await vi.waitFor(async () =>
      expect((await stub.bridgeState()).streams).toEqual([{ cancelled: true }]),
    );
    expect(await stub.mcpBridgeHolds()).toEqual({ open: 0, writing: 0 });
  });

  it("holds once for each request, so two at once hold the Container until both have ended", async () => {
    const stub = await workspace();

    const first = await stub.mcpBridge(
      new Request(`${MCP}?stream=1`, { method: "POST", body: "{}" }),
      USE,
    );

    const second = await stub.mcpBridge(
      new Request(`${MCP}?stream=1`, { method: "POST", body: "{}" }),
      USE,
    );

    expect(await stub.mcpBridgeUses()).toEqual({ touch: 2, begin: 2, end: 0 });

    await stub.bridgeEnd(0);
    await first.text();
    await vi.waitFor(async () => expect((await stub.mcpBridgeUses()).end).toBe(1));
    expect(await stub.mcpBridgeHolds()).toEqual({ open: 1, writing: 1 });

    await stub.bridgeEnd(1);
    await second.text();
    await vi.waitFor(async () => expect((await stub.mcpBridgeUses()).end).toBe(2));
    expect(await stub.mcpBridgeHolds()).toEqual({ open: 0, writing: 0 });
  });
});

describe("a request that is no use of the bridge", () => {
  it("never touches or holds the Container, or marks a spare as used, and is not activity", async () => {
    const stub = await workspace();

    const response = await stub.mcpBridge(
      new Request(`${MCP}?stream=1`, { headers: { accept: "text/event-stream" } }),
      NO_USE,
    );

    expect(response.status).toBe(200);
    expect(await stub.mcpBridgeUses()).toEqual({ touch: 0, begin: 0, end: 0 });
    expect(await stub.mcpBridgeHolds()).toEqual({ open: 0, writing: 0 });
    expect(await stub.spareUsed()).toBe(false);
    expect(await noted(stub)).toBe(false);
    expect((await stub.bridgeState()).requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);

    await response.body!.cancel();
  });
});

describe("a stopped Container", () => {
  it("answers 503 `stopped` for a request that may not start it, asking nothing of the Container and counting no use", async () => {
    const stub = await workspace({ running: false });

    for (const options of [USE, NO_USE]) {
      const response = await stub.mcpBridge(call(), options);

      expect(response.status).toBe(503);
      expect(response.headers.get("x-cloudpid-container")).toBe("stopped");
      expect(await response.json()).toMatchObject({ error: "stopped" });
    }

    expect((await stub.fakeContainerState()).scripts).toEqual([]);
    expect((await stub.fakeContainerState()).running).toBe(false);
    expect(await stub.bridgeState()).toEqual({ requests: [], healthPolls: 0, streams: [] });
    expect(await stub.mcpBridgeUses()).toEqual({ touch: 0, begin: 0, end: 0 });
    expect(await stub.spareUsed()).toBe(false);
    expect(await noted(stub)).toBe(false);
  });

  it("is started as a command starts it (`true`, which writes nothing) when the request asks, and then waits for the bridge's health", async () => {
    const stub = await workspace({ running: false });

    await stub.fakeBridge({ token: TOKEN, healthFailures: 3 });

    const response = await stub.mcpBridge(call(), { start: true, use: true });

    expect(response.status).toBe(200);
    expect((await stub.fakeContainerState()).scripts).toEqual(["true"]);
    expect((await stub.fakeContainerState()).running).toBe(true);

    const state = await stub.bridgeState();

    // Three polls found nothing listening, the fourth answered; the request itself came after.
    expect(state.healthPolls).toBe(4);
    expect(state.requests.map((request) => request.path)).toEqual(["/mcp"]);
    expect(await stub.mcpBridgeUses()).toMatchObject({ begin: 1 });
  });

  it("reads the token again while it polls, since the launch is recorded after the Container has started", async () => {
    const stub = await workspace({ running: false });

    await stub.forgetLaunchRecord();

    const answered = stub.mcpBridge(call(), { start: true, use: false });

    await new Promise((resolve) => setTimeout(resolve, 50));
    await stub.seedLaunchRecord(TOKEN);

    const response = await answered;

    expect(response.status).toBe(200);
    expect((await stub.bridgeState()).requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("is started once for requests that arrive while it starts, and polls once for them all", async () => {
    const stub = await workspace({ running: false });

    await stub.fakeBridge({ token: TOKEN, healthFailures: 2 });

    const responses = await Promise.all(
      [1, 2, 3].map(() => stub.mcpBridge(call(), { start: true, use: false })),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect((await stub.fakeContainerState()).scripts).toEqual(["true"]);
    expect((await stub.bridgeState()).healthPolls).toBe(3);
    expect((await stub.bridgeState()).requests).toHaveLength(3);
  });

  it("answers 502 `start_failed` when the Container does not start", async () => {
    const stub = await workspace({ running: false });

    await stub.failContainerStart();

    const response = await stub.mcpBridge(call(), { start: true, use: true });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "start_failed" });
    expect(await stub.mcpBridgeUses()).toEqual({ touch: 0, begin: 0, end: 0 });
  });
});

describe("a bridge that does not answer", () => {
  it("answers 502 `bridge_unreachable` after a start, when its health never answers, saying `container_restart` starts another", async () => {
    const stub = await workspace({ running: false });

    await stub.fakeBridge({ token: TOKEN, unreachable: true });

    const response = await stub.mcpBridge(call(), { start: true, use: true });

    expect(response.status).toBe(502);

    const refusal = await response.json<{ error: string; message: string }>();

    expect(refusal.error).toBe("bridge_unreachable");
    expect(refusal.message).toContain("container_restart");
    // The fixture's poll is 20 attempts.
    expect((await stub.bridgeState()).healthPolls).toBe(20);
    expect(await stub.mcpBridgeUses()).toEqual({ touch: 0, begin: 0, end: 0 });
  });

  it("answers 502 `bridge_unreachable`, and releases its hold, when the bridge exits after answering its health", async () => {
    const stub = await workspace();

    await (await stub.mcpBridge(call(), USE)).text();
    await stub.fakeBridge({ token: TOKEN, unreachable: true });

    const response = await stub.mcpBridge(call(), USE);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "bridge_unreachable" });
    await vi.waitFor(async () => expect((await stub.mcpBridgeUses()).end).toBe(2));
    expect(await stub.mcpBridgeHolds()).toEqual({ open: 0, writing: 0 });
  });

  it("answers 502 `bridge_unreachable` for a Container whose launch kept no token: it runs no bridge", async () => {
    const stub = await workspace();

    await stub.seedLaunchRecord(undefined);

    const response = await stub.mcpBridge(call(), USE);

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "bridge_unreachable" });
    expect((await stub.bridgeState()).requests).toEqual([]);
  });

  it("answers 502 `bridge_unreachable` when the bridge refuses the token in its health check: it is another launch's", async () => {
    const stub = await workspace({ running: false });

    await stub.fakeBridge({ token: "another-launchs" });

    const response = await stub.mcpBridge(call(), { start: true, use: false });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "bridge_unreachable" });
    expect((await stub.bridgeState()).requests).toEqual([]);
  });

  it("answers 502 `bridge_unreachable` when the bridge refuses the token on a forward, and releases its hold: it is another launch's", async () => {
    const stub = await workspace();

    await stub.fakeBridge({ token: "another-launchs" });

    for (const options of [USE, NO_USE]) {
      const response = await stub.mcpBridge(call(), options);

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: "bridge_unreachable" });
    }

    await vi.waitFor(async () => expect((await stub.mcpBridgeUses()).end).toBe(1));
    expect(await stub.mcpBridgeHolds()).toEqual({ open: 0, writing: 0 });
  });

  it("remembers a failed poll for the launch: a later request, whatever it asks, answers `bridge_unreachable` at once", async () => {
    const stub = await workspace({ running: false });

    await stub.fakeBridge({ token: TOKEN, unreachable: true });
    expect((await stub.mcpBridge(call(), { start: true, use: false })).status).toBe(502);

    const polled = (await stub.bridgeState()).healthPolls;

    // The bridge comes up, but nothing polls for this launch again.
    await stub.fakeBridge({ token: TOKEN });

    for (const options of [NO_USE, { start: true, use: false }]) {
      expect((await stub.mcpBridge(call(), options)).status).toBe(502);
    }

    expect(await stub.bridgeState()).toEqual({ requests: [], healthPolls: 0, streams: [] });
    expect(polled).toBe(20);
  });

  it("passes any other status of the bridge's on, as it is the bridge's own", async () => {
    const stub = await workspace();

    for (const status of [400, 404, 405, 500]) {
      const response = await stub.mcpBridge(
        new Request(`${MCP}?status=${status}`, { method: "POST", body: "{}" }),
        USE,
      );

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: "no" });
    }

    await vi.waitFor(async () => expect((await stub.mcpBridgeUses()).end).toBe(4));
  });
});

describe("a Workspace with no record of itself", () => {
  it("answers 404 `no_workspace`, starting no Container and counting no use", async () => {
    const stub = await workspace({ recorded: false });

    for (const options of [USE, NO_USE, { start: true, use: true }]) {
      const response = await stub.mcpBridge(call(), options);

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "no_workspace" });
    }

    expect((await stub.fakeContainerState()).scripts).toEqual([]);
    expect(await stub.bridgeState()).toEqual({ requests: [], healthPolls: 0, streams: [] });
    expect(await stub.mcpBridgeUses()).toEqual({ touch: 0, begin: 0, end: 0 });
  });

  it("is a Workspace that was destroyed: its storage is wiped, its record with it", async () => {
    const { name, stub } = await namedWorkspace({ recorded: false });

    await prepare(name);
    expect((await stub.mcpBridge(call(), USE)).status).toBe(200);

    await stub.destroy();

    for (const options of [USE, NO_USE, { start: true, use: true }]) {
      const response = await stub.mcpBridge(call(), options);

      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "no_workspace" });
    }
  });
});

describe("a Workspace a Session readied that has no Repos and no Skills", () => {
  it("has a record of itself, though nothing was written to its files, so its first request gets through", async () => {
    const { name, stub } = await namedWorkspace({ recorded: false });

    // Before the readying, nothing is there.
    expect((await stub.mcpBridge(call(), USE)).status).toBe(404);

    // The readying a Session does (`prepareWorkspace`), over the real object: the Environment's settings are read, and
    // with no Repos to clone and no Skills to mount, nothing is written to the files.
    await prepare(name);

    const response = await stub.mcpBridge(call(), USE);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("a spare Workspace that is prepared and not yet used", () => {
  it("has a record of itself, so its first request gets through, and the request is no use of it until it is one", async () => {
    const { stub } = await namedWorkspace({ recorded: false });

    expect((await stub.mcpBridge(call(), NO_USE)).status).toBe(404);

    await stub.prepareSpare({ repos: [], branch: "cloudpid/spare", base: null, settings: {} });

    expect((await stub.mcpBridge(call(), NO_USE)).status).toBe(200);
    expect(await stub.spareUsed()).toBe(false);
  });
});

describe("the Workspaces Worker's MCP bridge entrypoint", () => {
  // SAFETY: the test Worker's entry (`workerd.fixture.ts`) exports `WorkspaceMcpBridge`, an RPC entrypoint.
  const entrypoint = (exports as { readonly WorkspaceMcpBridge: WorkspaceMcpBridge })
    .WorkspaceMcpBridge;

  it("hands a request to the Workspace DO it names", async () => {
    const { name } = await namedWorkspace();

    const response = await entrypoint.mcpBridge(name, call(), USE);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("answers 404 `no_workspace` for a Workspace that does not exist", async () => {
    const response = await entrypoint.mcpBridge("ws:never-made", call(), USE);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "no_workspace" });
  });

  it("reaches no object but a Workspace's: not a Build's, nor one named otherwise", async () => {
    for (const name of ["build:environment", "test-build:environment", "ws:../x", "session"]) {
      const response = await entrypoint.mcpBridge(name, call(), USE);

      expect(response.status, name).toBe(404);
      expect(await response.json(), name).toMatchObject({ error: "no_workspace" });
    }
  });
});
