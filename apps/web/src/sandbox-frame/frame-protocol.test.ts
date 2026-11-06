// docs/architecture/visuals.md → The frame; docs/architecture/mcp-apps.md → The bridge, Testing. The frame protocol that App Views
// and Visuals share, against a fake iframe: the handshake, the origin checks, a View's requests and the handlers that serve
// them, the notifications held until the View is ready, and the teardown.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- fakes of the browser's windows and of JSON-RPC traffic: their data is whatever a case posts */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off nodeBuiltinImport:off globalTimers:off newPromise:off -- fakes of the browser's windows and timers.
import { MCP_APP_METHOD_NOT_FOUND } from "@cloudpid/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVIL,
  HTML,
  ORIGIN,
  fakePage,
  handshake,
  methodsOf,
  rpc,
  sent,
} from "./fake-page.testing.ts";
import {
  createFrameProtocol,
  INITIALIZE_TIMEOUT_MS,
  RpcError,
  TEARDOWN_TIMEOUT_MS,
  type FrameEvent,
  type FrameOptions,
} from "./frame-protocol.ts";

const context = { theme: "light", displayMode: "inline" } as const;

const make = (page: ReturnType<typeof fakePage>, more: Partial<FrameOptions> = {}) => {
  const events: FrameEvent[] = [];

  const protocol = createFrameProtocol({
    frame: page.frame,
    origin: ORIGIN,
    listen: page.listen,
    page: { html: HTML },
    hostContext: () => context,
    capabilities: { sandbox: {} },
    hostInfo: { name: "cloudpid", version: "1" },
    onEvent: (event) => events.push(event),
    ...more,
  });

  return { protocol, events };
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
    const { protocol, events } = make(page);

    protocol.start();
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

    const { protocol } = make(page, {
      page: { html: HTML, csp },
      capabilities: { sandbox: { csp } },
    });

    protocol.start();
    handshake(page);
    protocol.send("ui/notifications/tool-input", { a: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(page.posts[0]?.data["params"]).toEqual({ html: HTML, csp });
    expect(page.posts.length).toBeGreaterThan(2);

    for (const post of page.posts) expect(post.target).toBe(ORIGIN);
  });

  it("holds what it is told to send until the View says initialized, sends it in order after and at once afterwards, and only the latest of a method asked for", async () => {
    const page = fakePage();
    const { protocol } = make(page);

    protocol.start();
    protocol.send("ui/notifications/tool-input-partial", { arguments: { a: 1 } }, { latest: true });
    protocol.send(
      "ui/notifications/tool-input-partial",
      { arguments: { a: 1, b: 2 } },
      { latest: true },
    );
    protocol.send("ui/notifications/tool-input", { arguments: { a: 1, b: 2 } });

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
    ]);
    expect(page.posts.at(-2)?.data["params"]).toEqual({ arguments: { a: 1, b: 2 } });

    // And at once afterwards.
    protocol.hostContextChanged({ theme: "dark" });
    expect(page.posts.at(-1)?.data).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark" },
    });
  });

  it("ignores a second proxy-ready, so the page is given once", () => {
    const page = fakePage();
    const { protocol } = make(page);

    protocol.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    expect(page.posts).toHaveLength(1);
  });

  it("does not take initialized as the handshake until ui/initialize was asked and answered", () => {
    const page = fakePage();
    const { protocol, events } = make(page);

    protocol.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    page.deliver(rpc("ui/notifications/initialized"));
    expect(events).toEqual([]);
  });

  it("fails when the View sends no ui/initialize within 10 s, and not once it has", async () => {
    const page = fakePage();
    const quiet = make(page);

    quiet.protocol.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS - 1);
    expect(quiet.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(quiet.events).toEqual([
      { type: "failed", reason: "The App did not start within 10 seconds" },
    ]);

    const page2 = fakePage();
    const noProxy = make(page2);

    noProxy.protocol.start();
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS);
    expect(noProxy.events).toEqual([
      { type: "failed", reason: "The App sandbox did not answer within 10 seconds" },
    ]);

    const page3 = fakePage();
    const fine = make(page3);

    fine.protocol.start();
    handshake(page3);
    await vi.advanceTimersByTimeAsync(INITIALIZE_TIMEOUT_MS * 2);
    expect(fine.events).toEqual([{ type: "ready" }]);
  });
});

describe("the origin checks", () => {
  const unlistened = (page: ReturnType<typeof fakePage>, events: FrameEvent[]) => {
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
    const { protocol, events } = make(page);

    protocol.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"), from);
    unlistened(page, events);
  });

  it("drops a message from another window at the sandbox's origin", () => {
    const page = fakePage();
    const { protocol, events } = make(page);

    protocol.start();
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"), { source: page.other });
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"), { source: null });
    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"), {
      source: {},
    });
    unlistened(page, events);
  });

  it("answers nothing from a forged View: another origin, or another window, in the middle of a real handshake", () => {
    const page = fakePage();
    const { protocol, events } = make(page);

    protocol.start();
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
    const { protocol, events } = make(page);

    protocol.start();

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
    const { protocol } = make(page);

    protocol.start();
    expect(page.listeners.size).toBe(1);
    protocol.close();
    expect(page.listeners.size).toBe(0);

    page.deliver(rpc("ui/notifications/sandbox-proxy-ready"));
    protocol.send("ui/notifications/tool-input", {});
    await protocol.teardown();
    expect(page.posts).toEqual([]);
  });
});

describe("a View's requests", () => {
  const ready = async (more: Partial<FrameOptions> = {}) => {
    const page = fakePage();
    const made = make(page, more);

    made.protocol.start();
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
        error: { code: MCP_APP_METHOD_NOT_FOUND, message: `Method not found: ${method}` },
      });
    }
  });

  it("does not take an inherited property of its handlers for one", async () => {
    const { page } = await ready({ handlers: {} });

    for (const method of ["constructor", "toString", "__proto__"]) {
      page.deliver(rpc(method, {}, 41));
      await vi.advanceTimersByTimeAsync(0);
      expect(page.posts.pop()?.data).toMatchObject({
        id: 41,
        error: { code: MCP_APP_METHOD_NOT_FOUND },
      });
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
  const ready = async (more: Partial<FrameOptions> = {}) => {
    const page = fakePage();
    const made = make(page, more);

    made.protocol.start();
    handshake(page);
    await vi.advanceTimersByTimeAsync(0);
    page.posts.length = 0;

    return { page, ...made };
  };

  it("sends ui/resource-teardown and resolves when the View answers, then closes", async () => {
    const { page, protocol } = await ready();
    let done = false;

    const tearing = protocol.teardown().then(() => {
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
    const { page, protocol } = await ready();
    const first = protocol.teardown();
    const second = protocol.teardown();

    expect(methodsOf(page)).toEqual(["ui/resource-teardown"]);
    page.deliver({ jsonrpc: "2.0", id: page.posts[0]?.data["id"], result: {} });
    await Promise.all([first, second]);
  });

  it("waits at most 2 s for a View that does not answer", async () => {
    const { page, protocol } = await ready();
    let done = false;

    const tearing = protocol.teardown().then(() => {
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
    const { page, protocol } = await ready();
    let done = false;

    const tearing = protocol.teardown().then(() => {
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

    const { page, protocol } = await ready({
      handlers: {
        "tools/call": (_params, context) => {
          signal = context.signal;

          return new Promise(() => undefined);
        },
      },
    });

    page.deliver(rpc("tools/call", {}, 9));
    expect(signal?.aborted).toBe(false);

    const tearing = protocol.teardown();

    page.deliver({ jsonrpc: "2.0", id: page.posts[0]?.data["id"], result: {} });
    await tearing;
    expect(signal?.aborted).toBe(true);
  });

  it("closes at once for a View that never came up, with nothing to tell", async () => {
    const page = fakePage();
    const { protocol } = make(page);

    protocol.start();
    await protocol.teardown();
    expect(page.posts).toEqual([]);
    expect(page.listeners.size).toBe(0);
  });
});
