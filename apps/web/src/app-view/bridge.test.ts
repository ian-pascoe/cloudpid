// docs/architecture/mcp-apps.md → The bridge, Testing. The bridge against a fake iframe: the handshake, the notifications
// and the origin checks, then the real ext-apps `App` (the runtime every example View bundles, read from the package and
// run unmodified in a fake window) as the View on the other side of a relaying proxy.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/require-safety-comment-for-type-assertion, typescript/no-implied-eval -- fakes of the browser's windows and of JSON-RPC traffic: their data is whatever a case posts, a View's runtime is evaluated from the package as a function of its window (`new Function`, the only way to run it here), and the casts are cut down to a case's shape */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off nodeBuiltinImport:off globalTimers:off newPromise:off -- fakes of the browser's windows and timers.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIALIZE_TIMEOUT_MS,
  MCP_APPS_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  RpcError,
  retire,
  TEARDOWN_TIMEOUT_MS,
  createBridge,
  type BridgeEvent,
  type BridgeOptions,
  type IncomingMessage,
} from "./bridge.ts";
import {
  HOST_INFO,
  hostCapabilities,
  hostContextOf,
  type HostEnvironment,
} from "./host-context.ts";

const ORIGIN = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";
const EVIL = "https://evil.example";

type Post = { readonly data: Record<string, unknown>; readonly target: string };

/** The page's window and the proxy frame in it, as the bridge sees them. */
const fakePage = () => {
  const listeners = new Set<(message: IncomingMessage) => void>();
  const posts: Post[] = [];

  const frame = {
    postMessage: (data: unknown, target: string) => {
      // SAFETY: the bridge posts JSON-RPC objects.
      posts.push({ data: data as Record<string, unknown>, target });
    },
  };

  const other = { postMessage: () => undefined };

  return {
    listeners,
    posts,
    frame,
    other,
    listen: (handler: (message: IncomingMessage) => void) => {
      listeners.add(handler);

      return () => listeners.delete(handler);
    },
    /** A message event of the page's window. */
    deliver: (data: unknown, from: { source?: unknown; origin?: string } = {}) => {
      for (const listener of Array.from(listeners)) {
        listener({
          source: "source" in from ? from.source : frame,
          origin: from.origin ?? ORIGIN,
          data,
        });
      }
    },
  };
};

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

const rpc = (method: string, params: unknown = {}, id?: number) => {
  const message: Record<string, unknown> = { jsonrpc: "2.0", method, params };

  if (id !== undefined) message["id"] = id;

  return message;
};

const HTML = "<main>view</main>";

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

const sent = (page: ReturnType<typeof fakePage>) => page.posts.map((post) => post.data);

const methodsOf = (page: ReturnType<typeof fakePage>) =>
  page.posts.flatMap((post) =>
    typeof post.data["method"] === "string" ? [post.data["method"]] : [],
  );

/** Drive the View's side of the handshake by hand. */
const handshake = (page: ReturnType<typeof fakePage>) => {
  page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
  page.deliver(
    rpc(
      "ui/initialize",
      {
        appInfo: { name: "view", version: "1" },
        appCapabilities: {},
        protocolVersion: MCP_APPS_PROTOCOL_VERSION,
      },
      1,
    ),
  );
  page.deliver(rpc("ui/notifications/initialized"));
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the handshake", () => {
  it("gives the proxy its page when it announces itself, and answers ui/initialize with the host's capabilities and context", async () => {
    const page = fakePage();
    const { bridge, events } = make(page);

    bridge.start();
    expect(page.posts).toEqual([]);

    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));

    expect(sent(page)).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: HTML } },
    ]);

    page.deliver(
      rpc(
        "ui/initialize",
        {
          appInfo: { name: "view", version: "1" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        },
        7,
      ),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(page.posts[1]?.data).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "cloudpid", version: "1" },
        hostCapabilities: { sandbox: {} },
        hostContext: context,
      },
    });
    expect(events).toEqual([]);

    page.deliver(rpc("ui/notifications/initialized"));
    expect(events).toEqual([{ type: "ready" }]);
  });

  it("sends the declared CSP with the page, and posts only to the sandbox origin, never to *", async () => {
    const page = fakePage();
    const csp = { connectDomains: ["https://api.example.com"] };

    const { bridge } = make(page, {
      page: { html: HTML, csp },
      capabilities: hostCapabilities(csp),
    });

    bridge.start();
    handshake(page);
    bridge.toolInput({ a: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(page.posts[0]?.data["params"]).toEqual({ html: HTML, csp });
    expect(page.posts.length).toBeGreaterThan(2);

    for (const post of page.posts) expect(post.target).toBe(ORIGIN);
  });

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

  it("ignores a second proxy-ready, so the page is given once", () => {
    const page = fakePage();
    const { bridge } = make(page);

    bridge.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    expect(page.posts).toHaveLength(1);
  });

  it("does not take initialized as the handshake until ui/initialize was asked and answered", () => {
    const page = fakePage();
    const { bridge, events } = make(page);

    bridge.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    page.deliver(rpc("ui/notifications/initialized"));
    expect(events).toEqual([]);
  });

  it("fails when the View sends no ui/initialize within 10 s, and not once it has", async () => {
    const page = fakePage();
    const quiet = make(page);

    quiet.bridge.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS - 1);
    expect(quiet.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(quiet.events).toEqual([
      { type: "failed", reason: "The App did not start within 10 seconds" },
    ]);

    const page2 = fakePage();
    const noProxy = make(page2);

    noProxy.bridge.start();
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS);
    expect(noProxy.events).toEqual([
      { type: "failed", reason: "The App sandbox did not answer within 10 seconds" },
    ]);

    const page3 = fakePage();
    const fine = make(page3);

    fine.bridge.start();
    handshake(page3);
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS * 2);
    expect(fine.events).toEqual([{ type: "ready" }]);
  });
});

describe("the origin checks", () => {
  const unlistened = (page: ReturnType<typeof fakePage>, events: BridgeEvent[]) => {
    expect(page.posts).toEqual([]);
    expect(events.every((event) => event.type === "rejected")).toBe(true);
  };

  it.each([
    ["another origin", { origin: EVIL }],
    [
      "the sandbox's origin on another stage's host",
      { origin: "https://bbbbbbbbbbbbbbbbbbbbbbbbbb.ianpascoe.app" },
    ],
    ["the opaque origin", { origin: "null" }],
    ["the app's own origin", { origin: "https://pi.ianpascoe.dev" }],
    ["http at the sandbox's host", { origin: ORIGIN.replace("https", "http") }],
    ["a trailing slash", { origin: `${ORIGIN}/` }],
  ])("drops a proxy-ready from %s, and gives it no page", (_name, from) => {
    const page = fakePage();
    const { bridge, events } = make(page);

    bridge.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"), from);
    unlistened(page, events);
  });

  it("drops a message from another window at the sandbox's origin", () => {
    const page = fakePage();
    const { bridge, events } = make(page);

    bridge.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"), { source: page.other });
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"), { source: null });
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"), {
      source: {},
    });
    unlistened(page, events);
  });

  it("answers nothing from a forged View: another origin, or another window, in the middle of a real handshake", () => {
    const page = fakePage();
    const { bridge, events } = make(page);

    bridge.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));

    const before = page.posts.length;

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
      { origin: EVIL },
    );
    page.deliver(
      rpc(
        "ui/initialize",
        {
          appInfo: { name: "v", version: "1" },
          appCapabilities: {},
          protocolVersion: "2026-01-26",
        },
        2,
      ),
      { source: page.other },
    );
    page.deliver(rpc("ui/notifications/initialized"), { origin: EVIL });
    page.deliver(rpc("ui/notifications/size-changed", { height: 99 }), { origin: EVIL });

    expect(page.posts).toHaveLength(before);
    expect(events.filter((event) => event.type !== "rejected")).toEqual([]);
    expect(events).toHaveLength(4);
  });

  it("drops what is not a JSON-RPC message, and anything of the View's before the proxy was ready", () => {
    const page = fakePage();
    const { bridge, events } = make(page);

    bridge.start();

    for (const data of [
      "hi",
      null,
      7,
      [],
      { method: "ui/initialize" },
      { jsonrpc: "1.0", method: "x" },
      { jsonrpc: "2.0" },
    ]) {
      page.deliver(data);
    }

    page.deliver(rpc("ui/initialize", { protocolVersion: "2026-01-26" }, 1));
    expect(page.posts).toEqual([]);
    expect(events.every((event) => event.type === "rejected")).toBe(true);
  });

  it("stops listening when closed, and posts nothing after it", async () => {
    const page = fakePage();
    const { bridge } = make(page);

    bridge.start();
    expect(page.listeners.size).toBe(1);
    bridge.close();
    expect(page.listeners.size).toBe(0);

    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    bridge.toolInput({});
    await bridge.teardown();
    expect(page.posts).toEqual([]);
  });
});

describe("a View's requests", () => {
  const ready = async (more: Partial<BridgeOptions> = {}) => {
    const page = fakePage();
    const made = make(page, more);

    made.bridge.start();
    handshake(page);
    await vi.advanceTimersByTimeAsync(0);
    page.posts.length = 0;

    return { page, ...made };
  };

  it("answers -32601 for every method it does not serve, the draft-only and later ones included", async () => {
    const { page } = await ready();

    for (const method of [
      "tools/call",
      "resources/read",
      "ui/open-link",
      "ui/message",
      "ui/update-model-context",
      "ui/download-file",
      "sampling/createMessage",
      "ui/request-teardown",
      "nope",
      // Properties every object has, which a View may name: they are no handlers.
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      page.deliver(rpc(method, {}, 40));
      await vi.advanceTimersByTimeAsync(0);
      expect(page.posts.pop()?.data).toEqual({
        jsonrpc: "2.0",
        id: 40,
        error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` },
      });
    }
  });

  it("does not take an inherited property of its handlers for one", async () => {
    const { page } = await ready({ handlers: {} });

    for (const method of ["constructor", "toString", "__proto__"]) {
      page.deliver(rpc(method, {}, 41));
      await vi.advanceTimersByTimeAsync(0);
      expect(page.posts.pop()?.data).toMatchObject({ id: 41, error: { code: METHOD_NOT_FOUND } });
    }
  });

  it("answers ping, and a display mode request with the mode that is set (inline: fullscreen and pip are refused)", async () => {
    const { page } = await ready();

    page.deliver(rpc("ping", {}, 1));
    page.deliver(rpc("ui/request-display-mode", { mode: "fullscreen" }, 2));
    page.deliver(rpc("ui/request-display-mode", { mode: "pip" }, 3));
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(page)).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: { mode: "inline" } },
      { jsonrpc: "2.0", id: 3, result: { mode: "inline" } },
    ]);
  });

  it("serves a method through the handler it was given, and answers a refusal with its code", async () => {
    const { page } = await ready({
      handlers: {
        "ui/open-link": () => Promise.resolve({ isError: false }),
        "ui/message": () => Promise.reject(new RpcError(-32_000, "no")),
        "ui/update-model-context": () => Promise.reject(new Error("boom")),
      },
    });

    page.deliver(rpc("ui/open-link", {}, 1));
    page.deliver(rpc("ui/message", {}, 2));
    page.deliver(rpc("ui/update-model-context", {}, 3));
    await vi.advanceTimersByTimeAsync(0);

    expect(sent(page)).toEqual([
      { jsonrpc: "2.0", id: 1, result: { isError: false } },
      { jsonrpc: "2.0", id: 2, error: { code: -32_000, message: "no" } },
      { jsonrpc: "2.0", id: 3, error: { code: -32_603, message: "The host could not answer" } },
    ]);
  });

  it("tells its owner the size a View reports, whichever of width and height it sends", async () => {
    const { page, events } = await ready();

    page.deliver(rpc("ui/notifications/size-changed", { width: 500, height: 321 }));
    page.deliver(rpc("ui/notifications/size-changed", { height: 12 }));
    page.deliver(rpc("ui/notifications/size-changed", { height: "tall" }));
    expect(events.filter((event) => event.type === "size")).toEqual([
      { type: "size", width: 500, height: 321 },
      { type: "size", height: 12 },
    ]);
  });

  it("drops a notification it does not serve, such as the View's logging", async () => {
    const { page, events } = await ready();

    page.deliver(rpc("notifications/message", { level: "info", data: "hi" }));
    expect(page.posts).toEqual([]);
    expect(events).toEqual([{ type: "ready" }]);
  });
});

describe("teardown", () => {
  const ready = async (more: Partial<BridgeOptions> = {}) => {
    const page = fakePage();
    const made = make(page, more);

    made.bridge.start();
    handshake(page);
    await vi.advanceTimersByTimeAsync(0);
    page.posts.length = 0;

    return { page, ...made };
  };

  it("sends ui/resource-teardown and resolves when the View answers, then closes", async () => {
    const { page, bridge } = await ready();
    let done = false;

    const tearing = bridge.teardown().then(() => {
      done = true;
    });

    expect(page.posts).toHaveLength(1);
    expect(page.posts[0]?.data).toMatchObject({
      jsonrpc: "2.0",
      method: "ui/resource-teardown",
      params: {},
    });
    expect(page.posts[0]?.target).toBe(ORIGIN);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);

    page.deliver({ jsonrpc: "2.0", id: page.posts[0]?.data["id"], result: {} });
    await tearing;
    expect(done).toBe(true);
    expect(page.listeners.size).toBe(0);
  });

  it("sends one teardown however often it is asked, and every asker waits for its answer", async () => {
    const { page, bridge } = await ready();
    const first = bridge.teardown();
    const second = bridge.teardown();

    expect(methodsOf(page)).toEqual(["ui/resource-teardown"]);
    page.deliver({ jsonrpc: "2.0", id: page.posts[0]?.data["id"], result: {} });
    await Promise.all([first, second]);
  });

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

  it("waits at most 2 s for a View that does not answer", async () => {
    const { page, bridge } = await ready();
    let done = false;

    const tearing = bridge.teardown().then(() => {
      done = true;
    });

    await vi.advanceTimersByTimeAsync(TEARDOWN_TIMEOUT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await tearing;
    expect(done).toBe(true);
    expect(page.listeners.size).toBe(0);
  });

  it("does not take an answer from another origin or window for the View's", async () => {
    const { page, bridge } = await ready();
    let done = false;

    const tearing = bridge.teardown().then(() => {
      done = true;
    });

    const id = page.posts[0]?.data["id"];

    page.deliver({ jsonrpc: "2.0", id, result: {} }, { origin: EVIL });
    page.deliver({ jsonrpc: "2.0", id, result: {} }, { source: page.other });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);

    await vi.advanceTimersByTimeAsync(TEARDOWN_TIMEOUT_MS);
    await tearing;
  });

  it("aborts the requests in flight when it closes", async () => {
    let signal: AbortSignal | undefined;

    const { page, bridge } = await ready({
      handlers: {
        "tools/call": (_params, context) => {
          signal = context.signal;

          return new Promise(() => undefined);
        },
      },
    });

    page.deliver(rpc("tools/call", {}, 9));
    expect(signal?.aborted).toBe(false);

    const tearing = bridge.teardown();

    page.deliver({ jsonrpc: "2.0", id: page.posts[0]?.data["id"], result: {} });
    await tearing;
    expect(signal?.aborted).toBe(true);
  });

  it("closes at once for a View that never came up, with nothing to tell", async () => {
    const page = fakePage();
    const { bridge } = make(page);

    bridge.start();
    await bridge.teardown();
    expect(page.posts).toEqual([]);
    expect(page.listeners.size).toBe(0);
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
    expect(app.getHostCapabilities()).toEqual({ sandbox: { csp } });
    expect(app.getHostContext()).toMatchObject({
      theme: "light",
      displayMode: "inline",
      availableDisplayModes: ["inline"],
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

  it("is answered -32601 for what is not served yet, and its logging is dropped", async () => {
    const { app, events } = await mounted();

    await app.sendLog({ level: "info", data: "hello" });

    await expect(app.openLink({ url: "https://modelcontextprotocol.io/" })).rejects.toThrow(
      /Method not found/,
    );
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
