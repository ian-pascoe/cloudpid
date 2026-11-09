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
  readonly n: number;
  readonly attributes: Map<string, string>;
  readonly window: Frame;
  readonly writes: string[];
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
  /** The inner frame's document can't be reached (the reference's `srcdoc` fallback). */
  readonly unreachableDocument?: boolean;
}

type ReadyParams = {
  readonly html?: string;
  readonly sandbox?: string;
  readonly permissions?: { readonly [permission: string]: { readonly [key: string]: Json } };
};

/** Runs the script served as `/proxy.js`, as a browser would, in a fake window and document. */
const run = (options: Options = {}) => {
  const {
    top = "isolated",
    framed = true,
    metaOrigin = HOST,
    unreachableDocument = false,
  } = options;

  const parent = frame("parent");
  const win = frame("proxy");

  /** What happened to the inner frames, in order: `create 1`, `set 1 sandbox=…`, `append 1`, `remove 1`, `write 1`. */
  const log: string[] = [];
  const created: Inner[] = [];

  const makeInner = (): Inner => {
    const n = created.length + 1;
    const attributes = new Map<string, string>();
    const writes: string[] = [];
    const window = frame(`inner ${n}`);

    const inner: Inner = {
      n,
      attributes,
      window,
      writes,
      setAttribute: (name, value) => {
        attributes.set(name, value);
        log.push(`set ${n} ${name}=${value}`);
      },
      contentWindow: window,
      contentDocument: unreachableDocument
        ? null
        : {
            open: () => {
              log.push(`open ${n}`);
            },
            write: (html) => {
              writes.push(html);
              log.push(`write ${n}`);
            },
            close: () => {
              log.push(`close ${n}`);
            },
          },
      srcdoc: undefined,
    };

    created.push(inner);
    log.push(`create ${n}`);

    return inner;
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
    createElement: makeInner,
    body: {
      appendChild: (inner: Inner) => {
        log.push(`append ${inner.n}`);
      },
      removeChild: (inner: Inner) => {
        log.push(`remove ${inner.n}`);
      },
    },
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

  /** The parent sends `sandbox-resource-ready`; returns the inner frame it made (the newest). */
  const ready = (params: ReadyParams): Inner => {
    send({
      source: parent,
      origin: HOST,
      data: { method: "ui/notifications/sandbox-resource-ready", params },
    });

    const inner = created.at(-1);

    if (inner === undefined) throw new Error("no inner frame was made");

    return inner;
  };

  return { parent, win, created, log, send, ready, errors };
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

  it("makes no inner frame before the HTML arrives: its flags are fixed when it is created", () => {
    const { created, log } = run();

    expect(created).toEqual([]);
    expect(log).toEqual([]);
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

  it("makes the inner frame on sandbox-resource-ready, sandboxed as the reference does, and loads the HTML", () => {
    const { ready, parent, log } = run();
    parent.received.length = 0;

    const inner = ready({ html: "<p>view</p>" });

    expect(inner.attributes.get("sandbox")).toBe("allow-scripts allow-same-origin allow-forms");
    expect(inner.writes).toEqual(["<p>view</p>"]);
    expect(log.indexOf("open 1")).toBeGreaterThan(log.indexOf("append 1"));
    expect(inner.window.received).toEqual([]);
    expect(parent.received).toEqual([]);
  });

  it("sets sandbox and allow before the frame is appended, and appends before it writes", () => {
    const { ready, log } = run();

    ready({
      html: "x",
      sandbox: "allow-scripts",
      permissions: { clipboardWrite: {}, camera: {}, microphone: {}, geolocation: {} },
    });

    expect(log).toEqual([
      "create 1",
      "set 1 sandbox=allow-scripts",
      "set 1 allow=clipboard-write",
      "append 1",
      "open 1",
      "write 1",
      "close 1",
    ]);
  });
  it("replaces an existing inner frame, so the next View starts from its own flags", () => {
    const { ready, log } = run();

    ready({ html: "a", sandbox: "allow-scripts", permissions: { clipboardWrite: {} } });

    const second = ready({ html: "b" });

    expect(log.slice(log.indexOf("remove 1"))).toEqual([
      "remove 1",
      "create 2",
      "set 2 sandbox=allow-scripts allow-same-origin allow-forms",
      "append 2",
      "open 2",
      "write 2",
      "close 2",
    ]);
    expect(second.attributes.has("allow")).toBe(false);
  });

  it("falls back to srcdoc when the inner document isn't reachable", () => {
    const { ready } = run({ unreachableDocument: true });

    expect(ready({ html: "<p>x</p>" }).srcdoc).toBe("<p>x</p>");
  });

  it("relays the parent's other messages to the inner frame, as they are", () => {
    const { ready, send, parent } = run();
    const inner = ready({ html: "x" });
    const data = { jsonrpc: "2.0", id: 1, result: { ok: true } };

    send({ source: parent, origin: HOST, data });

    expect(inner.window.received).toEqual([{ data, target: "*" }]);
  });

  it("drops the parent's other messages while there is no inner frame", () => {
    const { send, parent, errors } = run();

    send({ source: parent, origin: HOST, data: { jsonrpc: "2.0", id: 1, method: "ping" } });

    expect(errors).not.toHaveBeenCalled();
  });

  it("relays the inner frame's messages to the parent at the app origin, never to *", () => {
    const { ready, send, parent } = run();
    const inner = ready({ html: "x" });
    parent.received.length = 0;
    const data = { jsonrpc: "2.0", method: "ui/initialize", id: 1, params: {} };

    send({ source: inner.window, origin: OWN, data });

    expect(parent.received).toEqual([{ data, target: HOST }]);
  });

  it("drops what a replaced frame sends", () => {
    const { ready, send, parent } = run();
    const first = ready({ html: "a" });

    ready({ html: "b" });
    parent.received.length = 0;

    send({ source: first.window, origin: OWN, data: { jsonrpc: "2.0", method: "x" } });

    expect(parent.received).toEqual([]);
  });

  it.each([
    ["another site", "https://evil.example"],
    ["the sandbox's own origin", OWN],
    ["a null origin", "null"],
    ["a prefix of the app origin", "https://pi.ianpascoe.de"],
    ["the app origin with a different port", `${HOST}:8443`],
    ["the app origin over http", "http://pi.ianpascoe.dev"],
  ])("drops a message from the parent frame at %s", (_, origin) => {
    const { ready, send, parent, created, errors } = run();
    const inner = ready({ html: "first" });
    parent.received.length = 0;

    send({
      source: parent,
      origin,
      data: { method: "ui/notifications/sandbox-resource-ready", params: { html: "x" } },
    });
    send({ source: parent, origin, data: { jsonrpc: "2.0", id: 1, method: "ping" } });

    expect(created).toHaveLength(1);
    expect(inner.writes).toEqual(["first"]);
    expect(inner.window.received).toEqual([]);
    expect(parent.received).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });

  it.each([
    ["the app origin", HOST],
    ["another site", "https://evil.example"],
    ["a null origin", "null"],
    ["a sandbox of another View", "https://bbbbbbbbbbbbbbbbbbbbbbbbbb.ianpascoe.app"],
  ])("drops a message from the inner frame at %s", (_, origin) => {
    const { ready, send, parent, errors } = run();
    const inner = ready({ html: "x" });
    parent.received.length = 0;

    send({ source: inner.window, origin, data: { jsonrpc: "2.0", method: "x" } });

    expect(parent.received).toEqual([]);
    expect(errors).toHaveBeenCalled();
  });

  it("drops a message from any other window, whatever its origin", () => {
    const { ready, send, parent, created } = run();
    const inner = ready({ html: "x" });
    parent.received.length = 0;
    const stranger = frame("stranger");

    for (const origin of [HOST, OWN, "https://evil.example"]) {
      send({
        source: stranger,
        origin,
        data: { method: "ui/notifications/sandbox-resource-ready", params: { html: "y" } },
      });
      send({ source: null, origin, data: { jsonrpc: "2.0", method: "x" } });
    }

    expect(created).toHaveLength(1);
    expect(inner.writes).toEqual(["x"]);
    expect(parent.received).toEqual([]);
    expect(inner.window.received).toEqual([]);
  });

  it("drops the inner frame's message when the frame has gone", () => {
    const { ready, send, parent } = run();
    const inner = ready({ html: "x" });
    parent.received.length = 0;
    inner.contentWindow = null;

    send({ source: null, origin: OWN, data: { jsonrpc: "2.0", method: "x" } });

    expect(parent.received).toEqual([]);
  });
});
