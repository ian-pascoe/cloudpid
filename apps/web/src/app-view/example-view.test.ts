// @vitest-environment happy-dom
// docs/architecture/mcp-apps.md → Testing. A real ext-apps example View (basic-server-vanillajs, built as its own build does)
// behind the sandbox's real proxy script, with cloudpid's real bridge: it reaches `initialized` and renders a tool result.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of fake windows (JSON-RPC as the View posts it) and happy-dom's window types, which do not line up with the DOM lib's: cut down to what a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off newPromise:off asyncFunction:off nodeBuiltinImport:off globalDate:off -- a build and DOMs, driven by hand.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpUiToolResultNotification } from "@modelcontextprotocol/ext-apps";
import { Window } from "happy-dom";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { PROXY_JS, proxyPage } from "../../../app-sandbox/src/proxy.ts";
import type { IncomingMessage } from "../sandbox-frame/frame-protocol.ts";
import { createBridge, type Bridge, type BridgeEvent } from "./bridge.ts";
import {
  HOST_INFO,
  hostCapabilities,
  hostContextOf,
  type HostEnvironment,
} from "./host-context.ts";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, "fixtures", "get-time", name), "utf8");

let work = "";
let html = "";

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "get-time-"));
  mkdirSync(join(work, "src"));
  writeFileSync(join(work, "src", "mcp-app.ts"), fixture("mcp-app.ts.txt"));
  writeFileSync(join(work, "src", "global.css"), fixture("global.css.txt"));
  writeFileSync(join(work, "src", "mcp-app.css"), fixture("mcp-app.css.txt"));

  const appWithDeps = join(
    import.meta.dirname,
    "../../node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js",
  );

  const built = await build({
    root: work,
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@modelcontextprotocol/ext-apps": appWithDeps } },
    build: {
      write: false,
      minify: true,
      lib: {
        entry: join(work, "src", "mcp-app.ts"),
        formats: ["iife"],
        name: "view",
        cssFileName: "view",
      },
    },
  });

  const outputs = (Array.isArray(built) ? built : [built]).flatMap((each) =>
    "output" in each ? each.output : [],
  );

  const js = outputs.flatMap((each) => (each.type === "chunk" ? [each.code] : [])).join("\n");

  const css = outputs
    .flatMap((each) =>
      each.type === "asset" && String(each.fileName).endsWith(".css") ? [String(each.source)] : [],
    )
    .join("\n");

  // The example's single-file build: its page with the script and the styles inline.
  html = fixture("mcp-app.html.txt").replace(
    /<script type="module" src="[^"]*"><\/script>/,
    () => `<style>${css}</style><script>${js}</script>`,
  );
}, 60_000);

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("the example View, as built", () => {
  it("is one page with its script inline", () => {
    expect(html).toContain("Get Time App");
    expect(html).toContain("server-time");
    expect(html).not.toContain('src="/src/mcp-app.ts"');
    expect(html.length).toBeGreaterThan(50_000);
  });
});

const APP = "https://pi.ianpascoe.dev";
const SANDBOX = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";

const environment: HostEnvironment = {
  dark: false,
  readProperty: () => "",
  locale: "en-GB",
  timeZone: "UTC",
  userAgent: "test",
  mobile: false,
  touch: false,
  hover: true,
  width: 600,
  maxHeight: 640,
};

/** What the page's window and the sandbox's proxy frame do with one another's messages: a post is a task, as in a browser. */
const rig = () => {
  const errors: string[] = [];
  const events: BridgeEvent[] = [];
  const hostWindow = window;

  const proxyWindow = new Window({
    url: `${SANDBOX}/`,
    settings: { disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });

  proxyWindow.addEventListener("error", (event) => {
    errors.push("message" in event ? String(event.message) : event.type);
  });

  // The proxy's parent is the page, whose location it must not be able to read (the proxy refuses to run otherwise).
  const parent = {
    get location(): never {
      throw new DOMException(
        "Blocked a frame from accessing a cross-origin frame.",
        "SecurityError",
      );
    },
    postMessage: (data: unknown, target: string) => {
      expect(target).toBe(APP);
      setTimeout(() => {
        hostWindow.dispatchEvent(
          new MessageEvent("message", { data, origin: SANDBOX, source: proxyFrame as never }),
        );
      }, 0);
    },
  };

  Object.defineProperty(proxyWindow, "parent", { value: parent, configurable: true });
  Object.defineProperty(proxyWindow, "top", { value: parent, configurable: true });

  // The frame the bridge posts to: the proxy's window, and a message arrives from the page at the app origin.
  const proxyFrame = {
    postMessage: (data: unknown, target: string) => {
      expect(target).toBe(SANDBOX);
      setTimeout(() => {
        proxyWindow.dispatchEvent(
          new proxyWindow.MessageEvent("message", {
            data,
            origin: APP,
            source: parent as never,
          }),
        );
      }, 0);
    },
  };

  // What the View posts to its parent, the proxy: it arrives from the inner frame, at the proxy's own origin.
  const toProxy = (data: unknown) => {
    const inner = proxyWindow.document.querySelector("iframe");

    setTimeout(() => {
      proxyWindow.dispatchEvent(
        new proxyWindow.MessageEvent("message", {
          data,
          origin: SANDBOX,
          source: inner?.contentWindow as never,
        }),
      );
    }, 0);
  };

  Object.defineProperty(proxyWindow, "postMessage", { value: toProxy, configurable: true });

  const listen = (handler: (message: IncomingMessage) => void) => {
    const onMessage = (event: Event) => {
      if (!(event instanceof MessageEvent)) return;

      handler({ source: event.source, origin: event.origin, data: event.data });
    };

    hostWindow.addEventListener("message", onMessage);

    return () => {
      hostWindow.removeEventListener("message", onMessage);
    };
  };

  /** Make the sandbox page, as the Worker serves it, and run its script. */
  const boot = () => {
    proxyWindow.document.write(proxyPage(APP));

    // happy-dom loads a frame's `srcdoc` but does not run its inline scripts, which a browser does as it parses the
    // document the proxy writes: so the View's own are run in the frame's window, once it has loaded, as a browser would.
    new proxyWindow.MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof proxyWindow.HTMLIFrameElement)) continue;

          const frame = node;
          let ran = false;

          frame.addEventListener("load", () => {
            const inner = frame.contentWindow;

            if (ran || inner === null || !("eval" in inner)) return;

            ran = true;

            for (const script of inner.document.scripts) inner.eval(script.textContent);
          });
        }
      }
    }).observe(proxyWindow.document.body, { childList: true });

    proxyWindow.eval(PROXY_JS);
  };

  const bridgeFor = (page: string): Bridge =>
    createBridge({
      frame: proxyFrame,
      origin: SANDBOX,
      listen,
      page: { html: page },
      hostContext: () =>
        hostContextOf(environment, { callId: "call-1", name: "get-time", title: "Get Time" }),
      capabilities: hostCapabilities(undefined),
      hostInfo: HOST_INFO,
      onEvent: (event) => events.push(event),
    });

  const view = () => proxyWindow.document.querySelector("iframe")?.contentDocument;

  return { errors, events, boot, bridgeFor, view, proxyWindow };
};

describe("the example View behind the sandbox's proxy and cloudpid's bridge", () => {
  const result: McpUiToolResultNotification["params"] = {
    content: [{ type: "text", text: "2026-07-01T12:00:00.000Z" }],
    structuredContent: { time: "2026-07-01T12:00:00.000Z" },
  };

  const up = async () => {
    const made = rig();
    const bridge = made.bridgeFor(html);

    bridge.start();
    made.boot();
    bridge.toolInput({});
    bridge.toolResult(result);

    await vi.waitFor(() => expect(made.events).toContainEqual({ type: "ready" }), {
      timeout: 5000,
    });

    return { ...made, bridge };
  };

  it("comes up, reaches initialized and renders the tool's result", async () => {
    const { view, errors, events, bridge } = await up();

    await vi.waitFor(
      () =>
        expect(view()?.getElementById("server-time")?.textContent).toBe("2026-07-01T12:00:00.000Z"),
      { timeout: 5000 },
    );
    // The host context reached it: the example applies the theme it was told.
    expect(view()?.documentElement.getAttribute("data-theme")).toBe("light");
    expect(errors).toEqual([]);
    // Nothing was refused or failed; the View sized itself (a page of no height here).
    expect(events.filter((event) => event.type === "rejected" || event.type === "failed")).toEqual(
      [],
    );
    bridge.close();
  });

  it("is answered -32601 for a tools/call the host does not serve yet, and says so in the page", async () => {
    const { view, bridge } = await up();

    (view()?.getElementById("get-time-btn") as HTMLElement | undefined)?.click();
    await vi.waitFor(
      () => expect(view()?.getElementById("server-time")?.textContent).toBe("[ERROR]"),
      {
        timeout: 5000,
      },
    );
    bridge.close();
  });

  it("is told to tear down, answers well inside the 2 s, and the bridge closes", async () => {
    const { bridge, events } = await up();
    const started = Date.now();

    await bridge.teardown();
    // An answer from the View, not the bridge's timeout.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(events.filter((event) => event.type === "rejected")).toEqual([]);
  });
});
