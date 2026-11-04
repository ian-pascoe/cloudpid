// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// docs/architecture/mcp-apps.md → App Views in the transcript (Which App Views are live, Remounting), App Panes. A call's View
// as its places mount it, in a DOM with real frames and bridges: only a live View is mounted and an older one is collapsed
// with Reopen, a View moves to an App Pane (Pop out, or a `fullscreen` request) with the old frame torn down before the new
// one mounts, a Subagent Pane takes it from a card, and a page's own unmount waits for the View.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of a fake frame: JSON-RPC as a case posts it, cut down to the shape a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off newPromise:off asyncFunction:off -- a DOM and its timers, driven by hand.
import type { McpAppRecord } from "@cloudpid/protocol";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppPlaceMount,
  AppPlacesContext,
  type AppLoadedProps,
  type AppPlaceMountProps,
} from "./app-call.tsx";
import { AppFrame } from "./app-frame.tsx";
import { focusChatOnEscape } from "./app-pane.tsx";
import { installFakeFrames, ORIGIN, viewOf } from "./frame-kit.testing.ts";
import { isAppLive } from "./generation.ts";
import type { AppPage } from "./load.ts";
import { AppPlaces } from "./places.ts";
import { afterTeardown } from "./teardown.ts";

const record: McpAppRecord = {
  callId: "c1",
  server: "docs",
  tool: "page",
  conversation: "1",
  arguments: {},
  result: { content: [{ type: "text", text: "hi" }] },
  audit: [],
  at: 1,
};

const PAGE: AppPage = { html: "<p>view</p>", meta: {}, origin: ORIGIN };

installFakeFrames();

// What loads a View in a place, in place of the atoms (which need a Session): the record and page at once.
const Loaded = (props: AppLoadedProps) => (
  <AppFrame
    record={record}
    page={PAGE}
    tool={undefined}
    badge={props.badge}
    place={props.place}
    controls={props.controls}
    onRequestMode={props.onRequestMode}
    onFocused={props.onFocused}
    closing={props.closing}
    onClosed={props.onClosed}
  />
);

const Place = (props: Partial<AppPlaceMountProps>) => (
  <AppPlaceMount
    sessionId="s1"
    callId="c1"
    place="card"
    tool={undefined}
    badge={null}
    live
    idle={null}
    controls={{}}
    onRequestMode={() => undefined}
    Loaded={Loaded}
    {...props}
  />
);

/**
 * A card and, once the View is popped out, an App Pane, as `AppCall` and `AppPane` make them from the atoms: the card is live
 * by the generation rule and what the owner chose (`isAppLive`), and Pop out opens the Pane.
 */
const Chat = ({
  newest,
  archived = false,
  subagentPane = false,
  poppedOut = false,
}: {
  newest: boolean;
  archived?: boolean;
  subagentPane?: boolean;
  poppedOut?: boolean;
}) => {
  const [choice, setChoice] = useState<"open" | "collapsed" | undefined>(undefined);
  const [focused, setFocused] = useState(false);
  const [popped, setPopped] = useState(poppedOut);

  const live = isAppLive({ newest, choice, archived, focused });

  return (
    <>
      <div data-place="card">
        <Place
          live={live}
          idle={
            <div>
              collapsed
              <button
                type="button"
                onClick={() => {
                  setChoice("open");
                }}
              >
                Reopen
              </button>
            </div>
          }
          controls={{
            onCollapse: () => {
              setChoice("collapsed");
            },
            onPopOut: () => {
              setPopped(true);
            },
          }}
          onRequestMode={(mode) => {
            if (mode === "fullscreen") setPopped(true);
          }}
          onFocused={setFocused}
        />
      </div>
      {subagentPane && (
        <div data-place="subagent-pane">
          <Place
            place="subagent-pane"
            controls={{
              onPopOut: () => {
                setPopped(true);
              },
            }}
          />
        </div>
      )}
      {popped && (
        <div data-place="app-pane" data-app-pane="c1">
          <Place
            place="app-pane"
            controls={{
              onBack: () => {
                // The Pane area's close: the View in it is torn down before the Pane is unmounted.
                afterTeardown(() => {
                  setPopped(false);
                }, document.querySelector("[data-app-pane]"));
              },
            }}
            onRequestMode={(mode) => {
              if (mode === "inline") setPopped(false);
            }}
          />
        </div>
      )}
    </>
  );
};

let host: HTMLDivElement;
let root: Root;
let places: AppPlaces;

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
  places = new AppPlaces();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const show = (node: ReactNode) => {
  act(() => {
    root.render(<AppPlacesContext value={places}>{node}</AppPlacesContext>);
  });
};

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

const frames = (within: ParentNode = host) => Array.from(within.querySelectorAll("iframe"));
const inPlace = (place: string) => host.querySelector(`[data-place="${place}"]`) as HTMLElement;

const buttonIn = (within: ParentNode, name: string) =>
  Array.from(within.querySelectorAll("button")).find((each) => each.textContent === name);

const click = (button: HTMLElement | undefined) => {
  act(() => {
    button?.click();
  });
};

/** The frame in `within`, with its handshake done and what it was sent so far forgotten. */
const started = (within: ParentNode = host) => {
  const view = viewOf(within.querySelector("iframe"));

  view.handshake();
  view.sent.length = 0;

  return view;
};

describe("only the newest generation is live", () => {
  it("mounts the View of a call in the newest generation, with its frame", () => {
    show(<Chat newest />);

    expect(frames()).toHaveLength(1);
    expect(host.textContent).not.toContain("collapsed");
  });

  it("collapses an older generation's View to a row with Reopen, mounting no frame", () => {
    show(<Chat newest={false} />);

    expect(frames()).toHaveLength(0);
    expect(host.textContent).toContain("collapsed");
    expect(buttonIn(host, "Reopen")).toBeDefined();
  });

  it("tells a live View to tear down when a newer generation retires it, and collapses it when it has", async () => {
    show(<Chat newest />);

    const view = started();

    show(<Chat newest={false} />);

    // Told, and the frame is still there to hear it; the row is not yet.
    expect(view.methods()).toEqual(["ui/resource-teardown"]);
    expect(frames()).toEqual([view.element]);
    expect(host.textContent).not.toContain("collapsed");

    view.answerTeardown();
    await settle();

    expect(frames()).toHaveLength(0);
    expect(host.textContent).toContain("collapsed");
  });

  it("keeps an older View live once the owner reopens it, until they collapse it", async () => {
    show(<Chat newest={false} />);
    click(buttonIn(host, "Reopen"));

    const view = started();

    expect(frames()).toEqual([view.element]);

    click(buttonIn(host, "Collapse"));
    expect(view.methods()).toEqual(["ui/resource-teardown"]);
    view.answerTeardown();
    await settle();

    expect(frames()).toHaveLength(0);
    expect(buttonIn(host, "Reopen")).toBeDefined();
  });

  it("mounts a new frame for a View reopened after it collapsed, never the dead one", async () => {
    show(<Chat newest />);

    const first = started();

    click(buttonIn(host, "Collapse"));
    first.answerTeardown();
    await settle();
    click(buttonIn(host, "Reopen"));

    expect(frames()).toHaveLength(1);
    expect(frames()[0]).not.toBe(first.element);
  });

  it("is collapsed in an archived Session until it is reopened", () => {
    show(<Chat newest archived />);

    expect(frames()).toHaveLength(0);
    expect(buttonIn(host, "Reopen")).toBeDefined();

    click(buttonIn(host, "Reopen"));
    expect(frames()).toHaveLength(1);
  });

  it("does not collapse a View the owner is using for a newer generation", () => {
    show(<Chat newest />);

    const view = started();

    // Focus moves into the frame: the window blurs and the frame is the active element.
    act(() => {
      view.element?.setAttribute("tabindex", "0");
      view.element?.focus();
      window.dispatchEvent(new Event("blur"));
    });

    show(<Chat newest={false} />);

    expect(view.methods()).toEqual([]);
    expect(frames()).toEqual([view.element]);
  });
});

describe("Pop out and fullscreen move the View, tearing down first", () => {
  it("tears the card's View down before the App Pane's frame is mounted, then says where it is", async () => {
    show(<Chat newest />);

    const card = started();

    click(buttonIn(host, "Pop out"));

    // The card's frame is told, and is still the only one: the Pane waits for it.
    expect(card.methods()).toEqual(["ui/resource-teardown"]);
    expect(frames()).toEqual([card.element]);
    expect(frames(inPlace("app-pane"))).toHaveLength(0);

    card.answerTeardown();
    await settle();

    expect(frames(inPlace("card"))).toHaveLength(0);
    expect(inPlace("card").textContent).toContain("Shown in the App Pane");
    expect(frames(inPlace("app-pane"))).toHaveLength(1);
    expect(frames()).toHaveLength(1);
  });

  it("does the same for a View's request for `fullscreen`, answering the mode it will be in", async () => {
    show(<Chat newest />);

    const card = started();

    card.say({
      jsonrpc: "2.0",
      id: 9,
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    await settle();

    expect(card.sent.find((each) => each.data["id"] === 9)?.data["result"]).toEqual({
      mode: "fullscreen",
    });
    expect(card.methods()).toContain("ui/resource-teardown");
    expect(frames(inPlace("app-pane"))).toHaveLength(0);

    card.answerTeardown();
    await settle();

    expect(frames(inPlace("app-pane"))).toHaveLength(1);
  });

  it("puts the View back in its card, the Pane's frame torn down first, when the Pane goes", async () => {
    show(<Chat newest poppedOut />);

    const pane = started(inPlace("app-pane"));

    click(buttonIn(inPlace("app-pane"), "Back to chat"));

    expect(pane.methods()).toEqual(["ui/resource-teardown"]);
    expect(frames()).toEqual([pane.element]);

    pane.answerTeardown();
    await settle();

    expect(inPlace("app-pane")).toBeNull();
    expect(frames()).toHaveLength(1);
    expect(frames(inPlace("card"))).toHaveLength(1);
    expect(frames()[0]).not.toBe(pane.element);
  });

  it("puts it back for a request for `inline` from the App Pane", async () => {
    show(<Chat newest poppedOut />);

    const pane = started(inPlace("app-pane"));

    pane.say({
      jsonrpc: "2.0",
      id: 5,
      method: "ui/request-display-mode",
      params: { mode: "inline" },
    });
    await settle();

    // The Pane is gone at once (this stand-in closes it directly), and the card mounts its View.
    expect(frames(inPlace("card"))).toHaveLength(1);
  });

  it("collapses nothing for a card whose View is shown in a Pane: it is shown there, live or not", () => {
    show(<Chat newest={false} poppedOut />);

    expect(inPlace("card").textContent).toContain("Shown in the App Pane");
    expect(inPlace("card").textContent).not.toContain("collapsed");
    expect(frames()).toHaveLength(1);
  });
});

describe("one mount per page", () => {
  it("mounts the View in a Subagent Pane in place of a card's, the card saying where it is", async () => {
    show(<Chat newest />);

    const card = started();

    show(<Chat newest subagentPane />);
    expect(card.methods()).toEqual(["ui/resource-teardown"]);

    card.answerTeardown();
    await settle();

    expect(frames(inPlace("card"))).toHaveLength(0);
    expect(inPlace("card").textContent).toContain("Shown in the Subagent Pane");
    expect(frames(inPlace("subagent-pane"))).toHaveLength(1);
  });

  it("lets an App Pane take it from a Subagent Pane", async () => {
    show(<Chat newest subagentPane />);

    const sub = started();

    click(buttonIn(inPlace("subagent-pane"), "Pop out"));
    expect(sub.methods()).toEqual(["ui/resource-teardown"]);
    sub.answerTeardown();
    await settle();

    expect(frames()).toHaveLength(1);
    expect(frames(inPlace("app-pane"))).toHaveLength(1);
    expect(inPlace("subagent-pane").textContent).toContain("Shown in the App Pane");
  });
});

describe("the page's own unmounts wait for the View", () => {
  it("unmounts a place that is leaving only once its View has answered", async () => {
    show(<Chat newest />);

    const view = started();

    afterTeardown(() => {
      show(null);
    });

    // Asked, and the frame is still in the document.
    expect(view.methods()).toEqual(["ui/resource-teardown"]);
    expect(frames()).toEqual([view.element]);

    view.answerTeardown();
    await settle();

    expect(frames()).toHaveLength(0);
  });
});

describe("Escape in an App Pane", () => {
  it("returns the focus to the chat's composer, and leaves any other key alone", () => {
    const input = document.createElement("textarea");

    input.setAttribute("aria-label", "Message");
    document.body.append(input);

    const press = (key: string) => {
      const event = { key, defaultPrevented: false, preventDefault: vi.fn() };

      focusChatOnEscape(event);

      return event;
    };

    expect(press("a").preventDefault).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);

    expect(press("Escape").preventDefault).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});
