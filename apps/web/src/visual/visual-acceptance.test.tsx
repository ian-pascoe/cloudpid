// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// docs/architecture/visuals.md → The frame (The card, The Visual Pane), Testing. The acceptance path with the real components over
// the app's atoms: a Visual's card (`VisualCall`, and a `codemode` script's `VisualStrip`), a subagent thread's copy of it, and
// the Pane area with its `VisualPane`, real frames, only the Session's socket and the sandbox page replaced. Pop out writes the
// Panes the page has open (its URL and the Session layout), the Pane mounts the frame and the card says where the Visual is
// and brings it back, from the card, the strip and a thread alike.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of a fake frame: JSON-RPC as a case posts it, cut down to the shape a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off newPromise:off asyncFunction:off -- a DOM and its timers, driven by hand.
import type { SessionView, TranscriptMessage, VisualEntry, VisualRecord } from "@cloudpid/protocol";
import { EMPTY_VIEW } from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeFrames, ORIGIN } from "../app-view/frame-kit.testing.ts";
import { ShownSession, ThreadPlace } from "../chat/conversation.ts";
import { PaneArea } from "../pane-area.tsx";
import { panesAtom } from "../panes-state.ts";
import { RegistryClient } from "../registry.ts";
import { fakeRegistryLayer } from "../registry.testing.ts";
import { AppPlaces } from "../sandbox-frame/places.ts";
import { sessionLayoutAtom } from "../session-layout-state.ts";
import { sessionStateAtom } from "../session/atoms.ts";
import { INITIAL_SESSION_STATE } from "../session/state.ts";
import { sessionListAtom } from "../sessions.ts";
import { keyValueStoreLayer } from "../storage.ts";
import { visualKey, visualLoadAtom, type VisualLoad } from "./atoms.ts";
import { ViewportWatchContext, type ViewportWatch } from "./lazy.ts";
import { VisualCall, VisualPlacesContext, VisualStrip } from "./visual-call.tsx";

installFakeFrames();

const entry = (callId: string, more: Partial<VisualEntry> = {}): VisualEntry => ({
  callId,
  title: `Chart ${callId}`,
  summary: `Sales by month (${callId})`,
  source: { kind: "inline" },
  state: "kept",
  bytes: 2048,
  at: 1,
  ...more,
});

const recordOf = (callId: string): VisualRecord => ({
  callId,
  conversation: "1",
  title: `Chart ${callId}`,
  summary: `Sales by month (${callId})`,
  source: { kind: "inline" },
  html: "<!doctype html><html><head></head><body>bars</body></html>",
  bytes: 50,
  warnings: [],
  at: 1,
});

const call = (id: string, name: string): TranscriptMessage => ({
  id,
  role: "assistant",
  timestamp: 0,
  parts: [{ type: "tool-call", id, name, arguments: {} }],
});

const memoryStorage = (): Storage => {
  const items = new Map<string, string>();

  return {
    get length() {
      return items.size;
    },
    clear: () => {
      items.clear();
    },
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
};

let host: HTMLDivElement;
let root: Root;
let registry: AtomRegistry.AtomRegistry;
let places: AppPlaces;
let threadCopy = false;

/** Every Visual the Session `s1` has: a direct call `c1`, a call `n1` that a script `script` made, and an evicted `old`. */
const session = (loads: Record<string, VisualLoad> = {}) => {
  const view: SessionView = {
    ...EMPTY_VIEW,
    messages: [call("c1", "visual_show"), call("script", "codemode")],
  };

  const all = {
    c1: { status: "page", record: recordOf("c1"), origin: ORIGIN },
    n1: { status: "page", record: recordOf("n1"), origin: ORIGIN },
    ...loads,
  } satisfies Record<string, VisualLoad>;

  registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(keyValueStoreLayer, KeyValueStore.layerStorage(memoryStorage)),
      Atom.initialValue(RegistryClient.runtime.layer, fakeRegistryLayer({})),
      Atom.initialValue(sessionListAtom, []),
      Atom.initialValue(sessionStateAtom("s1"), {
        ...INITIAL_SESSION_STATE,
        view,
        keepsVisuals: true,
        visuals: {
          "1": [
            entry("c1"),
            entry("n1", { parentCall: "script" }),
            entry("old", { state: "evicted" }),
          ],
        },
      }),
      ...Object.entries(all).map(([id, load]) =>
        Atom.initialValue(visualLoadAtom(visualKey("s1", id)), AsyncResult.success(load)),
      ),
    ],
  });

  for (const id of Object.keys(all)) registry.mount(visualLoadAtom(visualKey("s1", id)));
};

/** Every card is near the viewport: its frame mounts as soon as its place says so. */
const near: ViewportWatch = (_element, onChange) => {
  onChange(true);

  return () => undefined;
};

const Page = (): ReactNode => (
  <>
    <div data-testid="chat">
      <div data-call="c1">
        <VisualCall callId="c1" />
      </div>
      <div data-call="script">
        <VisualStrip parentId="script" />
      </div>
    </div>
    {threadCopy && (
      <div data-testid="subagent-pane">
        <ThreadPlace.Provider value="subagent-pane">
          <VisualCall callId="c1" />
        </ThreadPlace.Provider>
      </div>
    )}
    <PaneArea />
  </>
);

const show = () => {
  act(() => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <ShownSession.Provider value="s1">
          <VisualPlacesContext value={places}>
            <ViewportWatchContext value={near}>
              <Page />
            </ViewportWatchContext>
          </VisualPlacesContext>
        </ShownSession.Provider>
      </RegistryContext.Provider>,
    );
  });
};

beforeEach(() => {
  // @ts-expect-error -- React's flag that its updates are wrapped in `act` in this test.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  // happy-dom reports each frame page it was told not to load.
  vi.spyOn(window.console, "error").mockImplementation(() => undefined);
  vi.spyOn(globalThis.console, "error").mockImplementation(() => undefined);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  window.history.replaceState(null, "", "/sessions/s1");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  places = new AppPlaces();
  threadCopy = false;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  registry.dispose();
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const chat = (id = "c1") => host.querySelector<HTMLElement>(`[data-call="${id}"]`) as HTMLElement;
const paneOf = () => host.querySelector<HTMLElement>('[role="tabpanel"][data-pane]');
const frames = (within: ParentNode = host) => Array.from(within.querySelectorAll("iframe"));

const buttonIn = (within: ParentNode, name: string) =>
  Array.from(within.querySelectorAll("button")).find(
    (each) => each.textContent === name || each.getAttribute("aria-label") === name,
  );

const click = (button: HTMLElement | undefined) => {
  act(() => {
    button?.click();
  });
};

describe("Pop out, through the card and the Pane area", () => {
  it("writes the Visual Pane into the page's URL and the Session's layout, and mounts its frame there instead of the card's", () => {
    session();
    show();

    expect(frames(chat())).toHaveLength(1);

    click(buttonIn(chat(), "Pop out"));

    expect(registry.get(panesAtom).open).toEqual(["visual:c1"]);
    expect(window.location.search).toBe("?pane=visual:c1");
    expect(registry.get(sessionLayoutAtom("s1")).panes.open).toEqual(["visual:c1"]);

    expect(frames(chat())).toHaveLength(0);
    expect(frames(paneOf() as HTMLElement)).toHaveLength(1);
    expect(frames(paneOf() as HTMLElement)[0]?.getAttribute("title")).toBe("Visual: Chart c1");
    expect(host.querySelector('[role="tab"]')?.textContent).toContain("VisualChart c1");
    expect(chat().textContent).toContain("Shown in the Visual Pane");
    expect(buttonIn(chat(), "Pop out")).toBeUndefined();

    // On a phone the Pane area is a full-screen sheet (it is the same area, and an App Pane's).
    expect(host.querySelector("aside")?.className).toContain("fixed inset-0");
  });

  it("brings the Visual back to its card with Show here, from the card's note or the Pane's header", () => {
    session();
    show();
    click(buttonIn(chat(), "Pop out"));

    click(buttonIn(chat(), "Show here"));

    expect(registry.get(panesAtom).open).toEqual([]);
    expect(paneOf()).toBeNull();
    expect(frames(chat())).toHaveLength(1);
    expect(chat().textContent).not.toContain("Shown in");

    click(buttonIn(chat(), "Pop out"));
    click(buttonIn(paneOf() as HTMLElement, "Show here"));

    expect(registry.get(panesAtom).open).toEqual([]);
    expect(frames(chat())).toHaveLength(1);

    click(buttonIn(chat(), "Pop out"));
    click(buttonIn(host, "Close Visual Chart c1"));

    expect(frames(chat())).toHaveLength(1);
  });

  it("pops out a Visual a codemode script showed, from the strip under its card", () => {
    session();
    show();

    expect(frames(chat("script"))).toHaveLength(1);

    click(buttonIn(chat("script"), "Pop out"));

    expect(registry.get(panesAtom).open).toEqual(["visual:n1"]);
    expect(frames(paneOf() as HTMLElement)).toHaveLength(1);
    expect(frames(chat("script"))).toHaveLength(0);
    expect(chat("script").textContent).toContain("Shown in the Visual Pane");

    click(buttonIn(chat("script"), "Show here"));
    expect(frames(chat("script"))).toHaveLength(1);
  });

  it("pops out from a subagent's thread, and every card of the Visual says where it is", () => {
    session();
    threadCopy = true;
    show();

    const thread = host.querySelector<HTMLElement>('[data-testid="subagent-pane"]') as HTMLElement;

    // The thread's card holds the frame (a Subagent Pane's place outranks the transcript's), and the transcript's says so.
    expect(frames(thread)).toHaveLength(1);
    expect(chat().textContent).toContain("Shown in the Subagent Pane");

    click(buttonIn(thread, "Pop out"));

    expect(registry.get(panesAtom).open).toEqual(["visual:c1"]);
    expect(frames(paneOf() as HTMLElement)).toHaveLength(1);
    expect(frames(thread)).toHaveLength(0);
    expect(thread.textContent).toContain("Shown in the Visual Pane");
    expect(chat().textContent).toContain("Shown in the Visual Pane");

    // Back: the Subagent Pane's thread has it again, as before the Pane.
    click(buttonIn(thread, "Show here"));
    expect(frames(thread)).toHaveLength(1);
    expect(chat().textContent).toContain("Shown in the Subagent Pane");
  });
});

describe("a Visual Pane the page opens with", () => {
  it("mounts it from the URL alone, with its card saying so, as a link or a Session left with it opens", () => {
    window.history.replaceState(null, "", "/sessions/s1?pane=visual:c1");
    session();
    show();

    expect(frames(paneOf() as HTMLElement)).toHaveLength(1);
    expect(frames(chat())).toHaveLength(0);
    expect(chat().textContent).toContain("Shown in the Visual Pane");
  });

  it("loads a Visual the Session's list has not sent yet by its call, and says so for one the Session does not have", () => {
    window.history.replaceState(null, "", "/sessions/s1?pane=visual:other&pane=visual:gone");
    session({
      other: { status: "page", record: recordOf("other"), origin: ORIGIN },
      gone: { status: "none" },
    });
    show();

    const panes = Array.from(host.querySelectorAll<HTMLElement>('[role="tabpanel"][data-pane]'));

    expect(frames(panes[0])).toHaveLength(1);
    expect(panes[0]?.textContent).toContain("Chart other");
    expect(panes[1]?.textContent).toContain("This Visual is not in this Session.");
    expect(frames(panes[1])).toHaveLength(0);
  });

  it("says an evicted Visual is no longer kept, and shows no frame", () => {
    window.history.replaceState(null, "", "/sessions/s1?pane=visual:old");
    session();
    show();

    expect(paneOf()?.textContent).toContain("no longer kept");
    expect(frames(paneOf() as HTMLElement)).toHaveLength(0);
  });

  it("says why a Visual could not start, with Retry", () => {
    window.history.replaceState(null, "", "/sessions/s1?pane=visual:c1");
    session({ c1: { status: "failed", reason: "The Session said no" } });
    show();

    expect(paneOf()?.textContent).toContain("Visual couldn't start: The Session said no");
    expect(buttonIn(paneOf() as HTMLElement, "Retry")).toBeDefined();
  });
});
