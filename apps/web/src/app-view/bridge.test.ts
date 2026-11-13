// docs/architecture/mcp-apps.md → The bridge, Testing. The App View's bridge against a fake iframe: the tool notifications and
// the retire, over the frame protocol (`sandbox-frame/frame-protocol.test.ts` tests that on its own), then the real ext-apps
// `App` (the runtime every example View bundles, read from the package and run unmodified in a fake window) as the View on
// the other side of a relaying proxy.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, typescript/no-implied-eval -- fakes of the browser's windows and of JSON-RPC traffic: their data is whatever a case posts, a View's runtime is evaluated from the package as a function of its window (`new Function`, the only way to run it here), and the casts are cut down to a case's shape */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off nodeBuiltinImport:off globalTimers:off newPromise:off -- fakes of the browser's windows and timers.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MCP_APPS_PROTOCOL_VERSION } from "../sandbox-frame/frame-protocol.ts";
import {
  fakePage,
  HTML,
  ORIGIN,
  handshake,
  methodsOf,
  rpc,
} from "../sandbox-frame/fake-page.testing.ts";
import { retire, createBridge, type BridgeEvent, type BridgeOptions } from "./bridge.ts";
import {
  HOST_INFO,
  hostCapabilities,
  hostContextOf,
  type HostEnvironment,
} from "./host-context.ts";

const env: HostEnvironment = {
  dark: false,
  readProperty: (property) => (property === "--background" ? "oklch(1 0 0)" : ""),
  locale: "en-US",
  timeZone: "UTC",
  userAgent: "test",
  mobile: false,
  touch: false,
  hover: true,
  width: 600,
  maxHeight: 448,
};

const context = hostContextOf(env, { callId: "call-1", name: "get-time", title: "Get time" });

const make = (page: ReturnType<typeof fakePage>, more: Partial<BridgeOptions> = {}) => {
  const events: BridgeEvent[] = [];

  const bridge = createBridge({
    frame: page.frame,
    origin: ORIGIN,
    listen: page.listen,
    page: { html: HTML },
    hostContext: () => context,
    capabilities: hostCapabilities(undefined),
    hostInfo: HOST_INFO,
    onEvent: (event) => events.push(event),
    ...more,
  });

  return { bridge, events };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the tool notifications", () => {
  it("holds tool-input and tool-result until the View says initialized, and sends them in order after", async () => {
    const page = fakePage();
    const { bridge } = make(page);

    bridge.start();
    bridge.toolInputPartial({ a: 1 });
    bridge.toolInput({ a: 1, b: 2 });
    bridge.toolResult({ content: [{ type: "text", text: "ok" }], structuredContent: { x: 1 } });

    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    page.deliver(
      rpc(
        "ui/initialize",
        {
          appInfo: { name: "v", version: "1" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        },
        1,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    // Not before `initialized`.
    expect(methodsOf(page)).toEqual(["ui/notifications/sandbox-resource-ready"]);

    page.deliver(rpc("ui/notifications/initialized"));

    expect(methodsOf(page)).toEqual([
      "ui/notifications/sandbox-resource-ready",
      "ui/notifications/tool-input-partial",
      "ui/notifications/tool-input",
      "ui/notifications/tool-result",
    ]);
    expect(page.posts.at(-2)?.data["params"]).toEqual({ arguments: { a: 1, b: 2 } });
    expect(page.posts.at(-1)?.data["params"]).toEqual({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { x: 1 },
    });

    // And at once afterwards.
    bridge.toolCancelled("Stopped");
    bridge.hostContextChanged({ theme: "dark" });
    expect(page.posts.at(-2)?.data).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-cancelled",
      params: { reason: "Stopped" },
    });
    expect(page.posts.at(-1)?.data).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark" },
    });
  });
});

describe("retire", () => {
  const ready = async () => {
    const page = fakePage();
    const made = make(page);

    made.bridge.start();
    handshake(page);
    await vi.advanceTimersByTimeAsync(0);
    page.posts.length = 0;

    return { page, ...made };
  };

  it("retires a View of an unfinished call with tool-cancelled first, then the teardown, in that order", async () => {
    const { page, bridge } = await ready();
    const retiring = retire(bridge, "evicted");

    expect(methodsOf(page)).toEqual(["ui/notifications/tool-cancelled", "ui/resource-teardown"]);
    expect(page.posts[0]?.data["params"]).toEqual({ reason: "evicted" });
    page.deliver({ jsonrpc: "2.0", id: page.posts[1]?.data["id"], result: {} });
    await retiring;
  });

  it("retires a finished call's View with the teardown alone", async () => {
    const { page, bridge } = await ready();
    const retiring = retire(bridge);

    expect(methodsOf(page)).toEqual(["ui/resource-teardown"]);
    page.deliver({ jsonrpc: "2.0", id: page.posts[0]?.data["id"], result: {} });
    await retiring;
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The real ext-apps runtime as the View.

/** The package's `App` with its dependencies bundled: what the example Views ship, evaluated as it is. */
const loadExtApps = () => {
  const text = readFileSync(
    new URL(
      "../../node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js",
      import.meta.url,
    ),
    "utf8",
  );

  const exported = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(text);

  if (exported === null) throw new Error("ext-apps' bundle no longer ends in one export list");

  const names = (exported[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [local, alias] = entry.split(/\s+as\s+/);

      return `${JSON.stringify(alias ?? local)}: ${local}`;
    });

  const body = `${text.slice(0, exported.index)}\nreturn { ${names.join(", ")} };`;

  return (win: unknown, doc: unknown, extras: Record<string, unknown>) =>
    // SAFETY: the bundle's exports, by name.
    new Function(
      "window",
      "document",
      "requestAnimationFrame",
      "ResizeObserver",
      "navigator",
      body,
    )(win, doc, extras["requestAnimationFrame"], extras["ResizeObserver"], extras["navigator"]) as {
      App: new (
        info: { name: string; version: string },
        capabilities?: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => AppLike;
      PostMessageTransport: new (target: unknown, source: unknown) => unknown;
      LATEST_PROTOCOL_VERSION: string;
    };
};

interface AppLike {
  ontoolinput: ((params: { arguments?: Record<string, unknown> }) => void) | undefined;
  ontoolinputpartial: ((params: { arguments?: Record<string, unknown> }) => void) | undefined;
  ontoolresult: ((result: Record<string, unknown>) => void) | undefined;
  ontoolcancelled: ((params: { reason?: string }) => void) | undefined;
  onhostcontextchanged: ((context: Record<string, unknown>) => void) | undefined;
  onteardown: (() => Promise<Record<string, unknown>>) | undefined;
  onerror: ((error: unknown) => void) | undefined;
  connect: (transport: unknown) => Promise<void>;
  getHostContext: () => Record<string, unknown> | undefined;
  getHostCapabilities: () => Record<string, unknown> | undefined;
  getHostVersion: () => { name: string; version: string } | undefined;
  sendLog: (params: { level: string; data: unknown }) => Promise<void>;
  openLink: (params: { url: string }) => Promise<unknown>;
  sendMessage: (params: unknown) => Promise<unknown>;
  updateModelContext: (params: unknown) => Promise<unknown>;
  callServerTool: (params: { name: string }) => Promise<unknown>;
}

/**
 * A View window (the inner iframe) behind a proxy that relays as the real one does (`apps/app-sandbox/src/proxy.ts`): the
 * page's posts to the proxy frame go to the View at the sandbox's origin, and the View's to its parent reach the page from
 * the proxy frame at the sandbox's origin.
 */
const relayed = async () => {
  const page = fakePage();

  const viewListeners = new Set<
    (event: { source: unknown; origin: string; data: unknown }) => void
  >();

  const frames: ((callback: () => void) => void)[] = [];
  const observers: (() => void)[] = [];
  const viewParent = { postMessage: (data: unknown) => queueMicrotask(() => page.deliver(data)) };

  const viewWindow = {
    parent: viewParent,
    innerWidth: 600,
    addEventListener: (
      type: string,
      listener: (event: { source: unknown; origin: string; data: unknown }) => void,
    ) => {
      if (type === "message") viewListeners.add(listener);
    },
    removeEventListener: (
      type: string,
      listener: (event: { source: unknown; origin: string; data: unknown }) => void,
    ) => {
      if (type === "message") viewListeners.delete(listener);
    },
  };

  // The page's posts to the proxy frame reach the View.
  const toView = (data: unknown, target: string) => {
    expect(target).toBe(ORIGIN);
    queueMicrotask(() => {
      for (const listener of Array.from(viewListeners))
        listener({ source: viewParent, origin: ORIGIN, data });
    });
  };

  // The page's frame relays what the bridge posts, but not the sandbox-resource-ready the proxy keeps for itself.
  const originalPost = page.frame.postMessage;

  page.frame.postMessage = (data: unknown, target: string) => {
    originalPost(data, target);

    if ((data as { method?: string }).method !== "ui/notifications/sandbox-resource-ready")
      toView(data, target);
  };

  const heights = [210, 480];

  const documentElement = {
    style: { height: "" },
    getBoundingClientRect: () => ({ height: heights.shift() ?? 480 }),
  };

  const runtime = loadExtApps()(
    viewWindow,
    { documentElement, body: {} },
    {
      requestAnimationFrame: (callback: () => void) => {
        frames.push(callback);
      },
      ResizeObserver: class {
        constructor(callback: () => void) {
          observers.push(callback);
        }

        observe() {}

        disconnect() {}
      },
      navigator: {},
    },
  );

  const app = new runtime.App({ name: "Example View", version: "1.0.0" });

  return { page, app, runtime, viewWindow, frames, observers, viewParent };
};

describe("an ext-apps View (the real `App` runtime)", () => {
  /** Mount the View as the card does: start the bridge, let the proxy announce itself, and connect the View in it. */
  const mounted = async (more: Partial<BridgeOptions> = {}) => {
    const view = await relayed();
    const made = make(view.page, more);

    const handlers = {
      input: vi.fn(),
      partial: vi.fn(),
      result: vi.fn(),
      cancelled: vi.fn(),
      changed: vi.fn(),
      teardown: vi.fn(() => Promise.resolve({})),
    };

    view.app.ontoolinput = handlers.input;
    view.app.ontoolinputpartial = handlers.partial;
    view.app.ontoolresult = handlers.result;
    view.app.ontoolcancelled = handlers.cancelled;
    view.app.onhostcontextchanged = handlers.changed;
    view.app.onteardown = handlers.teardown;
    view.app.onerror = () => undefined;

    made.bridge.start();

    // The proxy announces itself, and the page gives it the HTML: the View, loaded in it, then connects.
    view.page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));

    const connecting = view.app.connect(
      new view.runtime.PostMessageTransport(view.viewParent, view.viewParent),
    );

    await vi.advanceTimersByTimeAsync(0);
    await connecting;
    await vi.advanceTimersByTimeAsync(0);

    return { ...view, ...made, handlers };
  };

  it("connects, reads the host's context, capabilities and name, and says it is ready", async () => {
    const csp = { connectDomains: ["https://api.example.com"] };

    const { page, app, events, runtime } = await mounted({
      page: { html: HTML, csp },
      capabilities: hostCapabilities(csp),
    });

    expect(page.posts[0]?.data).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/sandbox-resource-ready",
      params: { html: HTML, csp },
    });
    expect(runtime.LATEST_PROTOCOL_VERSION).toBe(MCP_APPS_PROTOCOL_VERSION);
    expect(app.getHostVersion()).toEqual({ name: "cloudpid", version: "1" });
    expect(app.getHostCapabilities()).toEqual(hostCapabilities(csp));
    expect(app.getHostContext()).toMatchObject({
      theme: "light",
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
      platform: "web",
      locale: "en-US",
      timeZone: "UTC",
      toolInfo: { id: "call-1", tool: { name: "get-time", title: "Get time" } },
      containerDimensions: { width: 600, maxHeight: 448 },
      styles: {
        variables: {
          "--color-background-primary": "oklch(1 0 0)",
          "--font-sans": expect.any(String),
        },
      },
    });
    expect(events).toEqual([{ type: "ready" }]);

    for (const post of page.posts) expect(post.target).toBe(ORIGIN);
  });

  it("gets tool-input, tool-result, tool-cancelled and host-context-changed, and the partial input before the final one", async () => {
    const { bridge, handlers } = await mounted();

    bridge.toolInputPartial({ city: "Os" });
    bridge.toolInput({ city: "Oslo" });
    bridge.toolResult({
      content: [{ type: "text", text: "12 C" }],
      structuredContent: { temp: 12 },
      isError: false,
    });
    bridge.toolCancelled("Stopped");
    bridge.hostContextChanged({ theme: "dark" });
    await vi.advanceTimersByTimeAsync(0);

    expect(handlers.partial).toHaveBeenCalledWith({ arguments: { city: "Os" } });
    expect(handlers.input).toHaveBeenCalledWith({ arguments: { city: "Oslo" } });
    expect(handlers.result).toHaveBeenCalledWith({
      content: [{ type: "text", text: "12 C" }],
      structuredContent: { temp: 12 },
      isError: false,
    });
    expect(handlers.cancelled).toHaveBeenCalledWith({ reason: "Stopped" });
    expect(handlers.changed).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("holds only the latest partial input until the View is ready, sends none after the final one, and cancels once", async () => {
    const page = fakePage();
    const { bridge } = make(page);

    bridge.start();
    bridge.toolInputPartial({ city: "O" });
    bridge.toolInputPartial({ city: "Os" });
    bridge.toolInputPartial({ city: "Osl" });

    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    page.deliver(
      rpc(
        "ui/initialize",
        {
          appInfo: { name: "v", version: "1" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        },
        1,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    page.deliver(rpc("ui/notifications/initialized"));

    // Ready: one partial, the latest; then more as the call goes on, until the final input.
    bridge.toolInputPartial({ city: "Oslo, N" });
    bridge.toolInput({ city: "Oslo, Norway" });
    bridge.toolInputPartial({ city: "late" });
    bridge.toolInput({ city: "again" });
    bridge.toolCancelled("Stopped");
    bridge.toolCancelled("Stopped");

    expect(
      page.posts.flatMap((post) =>
        post.data["method"] === undefined ? [] : [[post.data["method"], post.data["params"]]],
      ),
    ).toEqual([
      ["ui/notifications/sandbox-resource-ready", { html: HTML }],
      ["ui/notifications/tool-input-partial", { arguments: { city: "Osl" } }],
      ["ui/notifications/tool-input-partial", { arguments: { city: "Oslo, N" } }],
      ["ui/notifications/tool-input", { arguments: { city: "Oslo, Norway" } }],
      ["ui/notifications/tool-cancelled", { reason: "Stopped" }],
    ]);
  });

  it("sends nothing of the call after tool-cancelled: it is the end of it", async () => {
    const { bridge, handlers } = await mounted();

    bridge.toolInputPartial({ city: "O" });
    bridge.toolCancelled("Stopped");
    bridge.toolInput({ city: "Oslo" });
    bridge.toolResult({ content: [{ type: "text", text: "12 C" }] });
    await vi.advanceTimersByTimeAsync(0);

    expect(handlers.partial).toHaveBeenCalledTimes(1);
    expect(handlers.cancelled).toHaveBeenCalledWith({ reason: "Stopped" });
    expect(handlers.input).not.toHaveBeenCalled();
    expect(handlers.result).not.toHaveBeenCalled();
  });

  it("delivers an error result too, as the View's own", async () => {
    const { bridge, handlers } = await mounted();

    bridge.toolResult({ content: [{ type: "text", text: "nope" }], isError: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(handlers.result).toHaveBeenCalledWith({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
  });

  it("is told to tear down, answers, and is closed", async () => {
    const { bridge, handlers, page } = await mounted();
    const tearing = bridge.teardown();

    await vi.advanceTimersByTimeAsync(0);
    await tearing;

    expect(handlers.teardown).toHaveBeenCalledTimes(1);
    expect(page.listeners.size).toBe(0);
  });

  it("reports its size as it grows, which the card follows", async () => {
    const { frames, events, observers } = await mounted();

    // The runtime measured when it connected; let its frame run, then a resize.
    for (const frame of frames.splice(0)) frame(undefined as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(events.find((event) => event.type === "size")).toEqual({
      type: "size",
      width: 600,
      height: 210,
    });

    for (const observer of observers) observer();

    for (const frame of frames.splice(0)) frame(undefined as never);

    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((event) => event.type === "size")).toEqual([
      { type: "size", width: 600, height: 210 },
      { type: "size", width: 600, height: 480 },
    ]);
  });

  it("passes the permissions a View declared with its page, and advertises the clipboard it grants", async () => {
    const permissions = { clipboardWrite: {} };

    const { page, app } = await mounted({
      page: { html: HTML, permissions },
      capabilities: hostCapabilities(undefined, false, false, { clipboardWrite: true }),
    });

    expect(page.posts[0]?.data["params"]).toEqual({ html: HTML, permissions });
    expect(app.getHostCapabilities()).toMatchObject({
      sandbox: { permissions: { clipboardWrite: {} } },
    });
  });

  it("serves ui/open-link, ui/message and ui/update-model-context through its handlers, as the runtime's own calls", async () => {
    const calls: Array<readonly [string, unknown]> = [];

    const { app } = await mounted({
      capabilities: hostCapabilities(undefined, false, false, {
        openLinks: true,
        message: true,
        updateModelContext: true,
      }),
      handlers: {
        "ui/open-link": (params) => {
          calls.push(["open", params]);

          return Promise.resolve({});
        },
        "ui/message": (params) => {
          calls.push(["message", params]);

          return Promise.resolve({});
        },
        "ui/update-model-context": (params) => {
          calls.push(["context", params]);

          return Promise.resolve({});
        },
      },
    });

    expect(app.getHostCapabilities()).toMatchObject({
      openLinks: {},
      message: { text: {} },
      updateModelContext: { text: {} },
    });

    await expect(app.openLink({ url: "https://modelcontextprotocol.io/" })).resolves.toEqual({});
    await expect(
      app.sendMessage({ role: "user", content: [{ type: "text", text: "hi" }] }),
    ).resolves.toEqual({});
    await expect(
      app.updateModelContext({ content: [{ type: "text", text: "row 3" }] }),
    ).resolves.toEqual({});

    expect(calls).toEqual([
      ["open", { url: "https://modelcontextprotocol.io/" }],
      ["message", { role: "user", content: [{ type: "text", text: "hi" }] }],
      ["context", { content: [{ type: "text", text: "row 3" }] }],
    ]);
  });

  it("is answered -32601 for what is not served, and its logging is dropped", async () => {
    const { app, events } = await mounted();

    await app.sendLog({ level: "info", data: "hello" });

    await expect(app.openLink({ url: "https://modelcontextprotocol.io/" })).rejects.toThrow(
      /Method not found/,
    );
    await expect(app.updateModelContext({ content: [] })).rejects.toThrow(/Method not found/);
    await expect(app.callServerTool({ name: "get-time" })).rejects.toThrow(/Method not found/);
    await expect(
      app.sendMessage({ role: "user", content: [{ type: "text", text: "hi" }] }),
    ).rejects.toThrow(/Method not found/);

    expect(events.filter((event) => event.type === "failed")).toEqual([]);
  });

  it("is never reached by a page that is not the proxy's: its tool-input is dropped, and so is a forged reply", async () => {
    const { bridge, handlers, page } = await mounted();

    // Another window cannot make the host talk to the View either: the bridge posts only to the proxy frame.
    expect(page.posts.every((post) => post.target === ORIGIN)).toBe(true);
    bridge.close();
    bridge.toolInput({ late: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(handlers.input).not.toHaveBeenCalledWith({ arguments: { late: true } });
  });
});
