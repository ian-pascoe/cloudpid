// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- assertions over native arrays and records.
import { describe, expect, it, vi } from "vitest";
import { PROXY_JS, proxyPage } from "./proxy.ts";

const HOST = "https://pi.ianpascoe.dev";
const OWN = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";

/** What a JSON-RPC message holds. */
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

interface Message {
  readonly source: Frame | null;
  readonly origin: string;
  readonly data: Json;
}

type Listener = (event: Message) => void;

interface Frame {
  readonly name: string;
  readonly received: { data: Json; target: string }[];
  readonly listeners: Listener[];
  readonly postMessage: (data: Json, target: string) => void;
  readonly addEventListener: (type: string, listener: Listener) => void;
}

/** A frame's window: records what it is sent and what it listens to. */
const frame = (name: string): Frame => {
  const received: { data: Json; target: string }[] = [];
  const listeners: Listener[] = [];

  return {
    name,
    received,
    listeners,
    postMessage: (data, target) => {
      received.push({ data, target });
    },
    addEventListener: (_, listener) => {
      listeners.push(listener);
    },
  };
};

/** The inner iframe element the script makes. */
interface Inner {
  readonly setAttribute: (name: string, value: string) => void;
  contentWindow: Frame | null;
  contentDocument: {
    open: () => void;
    write: (html: string) => void;
    close: () => void;
  } | null;
  srcdoc: string | undefined;
}

interface Options {
  /** `window.top`, which throws a SecurityError when the proxy is isolated, as it is when framed on another site. */
  readonly top?: "isolated" | "readable";
  readonly framed?: boolean;
  readonly metaOrigin?: string | null;
}

/** Runs the script served as `/proxy.js`, as a browser would, in a fake window and document. */
const run = (options: Options = {}) => {
  const { top = "isolated", framed = true, metaOrigin = HOST } = options;
  const parent = frame("parent");
  const win = frame("proxy");

  const innerWindow = frame("inner");
  const writes: string[] = [];
  const attributes = new Map<string, string>();

  const innerDocument = {
    open: () => {
      writes.push("open");
    },
    write: (html: string) => {
      writes.push(html);
    },
    close: () => {
      writes.push("close");
    },
  };

  const created: Inner[] = [];

  const inner: Inner = {
    setAttribute: (name, value) => {
      attributes.set(name, value);
    },
    contentWindow: innerWindow,
    contentDocument: innerDocument,
    srcdoc: undefined,
  };

  // Reading `location` of an isolated top window throws a SecurityError.
  const isolatedTop = {
    get location(): never {
      throw new Error("SecurityError");
    },
  };

  const fakeWindow = {
    self: win,
    parent,
    top: !framed ? win : top === "readable" ? { location: { href: "https://host" } } : isolatedTop,
    addEventListener: win.addEventListener,
  };

  const document = {
    querySelector: () => (metaOrigin === null ? null : { getAttribute: () => metaOrigin }),
    createElement: () => {
      created.push(inner);

      return inner;
    },
    body: { appendChild: vi.fn() },
  };

  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

  // oxlint-disable-next-line typescript/no-implied-eval -- the script is the string the Worker serves; this runs it as the page would.
  new Function("window", "document", "location", "console", PROXY_JS)(
    fakeWindow,
    document,
    { origin: OWN },
    console,
  );

  const send = (message: Message) => {
    for (const listener of win.listeners) listener(message);
  };

  return { parent, win, innerWindow, inner, attributes, writes, created, send, errors, document };
};

describe("proxyPage", () => {
  it("loads /proxy.js as its one script and names the app origin in a meta", () => {
    const page = proxyPage(HOST);

    expect(page).toContain(`<meta name="cloudpid-host-origin" content="${HOST}" />`);
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).toContain('<script src="/proxy.js"></script>');
  });

  it("escapes the origin in the attribute", () => {
    expect(proxyPage('https://a"><script>x</script>&')).toContain(
      'content="https://a&quot;&gt;&lt;script&gt;x&lt;/script&gt;&amp;"',
    );
  });
});

describe("/proxy.js", () => {
  it("announces itself to the app origin only, once", () => {
    const { parent } = run();

    expect(parent.received).toEqual([
      {
        data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} },
        target: HOST,
      },
    ]);
  });

  it("makes one inner frame, sandboxed as the reference does", () => {
    const { attributes, document } = run();

    expect(attributes.get("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    expect(document.body.appendChild).toHaveBeenCalledTimes(1);
  });

  it("does nothing outside a frame", () => {
    const { parent, win, created } = run({ framed: false });

    expect(parent.received).toEqual([]);
    expect(win.listeners).toEqual([]);
    expect(created).toEqual([]);
  });

  it("does nothing where it can read its top window", () => {
    const { parent, win, created } = run({ top: "readable" });

    expect(parent.received).toEqual([]);
    expect(win.listeners).toEqual([]);
    expect(created).toEqual([]);
  });

  it.each([null, ""])("does nothing without an app origin in its page (%j)", (metaOrigin) => {
    const { parent, win } = run({ metaOrigin });

    expect(parent.received).toEqual([]);
    expect(win.listeners).toEqual([]);
  });

  it("loads the HTML of sandbox-resource-ready into the inner frame, and nothing else", () => {
    const { send, parent, writes, innerWindow } = run();
    parent.received.length = 0;

    send({
      source: parent,
      origin: HOST,
      data: { method: "ui/notifications/sandbox-resource-ready", params: { html: "<p>view</p>" } },
    });

    expect(writes).toEqual(["open", "<p>view</p>", "close"]);
    expect(innerWindow.received).toEqual([]);
    expect(parent.received).toEqual([]);
  });

  it("sets the inner frame's sandbox from a string and allow only for clipboard-write", () => {
    const { send, parent, attributes } = run();

    send({
      source: parent,
      origin: HOST,
      data: {
        method: "ui/notifications/sandbox-resource-ready",
        params: {
          html: "x",
          sandbox: "allow-scripts allow-same-origin",
          permissions: { clipboardWrite: {}, camera: {}, microphone: {}, geolocation: {} },
        },
      },
    });

    expect(attributes.get("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(attributes.get("allow")).toBe("clipboard-write");
  });

  it("grants no permission that isn't asked for, and never camera, microphone or geolocation", () => {
    const { send, parent, attributes } = run();

    send({
      source: parent,
      origin: HOST,
      data: {
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: "x", permissions: { camera: {}, microphone: {}, geolocation: {} } },
      },
    });

    expect(attributes.has("allow")).toBe(false);
  });

  it("falls back to srcdoc when the inner document isn't reachable", () => {
    const { send, parent, inner } = run();
    inner.contentDocument = null;

    send({
      source: parent,
      origin: HOST,
      data: { method: "ui/notifications/sandbox-resource-ready", params: { html: "<p>x</p>" } },
    });

    expect(inner.srcdoc).toBe("<p>x</p>");
  });

  it("relays the parent's other messages to the inner frame, as they are", () => {
    const { send, parent, innerWindow } = run();
    const data = { jsonrpc: "2.0", id: 1, result: { ok: true } };

    send({ source: parent, origin: HOST, data });

    expect(innerWindow.received).toEqual([{ data, target: "*" }]);
  });

  it("relays the inner frame's messages to the parent at the app origin, never to *", () => {
    const { send, parent, innerWindow } = run();
    parent.received.length = 0;
    const data = { jsonrpc: "2.0", method: "ui/initialize", id: 1, params: {} };

    send({ source: innerWindow, origin: OWN, data });

    expect(parent.received).toEqual([{ data, target: HOST }]);
  });

  it.each([
    ["another site", "https://evil.example"],
    ["the sandbox's own origin", OWN],
    ["a null origin", "null"],
    ["a prefix of the app origin", "https://pi.ianpascoe.de"],
    ["the app origin with a different port", `${HOST}:8443`],
    ["the app origin over http", "http://pi.ianpascoe.dev"],
  ])("drops a message from the parent frame at %s", (_, origin) => {
    const { send, parent, innerWindow, writes, errors } = run();
    parent.received.length = 0;

    send({
      source: parent,
      origin,
      data: { method: "ui/notifications/sandbox-resource-ready", params: { html: "x" } },
    });
    send({ source: parent, origin, data: { jsonrpc: "2.0", id: 1, method: "ping" } });

    expect(writes).toEqual([]);
    expect(innerWindow.received).toEqual([]);
    expect(parent.received).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });

  it.each([
    ["the app origin", HOST],
    ["another site", "https://evil.example"],
    ["a null origin", "null"],
    ["a sandbox of another View", "https://bbbbbbbbbbbbbbbbbbbbbbbbbb.ianpascoe.app"],
  ])("drops a message from the inner frame at %s", (_, origin) => {
    const { send, parent, innerWindow, errors } = run();
    parent.received.length = 0;

    send({ source: innerWindow, origin, data: { jsonrpc: "2.0", method: "x" } });

    expect(parent.received).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });

  it("drops a message from any other window, whatever its origin", () => {
    const { send, parent, innerWindow, writes } = run();
    parent.received.length = 0;
    const stranger = frame("stranger");

    for (const origin of [HOST, OWN, "https://evil.example"]) {
      send({
        source: stranger,
        origin,
        data: { method: "ui/notifications/sandbox-resource-ready", params: { html: "x" } },
      });
      send({ source: null, origin, data: { jsonrpc: "2.0", method: "x" } });
    }

    expect(writes).toEqual([]);
    expect(parent.received).toEqual([]);
    expect(innerWindow.received).toEqual([]);
  });

  it("drops the inner frame's message when the frame has gone", () => {
    const { send, parent, inner } = run();
    parent.received.length = 0;
    inner.contentWindow = null;

    send({ source: null, origin: OWN, data: { jsonrpc: "2.0", method: "x" } });

    expect(parent.received).toEqual([]);
  });
});
