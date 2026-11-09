// docs/architecture/visuals.md → Testing: the protocol's types and messages, the list and its CSP, the library table (every URL
// an exact version), and the shim's served text, run in a fake window as a browser would run it in a Visual's frame.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off schemaSync:off preferTypedSchemaDecoder:off -- assertions over native arrays and records; decoding what a socket carries, as tests do.
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- a fake window and document: the shim's text is run against what a browser hands it, whose values are the page's own */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ServerMessageJson } from "./session.ts";
import {
  fitHeight,
  VISUAL_ESCAPE,
  VISUAL_LIBRARIES,
  VISUAL_SANDBOX_DIRECTIVE,
  VISUAL_MAX_HEIGHT,
  VISUAL_MIN_HEIGHT,
  VISUAL_SHIM,
  isKeptVisual,
  isVisualHost,
  shownVisualOf,
  sourcePathOf,
  visualCheckPolicy,
  withVisualCheckPrelude,
  withVisualShim,
} from "./visuals.ts";

describe("the height a frame fits", () => {
  it("is the page's from 160 px to 20,000 px", () => {
    expect(fitHeight(10)).toBe(VISUAL_MIN_HEIGHT);
    expect(fitHeight(480.2)).toBe(481);
    expect(fitHeight(1e6)).toBe(VISUAL_MAX_HEIGHT);
  });
});

describe("the list and its policy", () => {
  it("matches a host of the list whatever its case, and no other", () => {
    expect(isVisualHost("CDNJS.cloudflare.com")).toBe(true);
    expect(isVisualHost("cdn.jsdelivr.net")).toBe(false);
  });
});

describe("the library table", () => {
  it("has every file on cdnjs at an exact version", () => {
    for (const file of VISUAL_LIBRARIES.flatMap((library) => library.files)) {
      expect(file).toMatch(
        /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/[\w.-]+\/\d+\.\d+\.\d+\/[\w.-]+$/,
      );
      expect(file).not.toContain("latest");
    }
  });
});

describe("the messages", () => {
  const decodeServer = Schema.decodeUnknownSync(ServerMessageJson);

  it("reads visuals, with a state and a source kind a later build adds", () => {
    const message = decodeServer(
      JSON.stringify({
        type: "visuals",
        conversationId: 1,
        visuals: [
          {
            callId: "c1",
            title: "Chart",
            summary: "Sales by month",
            source: { kind: "path", path: "/workspace/a.html" },
            state: "kept",
            bytes: 10,
            at: 1,
          },
          {
            callId: "c2",
            title: "Later",
            summary: "x",
            source: { kind: "url" },
            state: "archived",
            bytes: 0,
            at: 2,
          },
        ],
      }),
    );

    expect(message.type).toBe("visuals");

    if (message.type !== "visuals") return;

    const [first, second] = message.visuals;

    expect(first && sourcePathOf(first.source)).toBe("/workspace/a.html");
    expect(second && sourcePathOf(second.source)).toBeUndefined();
    expect(second && isKeptVisual(second)).toBe(false);
  });
});

describe("the Visual a result's details say it showed", () => {
  it("is its title and summary, with the file and size when they say them, and none for other details", () => {
    expect(shownVisualOf({ visual: { title: "t", summary: "s" } })).toEqual({
      title: "t",
      summary: "s",
    });
    expect(
      shownVisualOf({
        visual: { title: "t", summary: "s", source_path: "/a.html", bytes: 9, id: "x" },
      }),
    ).toMatchObject({ title: "t", summary: "s", source_path: "/a.html", bytes: 9 });
    expect(
      shownVisualOf({ visual: { title: "t", summary: "s", source_path: null } }),
    ).toMatchObject({ source_path: null });
    expect(shownVisualOf({ visual: { title: "t" } })).toBeUndefined();
    expect(shownVisualOf(undefined)).toBeUndefined();
  });
});

describe("withVisualShim", () => {
  const script = `<script>${VISUAL_SHIM}</script>`;

  it("puts the shim first in the head, before the page's own scripts", () => {
    expect(withVisualShim("<!doctype html><html><head><script>x()</script></head></html>")).toBe(
      `<!doctype html><html><head>${script}<script>x()</script></head></html>`,
    );
  });

  it("makes a head after <html>, or puts it after the doctype", () => {
    expect(withVisualShim('<html lang="en"><body></body></html>')).toBe(
      `<html lang="en"><head>${script}</head><body></body></html>`,
    );
    expect(withVisualShim("<!DOCTYPE html><p>hi</p>")).toBe(`<!DOCTYPE html>${script}<p>hi</p>`);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The shim in a fake window

type Posted = { readonly message: Record<string, unknown>; readonly target: string };

type Handler = (event: Record<string, unknown>) => void;

/**
 * A fake element of the page: attributes, a parent, and the style properties set on it. Its box is `frameHeight` px tall
 * (the frame's, as a root with `height: 100%` is) or its content's `contentHeight`, whichever is more, and its content's at
 * `height: max-content`.
 */
const element = (name: string, attributes: Record<string, string> = {}, parent?: unknown) => {
  const properties = new Map<string, string>();
  const priorities = new Map<string, string>();

  return {
    nodeType: 1,
    nodeName: name.toUpperCase(),
    parentNode: parent ?? null,
    frameHeight: 0,
    contentHeight: 0,
    textContent: "",
    children: [] as unknown[],
    attributes: { ...attributes } as Record<string, string>,
    style: {
      colorScheme: "",
      setProperty: (key: string, value: string, priority = "") => {
        properties.set(key, value);
        priorities.set(key, priority);
      },
      getPropertyValue: (key: string) => properties.get(key) ?? "",
      getPropertyPriority: (key: string) => priorities.get(key) ?? "",
      removeProperty: (key: string) => {
        properties.delete(key);
        priorities.delete(key);
      },
    },
    properties,
    getBoundingClientRect() {
      return {
        height:
          properties.get("height") === "max-content"
            ? this.contentHeight
            : Math.max(this.frameHeight, this.contentHeight),
      };
    },
    getAttribute(key: string) {
      return this.attributes[key] ?? null;
    },
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
    },
    appendChild(child: unknown) {
      this.children.push(child);
    },
  };
};

/** Runs the shim's text in a fake window framed by `parent`, as the inner frame of the proxy runs it. */
const runShim = (options: { readonly framed?: boolean } = {}) => {
  const posted: Posted[] = [];
  const windowListeners = new Map<string, Handler[]>();
  const documentListeners = new Map<string, Handler[]>();
  const observed: unknown[] = [];
  const root = element("html");
  const head = element("head", {}, root);
  const body = element("body", {}, root);

  const parent = {
    postMessage: (message: Record<string, unknown>, target: string) => {
      posted.push({ message, target });
    },
  };

  const window: Record<string, unknown> = {
    location: { origin: "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app" },
    addEventListener: (type: string, handler: Handler) => {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), handler]);
    },
    RTCPeerConnection: () => undefined,
    RTCDataChannel: () => undefined,
  };

  window["parent"] = options.framed === false ? window : parent;

  const document = {
    documentElement: root,
    head,
    body,
    baseURI: "about:srcdoc",
    createElement: (name: string) => element(name),
    addEventListener: (type: string, handler: Handler) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), handler]);
    },
  };

  class FakeResizeObserver {
    constructor(readonly callback: () => void) {}

    observe(target: unknown) {
      observed.push(target);
    }
  }

  // oxlint-disable-next-line typescript/no-implied-eval -- the test runs the shim's served text, as a browser does.
  new Function("window", "document", "ResizeObserver", "URL", VISUAL_SHIM)(
    window,
    document,
    FakeResizeObserver,
    URL,
  );

  const hostSays = (data: Record<string, unknown>, source: unknown = parent) => {
    for (const handler of windowListeners.get("message") ?? []) handler({ source, data });
  };

  return {
    posted,
    window,
    root,
    head,
    body,
    observed,
    hostSays,
    documentListeners,
    windowListeners,
  };
};

describe("the shim", () => {
  it("does nothing when it is not framed", () => {
    const { posted } = runShim({ framed: false });

    expect(posted).toEqual([]);
  });

  it("deletes the WebRTC constructors and forces overscroll chaining before the page runs", () => {
    const { window, head } = runShim();

    expect(window["RTCPeerConnection"]).toBeUndefined();
    expect(window["RTCDataChannel"]).toBeUndefined();
    expect(head.children).toHaveLength(1);
    expect(head.children[0]).toMatchObject({
      textContent: "html, body { overscroll-behavior: auto !important; }",
    });
  });

  it("initializes, applies the host's theme and style variables, then reports its height", () => {
    const { posted, root, hostSays, observed } = runShim();

    expect(posted).toHaveLength(1);
    expect(posted[0]?.target).toBe("https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app");
    expect(posted[0]?.message).toMatchObject({ jsonrpc: "2.0", method: "ui/initialize" });

    root.contentHeight = 420;
    hostSays({
      jsonrpc: "2.0",
      id: posted[0]?.message["id"],
      result: {
        hostContext: {
          theme: "dark",
          styles: { variables: { "--color-text-primary": "#eee", bogus: "x" } },
        },
      },
    });

    expect(root.style.colorScheme).toBe("dark");
    expect(root.attributes["data-theme"]).toBe("dark");
    expect(root.properties.get("--color-text-primary")).toBe("#eee");
    expect(root.properties.has("bogus")).toBe(false);
    expect(posted.slice(1).map((each) => each.message)).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} },
      { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 420 } },
    ]);
    expect(observed).toHaveLength(2);
  });

  it("reports the content's height, not the frame's, so a frame taller than its page shrinks", () => {
    const { posted, root, hostSays, windowListeners } = runShim();

    root.frameHeight = 1200;
    root.contentHeight = 300.4;
    root.style.setProperty("height", "100%");
    hostSays({ jsonrpc: "2.0", id: posted[0]?.message["id"], result: { hostContext: {} } });

    expect(posted.at(-1)?.message).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 301 },
    });
    // The page's own height is put back as it was.
    expect(root.properties.get("height")).toBe("100%");

    // Without a height of its own, it measures as the frame changes.
    root.style.removeProperty("height");
    root.contentHeight = 200;

    for (const handler of windowListeners.get("load") ?? []) handler({});

    expect(posted.at(-1)?.message).toMatchObject({ params: { height: 200 } });
    expect(root.properties.has("height")).toBe(false);
  });

  it("follows a host-context change, and ignores a message that is not its host's", () => {
    const { root, hostSays } = runShim();

    hostSays(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "dark" },
      },
      {},
    );
    expect(root.style.colorScheme).toBe("");

    hostSays({
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "light" },
    });
    expect(root.style.colorScheme).toBe("light");
  });

  it("asks the host to open an http link, and leaves fragments and other schemes to the page", () => {
    const { posted, documentListeners } = runShim();
    const click = documentListeners.get("click")?.[0];
    let prevented = 0;

    const clickOn = (href: string) => {
      const link = element("a", { href });
      const inner = element("span", {}, link);

      click?.({
        target: inner,
        defaultPrevented: false,
        preventDefault: () => {
          prevented += 1;
        },
      });
    };

    clickOn("https://example.com/a?b=1");
    clickOn("#section");
    clickOn("javascript:alert(1)");

    expect(prevented).toBe(1);
    expect(posted.at(-1)?.message).toMatchObject({
      method: "ui/open-link",
      params: { url: "https://example.com/a?b=1" },
    });
  });

  it("posts an Escape the page did not handle, and answers a teardown", () => {
    const { posted, windowListeners, hostSays } = runShim();
    const keydown = windowListeners.get("keydown")?.[0];

    keydown?.({ key: "Escape", defaultPrevented: true });
    keydown?.({ key: "Escape", defaultPrevented: false });
    expect(posted.filter((each) => each.message["method"] === VISUAL_ESCAPE)).toHaveLength(1);

    hostSays({ jsonrpc: "2.0", id: 7, method: "ui/resource-teardown", params: {} });
    expect(posted.at(-1)?.message).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });
});

describe("the check's header", () => {
  it("is the frame's policy and the frame's flags", () => {
    const policy = visualCheckPolicy();

    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("https://cdnjs.cloudflare.com");
    expect(policy.endsWith(`; ${VISUAL_SANDBOX_DIRECTIVE}`)).toBe(true);
    expect(VISUAL_SANDBOX_DIRECTIVE).toBe("sandbox allow-scripts allow-same-origin");
  });
});

describe("withVisualCheckPrelude", () => {
  it("puts the prelude first in the head, as the shim goes", () => {
    const page = withVisualCheckPrelude("<html><head><title>x</title></head></html>", "dark");

    expect(page.startsWith("<html><head><script>")).toBe(true);
    expect(page.endsWith("</script><title>x</title></head></html>")).toBe(true);
  });

  it("gives the page the theme and the style variables of a frame, and no WebRTC", () => {
    const attributes: Record<string, string> = {};
    const properties: Record<string, string> = {};

    const root = {
      style: {
        colorScheme: "",
        setProperty: (name: string, value: string) => {
          properties[name] = value;
        },
      },
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
    };

    const window: Record<string, unknown> = { RTCPeerConnection: () => undefined };
    const page = withVisualCheckPrelude("<head></head>", "dark");
    const code = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? "";

    // oxlint-disable-next-line typescript/no-implied-eval -- the test runs the served text, as a browser does.
    new Function("window", "document", code)(window, { documentElement: root });

    expect(root.style.colorScheme).toBe("dark");
    expect(attributes["data-theme"]).toBe("dark");
    expect(properties["--color-background-primary"]).toBe("oklch(0.2 0.012 250)");
    expect(properties["--border-radius-md"]).toBe("8px");
    expect(window["RTCPeerConnection"]).toBeUndefined();
  });
});
