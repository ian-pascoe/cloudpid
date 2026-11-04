// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// docs/architecture/mcp-apps.md → App Views in the transcript (Teardown). The card's frame in a DOM: a View that is ended by its
// card (eviction, a server gone or shadowed, another page, Retry) is told to tear down while its frame is still in the
// document, and the frame leaves only once it has answered, or after 2 s.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of a fake frame: JSON-RPC as a case posts it, cut down to the shape a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off newPromise:off asyncFunction:off -- a DOM and its timers, driven by hand.
import type { McpAppRecord } from "@cloudpid/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFrame, type AppFrameProps } from "./app-frame.tsx";
import { TEARDOWN_TIMEOUT_MS } from "./bridge.ts";
import type { AppPage } from "./load.ts";

const ORIGIN = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";
const OTHER = "https://bbbbbbbbbbbbbbbbbbbbbbbbbb.ianpascoe.app";

const record: McpAppRecord = {
  callId: "c1",
  server: "docs",
  tool: "page",
  conversation: "1",
  arguments: { slug: "intro" },
  result: { content: [{ type: "text", text: "hi" }] },
  audit: [],
  at: 1,
};

const pageAt = (origin: string): AppPage => ({ html: "<p>view</p>", meta: {}, origin });

type Sent = { readonly data: Record<string, unknown>; readonly target: string };

/** A frame's window, which happy-dom does not make for a page it does not load: a stand-in that records what is posted to it. */
interface FakeWindow {
  readonly sent: Sent[];
  readonly postMessage: (data: Record<string, unknown>, target: string) => void;
}

const windows = new WeakMap<HTMLIFrameElement, FakeWindow>();

Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
  configurable: true,
  get(this: HTMLIFrameElement) {
    const found = windows.get(this);

    if (found !== undefined) return found;

    const sent: Sent[] = [];

    const made: FakeWindow = {
      sent,
      postMessage: (data, target) => {
        sent.push({ data, target });
      },
    };

    windows.set(this, made);

    return made;
  },
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // @ts-expect-error -- React's flag that its updates are wrapped in `act` in this test.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  // happy-dom reports each frame page it was told not to load.
  vi.spyOn(window.console, "error").mockImplementation(() => undefined);
  vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The frame in the card, with what the page posts to it recorded, and a way to answer as the View would. */
const frameOf = () => {
  const element = host.querySelector("iframe");
  const win = element === null ? undefined : windows.get(element);

  if (element === null || win === undefined) throw new Error("no frame");

  const { sent } = win;

  const say = (data: Record<string, unknown>, origin = ORIGIN) => {
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { data, origin, source: win as unknown as MessageEventSource }),
      );
    });
  };

  const handshake = () => {
    say({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
    say({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/initialize",
      params: { protocolVersion: "2026-01-26", appInfo: { name: "v", version: "1" } },
    });
    say({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  };

  // The answers carry no method: only what the page says on its own.
  const methods = () =>
    sent.flatMap((each) => (each.data["method"] === undefined ? [] : [each.data["method"]]));

  return { element, sent, say, handshake, methods };
};

const render = (props: Partial<AppFrameProps> = {}) => {
  act(() => {
    root.render(
      <AppFrame
        record={record}
        page={pageAt(ORIGIN)}
        tool={{
          name: "mcp__docs__page",
          server: "docs",
          tool: "page",
          title: "Page",
          uri: "ui://docs/page",
          visibility: ["model", "app"],
        }}
        badge={null}
        {...props}
      />,
    );
  });
};

describe("a View's frame in its card", () => {
  it("is a sandboxed frame at the Session's origin, titled by its tool and server", () => {
    render();

    const { element } = frameOf();

    expect(element.getAttribute("src")).toBe(`${ORIGIN}/`);
    expect(element.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(element.getAttribute("title")).toBe("App: Page (docs)");
    expect(host.textContent).toContain("App");
    expect(host.textContent).toContain("docs");
  });

  it("is handed its page, then the call's arguments and result once it is ready", () => {
    render();

    const view = frameOf();

    view.handshake();
    expect(view.methods()).toEqual([
      "ui/notifications/sandbox-resource-ready",
      "ui/notifications/tool-input",
      "ui/notifications/tool-result",
    ]);
    expect(view.sent.every((each) => each.target === ORIGIN)).toBe(true);
  });

  it("keeps its frame in the document until its View has answered the teardown, then says it may go", async () => {
    const closed = vi.fn();

    render({ onClosed: closed });

    const view = frameOf();

    view.handshake();
    view.sent.length = 0;

    render({ onClosed: closed, closing: true });

    // The View has been told, and the frame is still there to receive it.
    expect(view.methods()).toEqual(["ui/resource-teardown"]);
    expect(host.querySelector("iframe")).toBe(view.element);
    expect(closed).not.toHaveBeenCalled();

    const id = view.sent[0]?.data["id"];

    view.say({ jsonrpc: "2.0", id, result: {} });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(closed).toHaveBeenCalledTimes(1);
    expect(host.querySelector("iframe")).toBe(view.element);
  });

  it("waits at most 2 s for a View that does not answer", async () => {
    const closed = vi.fn();

    render({ onClosed: closed });
    frameOf().handshake();
    render({ onClosed: closed, closing: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEARDOWN_TIMEOUT_MS - 1);
    });
    expect(closed).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("sends tool-cancelled before the teardown for a call that did not finish", () => {
    render({ cancelled: "evicted" });

    const view = frameOf();

    view.handshake();
    view.sent.length = 0;
    render({ cancelled: "evicted", closing: true });

    expect(view.methods()).toEqual(["ui/notifications/tool-cancelled", "ui/resource-teardown"]);
    expect(view.sent[0]?.data["params"]).toEqual({ reason: "evicted" });
  });

  it("tells the View of the old page to tear down before another page's frame is mounted", async () => {
    render();

    const old = frameOf();

    old.handshake();
    old.sent.length = 0;

    render({ page: pageAt(OTHER) });

    expect(old.methods()).toEqual(["ui/resource-teardown"]);
    expect(host.querySelector("iframe")).toBe(old.element);
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe(`${ORIGIN}/`);

    old.say({ jsonrpc: "2.0", id: old.sent[0]?.data["id"], result: {} });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    expect(host.querySelector("iframe")?.getAttribute("src")).toBe(`${OTHER}/`);
  });

  it("is a frame with nothing to tear down when its View never came up: it may go at once", async () => {
    const closed = vi.fn();

    render({ onClosed: closed });
    render({ onClosed: closed, closing: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(closed).toHaveBeenCalledTimes(1);
  });
});
