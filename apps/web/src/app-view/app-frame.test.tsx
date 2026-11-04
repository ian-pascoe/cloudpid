// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
// docs/architecture/mcp-apps.md → App Views in the transcript (Teardown). The card's frame in a DOM: a View that is ended by its
// card (eviction, a server gone or shadowed, another page, Retry) is told to tear down while its frame is still in the
// document, and the frame leaves only once it has answered, or after 2 s; what is about to unmount a frame asks the registry
// to tear its View down first; and a View asks for a display mode.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions -- the traffic of a fake frame: JSON-RPC as a case posts it, cut down to the shape a case reads */
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalTimers:off newPromise:off asyncFunction:off -- a DOM and its timers, driven by hand.
import type { McpAppRecord, McpAppRequestAnswer } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppFrame, type AppFrameProps } from "./app-frame.tsx";
import { TEARDOWN_TIMEOUT_MS } from "./bridge.ts";
import { afterTeardown, appViews } from "./teardown.ts";
import { installFakeFrames, ORIGIN, type Sent, viewOf } from "./frame-kit.testing.ts";
import type { AppPage } from "./load.ts";
import type { AppRequestClient } from "./requests.ts";

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

// A page is the same page by identity (the loader hands one object for one page), so a card is not told it changed.
const PAGE_A = pageAt(ORIGIN);
const PAGE_B = pageAt(OTHER);

installFakeFrames();

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

/** The frame in the card. */
const frameOf = () => viewOf(host.querySelector("iframe"));

const render = (props: Partial<AppFrameProps> = {}) => {
  act(() => {
    root.render(
      <AppFrame
        record={record}
        page={PAGE_A}
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

  it("says it may go once, though it is asked to close again and again", async () => {
    const closed = vi.fn();

    render({ onClosed: closed });
    frameOf().handshake();
    render({ onClosed: closed, closing: true });
    render({ onClosed: closed, closing: false });
    render({ onClosed: closed, closing: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEARDOWN_TIMEOUT_MS);
    });

    expect(closed).toHaveBeenCalledTimes(1);
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

    render({ page: PAGE_B });

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

/** What the page posted to the frame in answer to request `id`, when it has. */
const answerTo = (sent: readonly Sent[], id: number) =>
  sent.find((each) => each.data["id"] === id)?.data;

const settle = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe("what asks a View to tear down before its frame is unmounted", () => {
  it("asks every mounted View, and says when each has answered, leaving the frame in the document", async () => {
    render();

    const view = frameOf();

    view.handshake();
    view.sent.length = 0;

    const done = vi.fn();

    void appViews.tearDown().then(done);

    expect(view.methods()).toEqual(["ui/resource-teardown"]);
    expect(host.querySelector("iframe")).toBe(view.element);
    expect(done).not.toHaveBeenCalled();

    view.say({ jsonrpc: "2.0", id: view.sent[0]?.data["id"], result: {} });
    await settle();

    expect(done).toHaveBeenCalledTimes(1);
    // The caller removes the frame; nothing remade it.
    expect(host.querySelector("iframe")).toBe(view.element);
  });

  it("waits at most 2 s for a View that does not answer", async () => {
    render();
    frameOf().handshake();

    const done = vi.fn();

    void appViews.tearDown().then(done);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TEARDOWN_TIMEOUT_MS - 1);
    });
    expect(done).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("asks only the Views inside what is about to go", () => {
    render();

    const view = frameOf();

    view.handshake();
    view.sent.length = 0;

    const elsewhere = document.createElement("div");

    void appViews.tearDown(elsewhere);
    expect(view.methods()).toEqual([]);

    void appViews.tearDown(host);
    expect(view.methods()).toEqual(["ui/resource-teardown"]);
  });

  it("runs the action at once when no View is mounted, and after the teardown when one is", async () => {
    const action = vi.fn();

    afterTeardown(action);
    expect(action).toHaveBeenCalledTimes(1);

    render();

    const view = frameOf();

    view.handshake();
    view.sent.length = 0;
    afterTeardown(action, host);

    expect(action).toHaveBeenCalledTimes(1);
    view.say({ jsonrpc: "2.0", id: view.sent[0]?.data["id"], result: {} });
    await settle();

    expect(action).toHaveBeenCalledTimes(2);
  });

  it("makes a new frame for a place that stays (a branch switch), once its View has torn down", async () => {
    render();

    const old = frameOf();

    old.handshake();
    old.sent.length = 0;

    void appViews.tearDown(host, true);
    old.say({ jsonrpc: "2.0", id: old.sent[0]?.data["id"], result: {} });
    await settle();

    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    expect(host.querySelector("iframe")).not.toBe(old.element);
  });

  it("asks a View once when its place ends it and a guard asks at the same time", () => {
    const closed = vi.fn();

    render({ onClosed: closed });

    const view = frameOf();

    view.handshake();
    view.sent.length = 0;
    // The place ends it, and a guard asks at the same time.
    render({ onClosed: closed, closing: true });
    void appViews.tearDown();

    expect(view.methods()).toEqual(["ui/resource-teardown"]);
  });
});

describe("a View's display modes", () => {
  /** The host context the page answered `ui/initialize` with. */
  const contextOf = (sent: readonly Sent[]) => {
    const result = answerTo(sent, 1)?.["result"] as { hostContext: Record<string, unknown> };

    return result.hostContext;
  };

  it("is told `inline` in a card, with both modes on offer, and its width fixed and height flexible", async () => {
    render();

    const view = frameOf();

    view.handshake();
    await settle();

    expect(contextOf(view.sent)).toMatchObject({
      displayMode: "inline",
      availableDisplayModes: ["inline", "fullscreen"],
    });
    expect(contextOf(view.sent)["containerDimensions"]).toHaveProperty("maxHeight");
    expect(contextOf(view.sent)).not.toHaveProperty("safeAreaInsets");
  });

  it("is told `fullscreen` in an App Pane, with both axes fixed, and fills the Pane", async () => {
    render({ place: "app-pane" });

    const view = frameOf();

    view.handshake();
    await settle();

    expect(contextOf(view.sent)).toMatchObject({ displayMode: "fullscreen" });
    expect(contextOf(view.sent)["containerDimensions"]).toHaveProperty("height");
    expect(contextOf(view.sent)["containerDimensions"]).not.toHaveProperty("maxHeight");
    expect(view.element.getAttribute("style")).toBeNull();
    expect(host.querySelector("[data-app-view]")?.className).toContain("flex-1");
  });

  it("hands a request for `fullscreen` to its place, and answers the mode it will be in", async () => {
    const request = vi.fn();

    render({ onRequestMode: request });

    const view = frameOf();

    view.handshake();
    view.say({
      jsonrpc: "2.0",
      id: 7,
      method: "ui/request-display-mode",
      params: { mode: "fullscreen" },
    });
    await settle();

    expect(request).toHaveBeenCalledWith("fullscreen");
    expect(answerTo(view.sent, 7)?.["result"]).toEqual({ mode: "fullscreen" });
  });

  it("refuses `pip` with the mode it is in, and asks its place for nothing", async () => {
    const request = vi.fn();

    render({ onRequestMode: request });

    const view = frameOf();

    view.handshake();
    view.say({
      jsonrpc: "2.0",
      id: 8,
      method: "ui/request-display-mode",
      params: { mode: "pip" },
    });
    await settle();

    expect(request).not.toHaveBeenCalled();
    expect(answerTo(view.sent, 8)?.["result"]).toEqual({ mode: "inline" });
  });
});

describe("a frame's header", () => {
  it("has the buttons its place gives it, and each does what it says", () => {
    const controls = { onCollapse: vi.fn(), onPopOut: vi.fn(), onBack: vi.fn() };

    render({ controls });

    const button = (name: string) =>
      Array.from(host.querySelectorAll("button")).find((each) => each.textContent === name);

    act(() => {
      button("Collapse")?.click();
      button("Pop out")?.click();
      button("Back to chat")?.click();
    });

    expect(controls.onCollapse).toHaveBeenCalledTimes(1);
    expect(controls.onPopOut).toHaveBeenCalledTimes(1);
    expect(controls.onBack).toHaveBeenCalledTimes(1);
  });

  it("has none a place does not give", () => {
    render({ controls: { onBack: vi.fn() } });

    const labels = Array.from(host.querySelectorAll("button")).map((each) => each.textContent);

    expect(labels).toEqual(["Back to chat", "Details"]);
  });
});

describe("a View's requests of its server, and signing in", () => {
  const SIGN_IN = (stepUp: boolean) => `/oauth/mcp/start?server=docs&step_up=${stepUp ? 1 : 0}`;

  const logged: Array<readonly [string, string, string]> = [];

  const answering = (answer: McpAppRequestAnswer): AppRequestClient => ({
    appRequest: () => Effect.succeed(answer),
    appLog: (callId, level, _logger, message) => {
      logged.push([callId, level, message]);
    },
  });

  const ask = (view: ReturnType<typeof frameOf>, id: number, method = "tools/call") => {
    view.say({ jsonrpc: "2.0", id, method, params: { name: "weather" } });
  };

  const answerTo = (view: ReturnType<typeof frameOf>, id: number) =>
    view.sent.find((each) => each.data["id"] === id)?.data;

  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

  it("advertises the server calls it serves, and answers a View's tools/call with the Session's result", async () => {
    render({ client: answering({ status: "result", result: { content: [] } }) });

    const view = frameOf();

    view.handshake();
    await flush();

    const initialized = view.sent.find((each) => each.data["id"] === 1)?.data;

    expect(initialized).toMatchObject({
      result: { hostCapabilities: { serverTools: {}, serverResources: {} } },
    });

    ask(view, 7);
    await flush();

    expect(answerTo(view, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [] } });
  });

  it("advertises no server calls, and answers them as not found, when it has no client to serve them", async () => {
    render();

    const view = frameOf();

    view.handshake();
    ask(view, 8);
    await flush();

    const initialized = view.sent.find((each) => each.data["id"] === 1)?.data;

    expect(initialized).toMatchObject({ result: { hostCapabilities: { sandbox: {} } } });
    expect(JSON.stringify(initialized)).not.toContain("serverTools");
    expect(JSON.stringify(initialized)).not.toContain("serverResources");
    expect(answerTo(view, 8)).toMatchObject({ error: { code: -32_601 } });
  });

  it("hands a View's log lines to the Session for its call, and drops them when it has no client", async () => {
    render({ client: answering({ status: "result", result: {} }) });

    const view = frameOf();

    view.handshake();
    view.say({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "warning", data: "from the view" },
    });

    expect(logged).toEqual([["c1", "warning", "from the view"]]);
  });

  it("keeps the last 50 of the record's audit log and the new entries in the details", async () => {
    const entry = (at: number) => ({ at, kind: "tools/call", summary: `call ${at}` });

    render({
      client: answering({ status: "result", result: {}, audit: entry(50) }),
      record: { ...record, audit: Array.from({ length: 50 }, (_, at) => entry(at)) },
    });

    const view = frameOf();

    view.handshake();
    ask(view, 9);
    await flush();

    act(() => {
      host
        .querySelector("button[aria-expanded]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const lines = Array.from(host.querySelectorAll("ul[aria-label='Audit log'] li")).map(
      (each) => each.textContent ?? "",
    );

    expect(lines).toHaveLength(50);
    expect(lines[0]).toContain("call 1");
    expect(lines.at(-1)).toContain("call 50");
  });

  it("answers the Session's error as the View's, and links Sign in when the server needs it", async () => {
    render({
      client: answering({
        status: "error",
        code: -32_000,
        message: "Sign in to docs",
        reason: "sign_in",
        server: "docs",
        stepUp: true,
        audit: {
          at: 1_700_000_000_000,
          kind: "tools/call",
          summary: "tools/call weather → refused",
        },
      }),
      signInHref: SIGN_IN,
    });

    const view = frameOf();

    view.handshake();
    expect(host.querySelector("a")).toBeNull();

    ask(view, 9);
    await flush();

    expect(answerTo(view, 9)).toMatchObject({
      error: { code: -32_000, message: "Sign in to docs" },
    });
    expect(host.textContent).toContain("Needs sign-in");

    const link = host.querySelector("a");

    expect(link?.getAttribute("href")).toBe(SIGN_IN(true));
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener");
  });

  it("links Sign in beside the badge of a server that needs it, and shows the audit log in the details", () => {
    render({
      badge: "sign-in",
      signInHref: SIGN_IN,
      record: {
        ...record,
        audit: [{ at: 1_700_000_000_000, kind: "tools/call", summary: "tools/call weather → ok" }],
      },
    });

    expect(host.textContent).toContain("Needs sign-in");
    expect(host.querySelector("a")?.getAttribute("href")).toBe(SIGN_IN(false));

    expect(host.textContent).not.toContain("tools/call weather → ok");

    act(() => {
      host
        .querySelector("button[aria-expanded]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(host.querySelector("ul[aria-label='Audit log']")?.textContent).toContain(
      "tools/call weather → ok",
    );
  });

  it("shows no link while the Environment is not known", () => {
    render({ badge: "sign-in", signInHref: () => undefined });

    expect(host.textContent).toContain("Needs sign-in");
    expect(host.querySelector("a")).toBeNull();
  });
});
