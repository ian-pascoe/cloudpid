// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// docs/architecture/mcp-apps.md → App Views in the transcript (Where it renders), App Panes. A call's View as its places mount it,
// in a DOM with real frames and bridges: one place mounts it, by precedence, and the rest say where it is shown. The acceptance
// path of the card, the Pane area and the App Pane over the app's atoms is `app-acceptance.test.tsx`; this is the places
// among themselves, which a Subagent Pane or page needs a Session of its own for.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of a fake frame: JSON-RPC as a case posts it, cut down to the shape a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off newPromise:off asyncFunction:off -- a DOM and its timers, driven by hand.
import type { McpAppRecord } from "@cloudpid/protocol";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppPlaceMount,
  AppPlacesContext,
  type AppFacts,
  type AppLoadedProps,
  type AppPlaceMountProps,
} from "./app-call.tsx";
import { AppFrame } from "./app-frame.tsx";
import { focusChatOnEscape } from "./app-pane.tsx";
import { installFakeFrames, ORIGIN, viewOf } from "./frame-kit.testing.ts";
import type { AppPage } from "./load.ts";
import { AppPlaces } from "../sandbox-frame/places.ts";

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

const FACTS: AppFacts = {
  sessionId: "s1",
  callId: "c1",
  tool: undefined,
  server: "docs",
  availability: { kind: "mount", badge: null },
  badge: null,
  mountable: true,
  archived: false,
  context: undefined,
  kept: true,
};

// What loads a View in a place, in place of the atoms (which need a Session): the record and page at once.
const Loaded = (props: AppLoadedProps) => (
  <AppFrame
    record={record}
    page={PAGE}
    tool={undefined}
    badge={props.facts.badge}
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
    facts={FACTS}
    place="card"
    live
    idle={null}
    controls={{}}
    onRequestMode={() => undefined}
    Loaded={Loaded}
    {...props}
  />
);

/**
 * A card and a Subagent Pane's thread showing the same call, the Pane's present only when asked for, and an App Pane that
 * Pop out opens in either (the Pane area's part is `app-acceptance.test.tsx`).
 */
const Chat = ({ subagentPane = false }: { subagentPane?: boolean }) => {
  const [popped, setPopped] = useState(false);
  const popOut = { onPopOut: () => setPopped(true) };

  return (
    <>
      <div data-place="card">
        <Place controls={popOut} />
      </div>
      {subagentPane && (
        <div data-place="subagent-pane">
          <Place place="subagent-pane" controls={popOut} />
        </div>
      )}
      {popped && (
        <div data-place="app-pane">
          <Place place="app-pane" />
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

describe("one mount per page", () => {
  it("mounts the View in a Subagent Pane in place of a card's, the card saying where it is", async () => {
    show(<Chat />);

    const card = started();

    show(<Chat subagentPane />);
    expect(card.methods()).toEqual(["ui/resource-teardown"]);

    card.answerTeardown();
    await settle();

    expect(frames(inPlace("card"))).toHaveLength(0);
    expect(inPlace("card").textContent).toContain("Shown in the Subagent Pane");
    expect(frames(inPlace("subagent-pane"))).toHaveLength(1);
  });

  it("lets an App Pane take it from a Subagent Pane", async () => {
    show(<Chat subagentPane />);

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
