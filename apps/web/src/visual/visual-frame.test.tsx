// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// docs/architecture/visuals.md → The frame, Testing. A Visual's frame in a DOM: a sandboxed frame at the Session's Visual
// origin with the fixed policy, handed the kept page with the shim first; its height fits the page and is remembered; an
// Escape the page did not handle returns the focus to the card; a page that does not start says so with Retry; and a card
// mounts its frame only near the viewport.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of a fake frame: JSON-RPC as a case posts it, cut down to the shape a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off asyncFunction:off -- a DOM and its timers, driven by hand; vitest awaits.
import {
  VISUAL_CSP,
  VISUAL_ESCAPE,
  VISUAL_SHIM,
  type VisualEntry,
  type VisualRecord,
} from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeFrames, ORIGIN, viewOf } from "../app-view/frame-kit.testing.ts";
import { ShownSession } from "../chat/conversation.ts";
import { INITIALIZE_TIMEOUT_MS } from "../sandbox-frame/frame-protocol.ts";
import { AppPlaces } from "../sandbox-frame/places.ts";
import { visualKey, visualLoadAtom, type VisualLoad } from "./atoms.ts";
import { ViewportWatchContext, type ViewportWatch } from "./lazy.ts";
import { VisualOpen, VisualPlacesContext } from "./visual-call.tsx";
import { VisualFrame, type VisualFrameProps } from "./visual-frame.tsx";

const record: VisualRecord = {
  callId: "c1",
  conversation: "1",
  title: "Sales",
  summary: "Sales by month, as bars",
  source: { kind: "path", path: "/workspace/v.html" },
  html: "<!doctype html><html><head></head><body>bars</body></html>",
  bytes: 50,
  warnings: [],
  at: 1,
};

installFakeFrames();

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // @ts-expect-error -- React's flag that its updates are wrapped in `act` in this test.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
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

const render = (props: Partial<VisualFrameProps> = {}) => {
  act(() => {
    root.render(<VisualFrame record={record} origin={ORIGIN} {...props} />);
  });
};

const frameOf = () => viewOf(host.querySelector("iframe"));

describe("a Visual's frame", () => {
  it("is a sandboxed frame at the Session's origin with the fixed policy, titled and described for a screen reader", () => {
    render();

    const { element } = frameOf();

    expect(element.getAttribute("src")).toBe(
      `${ORIGIN}/?csp=${encodeURIComponent(JSON.stringify({ resourceDomains: VISUAL_CSP.resourceDomains }))}`,
    );
    expect(element.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(element.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(element.getAttribute("allow")).toBeNull();
    expect(element.getAttribute("title")).toBe("Visual: Sales");
    expect(element.getAttribute("aria-description")).toBe("Sales by month, as bars");
  });

  it("hands the proxy the kept page with the shim first in its head, and the policy", () => {
    render();

    const view = frameOf();

    view.handshake();

    const resource = view.sent.find(
      (each) => each.data["method"] === "ui/notifications/sandbox-resource-ready",
    )?.data["params"] as { html: string; csp: unknown; sandbox: unknown };

    expect(resource.html).toBe(
      `<!doctype html><html><head><script>${VISUAL_SHIM}</script></head><body>bars</body></html>`,
    );
    expect(resource.csp).toEqual({ resourceDomains: [...VISUAL_CSP.resourceDomains] });
    expect(resource.sandbox).toBe("allow-scripts allow-same-origin");
  });

  it("tells the page only the theme and the style variables", async () => {
    render();

    const view = frameOf();

    view.handshake();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const answer = view.sent.find((each) => each.data["id"] === 1)?.data["result"] as {
      hostContext: Record<string, unknown>;
    };

    expect(Object.keys(answer.hostContext).sort()).toEqual(["styles", "theme"]);
  });

  it("fits the page's height, and says it so the device remembers it", () => {
    const heights: number[] = [];

    render({ initialHeight: 300, onHeight: (height) => heights.push(height) });

    const view = frameOf();

    expect(view.element.style.height).toBe("300px");
    view.handshake();
    view.say({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 1234 } });
    expect(view.element.style.height).toBe("1234px");
    view.say({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 40 } });
    expect(view.element.style.height).toBe("160px");
    expect(heights).toEqual([1234, 160]);
  });

  it("hands an Escape the page did not handle to the card, only while the frame has the focus", () => {
    const onEscape = vi.fn();

    render({ onEscape });

    const view = frameOf();

    view.handshake();
    view.say({ jsonrpc: "2.0", method: VISUAL_ESCAPE, params: {} });
    expect(onEscape).not.toHaveBeenCalled();

    view.element.focus();
    view.say({ jsonrpc: "2.0", method: VISUAL_ESCAPE, params: {} });
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it("says a page that does not start within 10 s couldn't, and Retry makes the frame again", () => {
    render();

    const view = frameOf();

    view.say({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
    act(() => {
      vi.advanceTimersByTime(INITIALIZE_TIMEOUT_MS);
    });
    expect(host.textContent).toContain(
      "Visual couldn't start: The Visual did not start within 10 seconds",
    );
    expect(host.querySelector("iframe")).toBeNull();

    act(() => {
      host.querySelector("button")?.click();
    });
    expect(host.querySelector("iframe")).not.toBeNull();
  });

  it("asks the owner before a link the page opens is opened", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);

    render();

    const view = frameOf();

    view.handshake();
    view.say({
      jsonrpc: "2.0",
      id: "visual-9",
      method: "ui/open-link",
      params: { url: "https://example.com/a" },
    });
    expect(host.textContent).toContain("The Visual wants to open a link:");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("a Visual's card", () => {
  const entry: VisualEntry = {
    callId: "c1",
    title: "Sales",
    summary: "Sales by month, as bars",
    source: { kind: "path", path: "/workspace/v.html" },
    state: "kept",
    bytes: 50,
    at: 1,
  };

  /** A card whose page is loaded, with a watch the case says is near or far. */
  const renderCard = () => {
    const load: VisualLoad = { status: "page", record, origin: ORIGIN };

    const registry = AtomRegistry.make({
      initialValues: [
        Atom.initialValue(visualLoadAtom(visualKey("s1", "c1")), AsyncResult.success(load)),
      ],
    });

    let tell: (near: boolean) => void = () => undefined;

    const watch: ViewportWatch = (_element, onChange) => {
      tell = onChange;

      return () => undefined;
    };

    act(() => {
      root.render(
        <RegistryContext.Provider value={registry}>
          <ShownSession.Provider value="s1">
            <VisualPlacesContext.Provider value={new AppPlaces()}>
              <ViewportWatchContext.Provider value={watch}>
                <VisualOpen sessionId="s1" entry={entry} onCollapse={() => undefined} />
              </ViewportWatchContext.Provider>
            </VisualPlacesContext.Provider>
          </ShownSession.Provider>
        </RegistryContext.Provider>,
      );
    });

    return {
      near: (near: boolean) => {
        act(() => {
          tell(near);
        });
      },
    };
  };

  it("mounts its frame near the viewport and unmounts it far from it, keeping its chrome", () => {
    const card = renderCard();

    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Visual·Sales");

    card.near(true);
    expect(host.querySelector("iframe")?.getAttribute("title")).toBe("Visual: Sales");

    card.near(false);
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.textContent).toContain("Copy HTML");
  });

  it("takes the focus back when the page sends an Escape", () => {
    const card = renderCard();

    card.near(true);

    const view = frameOf();

    view.handshake();
    view.element.focus();
    view.say({ jsonrpc: "2.0", method: VISUAL_ESCAPE, params: {} });
    expect(document.activeElement?.getAttribute("data-visual")).toBe("c1");
  });
});
