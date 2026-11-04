// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// docs/architecture/mcp-apps.md → App Panes, App Views in the transcript (Remounting, Teardown). The acceptance path with the
// real components over the app's atoms: a call's card (`AppCall`) and the Pane area (`PaneArea` with its `AppPane`), real
// frames and bridges, only the Session's socket and the sandbox page replaced. Pop out writes the Panes the page has
// open, the Pane area mounts the App Pane, closing a Pane waits for its View to tear down, and the card says where its
// View is and brings it back.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of a fake frame: JSON-RPC as a case posts it, cut down to the shape a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off newPromise:off asyncFunction:off -- a DOM and its timers, driven by hand.
import type {
  McpAppEntry,
  SessionTree,
  McpAppRecord,
  McpAppTool,
  SessionView,
  TranscriptMessage,
} from "@cloudpid/protocol";
import { EMPTY_VIEW } from "@cloudpid/protocol";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShownSession, ThreadPlace } from "../chat/conversation.ts";
import { useBranchMove } from "../chat/tree-actions.ts";
import { sessionTreeAtom } from "../chat/tree-state.ts";
import { keptByPoint } from "../session/tree.ts";
import { PaneArea } from "../pane-area.tsx";
import { panesAtom } from "../panes-state.ts";
import { RegistryClient } from "../registry.ts";
import { fakeRegistryLayer } from "../registry.testing.ts";
import { sessionClientAtom, sessionViewAtom } from "../session/atoms.ts";
import { INITIAL_SESSION_STATE, type SessionState } from "../session/state.ts";
import { sessionListAtom } from "../sessions.ts";
import { keyValueStoreLayer } from "../storage.ts";
import { AppCall, AppPlacesContext } from "./app-call.tsx";
import { appKey, appLoadAtom } from "./atoms.ts";
import { POLL_MS } from "./focus.ts";
import { installFakeFrames, ORIGIN, viewOf } from "./frame-kit.testing.ts";
import type { AppPage } from "./load.ts";
import { AppPlaces } from "./places.ts";
import type { AppRequestClient } from "./requests.ts";

const TOOL: McpAppTool = {
  name: "mcp__docs__page",
  server: "docs",
  tool: "page",
  uri: "ui://docs/page",
  visibility: ["model", "app"],
};

const recordOf = (callId: string): McpAppRecord => ({
  callId,
  server: "docs",
  tool: "page",
  conversation: "1",
  arguments: {},
  result: { content: [{ type: "text", text: "hi" }] },
  audit: [],
  at: 1,
});

const PAGE: AppPage = { html: "<p>view</p>", meta: {}, origin: ORIGIN };

const entryOf = (callId: string, at: number): McpAppEntry => ({
  callId,
  server: "docs",
  tool: "page",
  state: "kept",
  at,
});

/** The calls the page shows: each in its own assistant message, in this order, the last the newest generation. */
const CALLS = ["c1", "c2"] as const;

const assistant = (id: string, ...calls: string[]): TranscriptMessage => ({
  id,
  role: "assistant",
  timestamp: 0,
  parts: calls.map((call) => ({
    type: "tool-call",
    id: call,
    name: "mcp__docs__page",
    arguments: {},
  })),
});

installFakeFrames();

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

const asked: Array<{ method: string }> = [];

/** What the Session's client does for a View's requests, recorded. */
const requests: AppRequestClient = {
  appRequest: (_callId, _requestId, method) => {
    asked.push({ method });

    return Effect.succeed({ status: "result", result: { contents: [] } });
  },
  appLog: () => undefined,
};

/** The Session's client: its state, those requests, and every other command a page may start doing nothing. */
const clientOf = (state: SubscriptionRef.SubscriptionRef<SessionState>) => {
  const own = new Map<string, unknown>(Object.entries({ ...requests, state }));

  return new Proxy(
    {},
    {
      get: (_target, key) => (Predicate.isString(key) ? (own.get(key) ?? Effect.void) : undefined),
    },
  );
};

let host: HTMLDivElement;
let root: Root;
let registry: AtomRegistry.AtomRegistry;
let places: AppPlaces;

const TREE: SessionTree = {
  nodes: [1, 2].map((id) => ({
    id,
    parent: id === 1 ? null : id - 1,
    // SAFETY: test IDs; the brand is for the type system only.
    conversationId: 1 as SessionTree["active"],
    role: "assistant" as const,
    text: `message ${id}`,
    final: false,
    timestamp: id,
  })),
  // SAFETY: test IDs; the brand is for the type system only.
  active: 1 as SessionTree["active"],
  leaf: 2,
  // SAFETY: test IDs; the brand is for the type system only.
  branches: [{ conversationId: 1 as SessionTree["active"], lastActiveAt: 1 }],
};

/** What the Session `s1` holds when its transcript has the first `count` of {@link CALLS}, one call to a message. */
const stateWith = (count: number): SessionState => {
  const calls = CALLS.slice(0, count);

  const view: SessionView = {
    ...EMPTY_VIEW,
    messages: calls.map((call, index) => assistant(String(index + 1), call)),
  };

  return {
    ...INITIAL_SESSION_STATE,
    view,
    mcpAppTools: [TOOL],
    // The Session keeps the App calls of every branch, whatever the transcript shown holds.
    mcpApps: { "1": CALLS.map((call, index) => entryOf(call, index + 1)) },
  };
};

let state: SubscriptionRef.SubscriptionRef<SessionState>;

/** The Session `s1` as the page holds it, with `count` of the calls in its transcript, and every call's View loaded. */
const session = (options: { archived?: boolean; count?: number; tree?: boolean } = {}) => {
  state = Effect.runSync(SubscriptionRef.make(stateWith(options.count ?? 1)));

  registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(keyValueStoreLayer, KeyValueStore.layerStorage(memoryStorage)),
      Atom.initialValue(RegistryClient.runtime.layer, fakeRegistryLayer({})),
      // SAFETY: a stand-in for the client, which a page reads its state and requests through.
      Atom.initialValue(sessionClientAtom("s1"), AsyncResult.success(clientOf(state) as never)),
      Atom.initialValue(
        sessionListAtom,
        // SAFETY: the list is read for `archivedAt` and the Environment, which is all this gives.
        options.archived === true ? ([{ id: "s1", archivedAt: 1 }] as never) : [],
      ),
      // The Session tree: message 1 (call c1) and message 2 (call c2), one after the other.
      Atom.initialValue(
        sessionTreeAtom("s1"),
        options.tree === false ? AsyncResult.initial() : AsyncResult.success(TREE),
      ),
      ...CALLS.map((call) =>
        Atom.initialValue(
          appLoadAtom(appKey("s1", call)),
          AsyncResult.success({ status: "view" as const, record: recordOf(call), page: PAGE }),
        ),
      ),
    ],
  });

  registry.mount(sessionTreeAtom("s1"));

  // Held, so that a card that unmounts and mounts again finds the load it was given, as the app's own cache would give it.
  for (const call of CALLS) registry.mount(appLoadAtom(appKey("s1", call)));
};

/** A newer message arrives: the transcript now has `count` of the calls. */
const transcriptGrows = async (count: number) => {
  Effect.runSync(SubscriptionRef.set(state, stateWith(count)));
  await settle();
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
  asked.length = 0;
  subagentPane = false;
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

/**
 * What moves the active branch to just after message 1, as the tree's actions do: it changes the transcript to message 1
 * alone, so the card of call c2 is gone, unless `moved` is false and the move is refused.
 */
let moved = true;

const move = vi.fn(() => {
  if (!moved) return Promise.resolve(Exit.fail("refused"));

  Effect.runSync(SubscriptionRef.set(state, stateWith(1)));

  return Promise.resolve(Exit.void);
});

const report = vi.fn();

const Mover = () => {
  const moveBranch = useBranchMove("s1");

  return (
    <button
      type="button"
      onClick={() => {
        moveBranch((tree) => keptByPoint(tree, { entryId: 1, position: "at" }), move, report);
      }}
    >
      Move
    </button>
  );
};

/** Whether a Subagent Pane's thread shows the first call too, as one open on the Session's page does. */
let subagentPane = false;

/** The transcript's cards: a call's card is there while its message is. */
const Thread = () => {
  const view = useAtomValue(sessionViewAtom("s1"));

  const calls = view.messages.flatMap((message) =>
    message.parts.flatMap((part) => (part.type === "tool-call" ? [part.id] : [])),
  );

  return (
    <div data-testid="chat">
      {calls.map((call) => (
        <div key={call} data-call={call}>
          <AppCall callId={call} toolName="mcp__docs__page" />
        </div>
      ))}
    </div>
  );
};

const Page = (): ReactNode => (
  <>
    <Mover />
    <Thread />
    {subagentPane && (
      <div data-testid="subagent-pane">
        <ThreadPlace.Provider value="subagent-pane">
          <AppCall callId="c1" toolName="mcp__docs__page" />
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
          <AppPlacesContext value={places}>
            <Page />
          </AppPlacesContext>
        </ShownSession.Provider>
      </RegistryContext.Provider>,
    );
  });
};

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

const chat = (call: string = "c1") =>
  host.querySelector<HTMLElement>(`[data-call="${call}"]`) as HTMLElement;

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

const started = (within: ParentNode) => {
  const view = viewOf(within.querySelector("iframe"));

  view.handshake();
  view.sent.length = 0;

  return view;
};

describe("only the newest generation is live", () => {
  it("mounts the newest generation's View, and collapses an older one to a row with Reopen", () => {
    session({ count: 2 });
    show();

    expect(frames(chat("c2"))).toHaveLength(1);
    expect(frames(chat("c1"))).toHaveLength(0);
    expect(chat("c1").textContent).toContain("collapsed");
    expect(buttonIn(chat("c1"), "Reopen")).toBeDefined();
  });

  it("tells a live View to tear down when a newer generation arrives, and collapses it once it has answered", async () => {
    session({ count: 1 });
    show();

    const older = started(chat("c1"));

    await transcriptGrows(2);

    expect(older.methods()).toEqual(["ui/resource-teardown"]);
    expect(frames(chat("c1"))).toEqual([older.element]);
    expect(frames(chat("c2"))).toHaveLength(1);

    older.answerTeardown();
    await settle();

    expect(frames(chat("c1"))).toHaveLength(0);
    expect(chat("c1").textContent).toContain("collapsed");
  });

  it("keeps an older View live once reopened until it is collapsed, and a reopened View is a new frame", async () => {
    session({ count: 2 });
    show();
    click(buttonIn(chat("c1"), "Reopen"));

    const reopened = started(chat("c1"));

    click(buttonIn(chat("c1"), "Collapse"));
    expect(reopened.methods()).toEqual(["ui/resource-teardown"]);
    reopened.answerTeardown();
    await settle();
    expect(frames(chat("c1"))).toHaveLength(0);

    click(buttonIn(chat("c1"), "Reopen"));
    await settle();
    expect(chat("c1").textContent).not.toContain("collapsed");
    expect(frames(chat("c1"))).toHaveLength(1);
    expect(frames(chat("c1"))[0]).not.toBe(reopened.element);
  });

  it("does not collapse the View that holds the focus, and does once the focus has moved on to another frame", async () => {
    session({ count: 1 });
    show();

    const first = started(chat("c1"));

    // Focus moves into the first frame: the window blurs.
    act(() => {
      first.element?.setAttribute("tabindex", "0");
      first.element?.focus();
      window.dispatchEvent(new Event("blur"));
    });

    await transcriptGrows(2);

    // The newer generation does not collapse the View in use.
    expect(first.methods()).toEqual([]);
    expect(frames(chat("c1"))).toEqual([first.element]);

    // Focus goes straight from one frame to the other, which fires nothing at the page.
    const second = started(chat("c2"));

    act(() => {
      second.element?.setAttribute("tabindex", "0");
      second.element?.focus();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(first.methods()).toEqual(["ui/resource-teardown"]);
    expect(second.methods()).toEqual([]);
  });
});

describe("Pop out, through the card and the Pane area", () => {
  it("writes the App Pane into the page's Panes, tears the card's View down, and then mounts the Pane's", async () => {
    session();
    show();

    const card = started(chat());

    click(buttonIn(chat(), "Pop out"));

    // The Panes the page has open now name the App's Pane, and the Pane area mounts it, empty while the card's View is told.
    expect(registry.get(panesAtom).open).toEqual(["app:c1"]);
    expect(paneOf()).not.toBeNull();
    expect(card.methods()).toEqual(["ui/resource-teardown"]);
    expect(frames(paneOf() as HTMLElement)).toHaveLength(0);
    expect(frames()).toEqual([card.element]);

    card.answerTeardown();
    await settle();

    expect(frames(chat())).toHaveLength(0);
    expect(chat().textContent).toContain("Shown in the App Pane");
    expect(frames(paneOf() as HTMLElement)).toHaveLength(1);
    expect(host.querySelector('[role="tab"]')?.textContent).toContain("App");
  });

  it("does the same for the View's own request for `fullscreen`", async () => {
    session();
    show();

    const card = started(chat());

    card.say({
      jsonrpc: "2.0",
      id: 9,
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    await settle();

    expect(registry.get(panesAtom).open).toEqual(["app:c1"]);

    card.answerTeardown();
    await settle();

    expect(frames(paneOf() as HTMLElement)).toHaveLength(1);
  });
});

describe("closing the App Pane waits for its View", () => {
  const popped = async () => {
    session();
    show();
    started(chat());
    click(buttonIn(chat(), "Pop out"));
    viewOf(chat().querySelector("iframe")).answerTeardown();
    await settle();

    return started(paneOf() as HTMLElement);
  };

  it("keeps the Pane until the View has answered, from its own button, then puts the View back in the card", async () => {
    const pane = await popped();

    click(buttonIn(paneOf() as HTMLElement, "Back to chat"));

    expect(pane.methods()).toEqual(["ui/resource-teardown"]);
    expect(registry.get(panesAtom).open).toEqual(["app:c1"]);

    pane.answerTeardown();
    await settle();

    expect(registry.get(panesAtom).open).toEqual([]);
    expect(paneOf()).toBeNull();
    expect(frames()).toHaveLength(1);
    expect(frames(chat())).toHaveLength(1);
    expect(frames(chat())[0]).not.toBe(pane.element);
  });

  it("does the same from the tab's close button", async () => {
    const pane = await popped();

    click(buttonIn(host, "Close App docs"));

    expect(pane.methods()).toEqual(["ui/resource-teardown"]);
    expect(registry.get(panesAtom).open).toEqual(["app:c1"]);

    pane.answerTeardown();
    await settle();

    expect(registry.get(panesAtom).open).toEqual([]);
  });

  it("does the same for the View's request for `inline`", async () => {
    const pane = await popped();

    pane.say({
      jsonrpc: "2.0",
      id: 5,
      method: "ui/request-display-mode",
      params: { mode: "inline" },
    });
    await settle();

    expect(pane.methods()).toContain("ui/resource-teardown");
    expect(registry.get(panesAtom).open).toEqual(["app:c1"]);

    pane.answerTeardown();
    await settle();

    expect(registry.get(panesAtom).open).toEqual([]);
    expect(frames(chat())).toHaveLength(1);
  });

  it("brings the View back from the card's \"Show here\", the Pane's View torn down before the Pane goes", async () => {
    const pane = await popped();

    click(buttonIn(chat(), "Show here"));

    expect(pane.methods()).toEqual(["ui/resource-teardown"]);
    expect(paneOf()).not.toBeNull();
    expect(frames(chat())).toHaveLength(0);

    pane.answerTeardown();
    await settle();

    expect(paneOf()).toBeNull();
    expect(frames(chat())).toHaveLength(1);
  });
});

describe("an archived Session", () => {
  it("collapses a View in the card until it is reopened, and then mounts it read only", async () => {
    session({ archived: true });
    show();

    expect(frames()).toHaveLength(0);
    expect(chat().textContent).toContain("collapsed");

    click(buttonIn(chat(), "Reopen"));

    const view = started(chat());

    expect(chat().textContent).toContain("Read only");

    // Offered reads, and no tool calls.
    view.say({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } });
    view.say({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "ui://x" } });
    await settle();
    expect(view.sent.find((each) => each.data["id"] === 1)?.data).toMatchObject({
      error: { code: -32_601 },
    });
    expect(view.sent.find((each) => each.data["id"] === 2)?.data).toMatchObject({
      result: { contents: [] },
    });
    expect(asked.map((each) => each.method)).toEqual(["resources/read"]);
  });

  it("is collapsed in an App Pane too, until reopened there", async () => {
    session({ archived: true });
    window.history.replaceState(null, "", "/sessions/s1?pane=app:c1");
    show();

    expect(frames(paneOf() as HTMLElement)).toHaveLength(0);
    expect(paneOf()?.textContent).toContain("Reopen");

    click(buttonIn(paneOf() as HTMLElement, "Reopen"));

    expect(frames(paneOf() as HTMLElement)).toHaveLength(1);
    expect(paneOf()?.textContent).toContain("Read only");
  });
});

describe("moving to another Session branch", () => {
  beforeEach(() => {
    moved = true;
    move.mockClear();
    report.mockClear();
  });

  const ready = async () => {
    // Both Views live: the older reopened by the owner.
    session({ count: 2 });
    show();
    click(buttonIn(chat("c1"), "Reopen"));
    await settle();

    return { kept: started(chat("c1")), dropped: started(chat("c2")) };
  };

  it("tears down only the View whose call the branch drops, before the move, and never reloads the one it keeps", async () => {
    const { kept, dropped } = await ready();

    click(buttonIn(host, "Move"));

    expect(dropped.methods()).toEqual(["ui/resource-teardown"]);
    expect(kept.methods()).toEqual([]);
    expect(move).not.toHaveBeenCalled();

    dropped.answerTeardown();
    await settle();

    // The move changed the transcript: the dropped call's card is gone, its frame with it, after its View had torn down; the
    // kept call's card is the same, with the same frame, never told anything.
    expect(move).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(null);
    expect(host.querySelector('[data-call="c2"]')).toBeNull();
    expect(dropped.element?.isConnected).toBe(false);
    expect(frames(chat("c1"))).toEqual([kept.element]);
    expect(kept.methods()).toEqual([]);
  });

  it("leaves an App Pane's View alone", async () => {
    const { dropped } = await ready();

    click(buttonIn(chat("c2"), "Pop out"));
    dropped.answerTeardown();
    await settle();

    const pane = started(paneOf() as HTMLElement);

    click(buttonIn(host, "Move"));
    await settle();

    expect(pane.methods()).toEqual([]);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it("makes the View it tore down again when the move did not happen", async () => {
    const { dropped } = await ready();

    moved = false;
    click(buttonIn(host, "Move"));
    dropped.answerTeardown();
    await settle();

    expect(report).toHaveBeenCalledWith("refused");
    expect(frames(chat("c2"))).toHaveLength(1);
    expect(frames(chat("c2"))[0]).not.toBe(dropped.element);
  });

  it("tears nothing down while the tree is not known, and makes the move", async () => {
    session({ count: 2, tree: false });
    show();

    const live = started(chat("c2"));

    // Refused, so that no card is unmounted by it: what is asked of the View is only what the guard asked.
    moved = false;
    click(buttonIn(host, "Move"));
    await settle();

    expect(live.methods()).toEqual([]);
    expect(move).toHaveBeenCalledTimes(1);
  });
});

describe("a call shown in a Subagent Pane", () => {
  it('says so in its card without offering "Show here", which is the App Pane\'s way back and must not end any other View', async () => {
    session({ count: 2 });
    subagentPane = true;
    show();

    // The card's View is the newest generation's c2; c1 is older, collapsed in the card and live nowhere but the Pane.
    const other = started(chat("c2"));

    // The Pane's thread claims c1 and wants it live by its own rule (reopened).
    click(buttonIn(chat("c1"), "Reopen"));
    await settle();

    expect(chat("c1").textContent).toContain("Shown in the Subagent Pane");
    expect(buttonIn(chat("c1"), "Show here")).toBeUndefined();
    expect(other.methods()).toEqual([]);
  });
});
