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
import { afterTeardown, appViews, EVERY_VIEW } from "./teardown.ts";
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

  describe("mounted as its call streams", () => {
    const running = (args: Record<string, string> | undefined, final = false) => ({
      record: undefined,
      running: { callId: "c1", server: "docs", tool: "page", arguments: args, final },
    });

    const partials = (view: ReturnType<typeof frameOf>) =>
      view.sent.flatMap((each) =>
        each.data["method"] === "ui/notifications/tool-input-partial"
          ? [(each.data["params"] as { arguments: unknown }).arguments]
          : [],
      );

    it("sends the partial input at most every 250 ms, then the final input, then the result, in the one frame", async () => {
      render(running({ text: "He" }));

      const view = frameOf();

      view.handshake();
      expect(partials(view)).toEqual([{ text: "He" }]);

      // Faster than the interval: only the latest goes, when it is up.
      render(running({ text: "Hel" }));
      render(running({ text: "Hell" }));
      expect(partials(view)).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(partials(view)).toEqual([{ text: "He" }, { text: "Hell" }]);

      // The commit: the final arguments once, and no partial after them.
      render(running({ text: "Hello" }, true));
      render(running({ text: "Hello" }, true));
      expect(view.methods().filter((method) => method === "ui/notifications/tool-input")).toEqual([
        "ui/notifications/tool-input",
      ]);

      // The record: its result, into the frame that is there, which was never torn down.
      render({ record: { ...record, arguments: { text: "Hello" } }, running: undefined });
      expect(view.methods().at(-1)).toBe("ui/notifications/tool-result");
      expect(view.methods()).not.toContain("ui/resource-teardown");
      expect(host.querySelector("iframe")).toBe(view.element);
      expect(partials(view)).toEqual([{ text: "He" }, { text: "Hell" }]);
    });

    it("sends no partial input once the arguments are past 1 MiB, and still sends the final input", () => {
      render(running({ text: "a".repeat(1024 * 1024 + 1) }));

      const view = frameOf();

      view.handshake();
      expect(partials(view)).toEqual([]);

      render(running({ text: "a".repeat(1024 * 1024 + 2) }, true));
      expect(view.methods()).toContain("ui/notifications/tool-input");
    });

    it("tells a View its call did not finish when it ends, once, and before any teardown", async () => {
      const closed = vi.fn();

      render({ ...running({ text: "He" }), onClosed: closed });

      const view = frameOf();

      view.handshake();

      render({ ...running(undefined), cancelled: "The call did not finish", onClosed: closed });
      expect(view.methods().at(-1)).toBe("ui/notifications/tool-cancelled");

      // Closing it later says it again to no one, and tears down after.
      render({
        ...running(undefined),
        cancelled: "The call did not finish",
        onClosed: closed,
        closing: true,
      });

      const methods = view.methods();

      expect(methods.filter((method) => method === "ui/notifications/tool-cancelled")).toHaveLength(
        1,
      );
      expect(methods.at(-1)).toBe("ui/resource-teardown");
    });

    it("tells a View torn down before its call has a result that the call is over, first, and a finished one nothing", () => {
      render({ ...running({ text: "He" }) });

      const view = frameOf();

      view.handshake();
      render({ ...running({ text: "He" }), closing: true });
      expect(view.methods().slice(-2)).toEqual([
        "ui/notifications/tool-cancelled",
        "ui/resource-teardown",
      ]);
    });

    it("tells a View whose record has come nothing of a cancel when it is torn down", () => {
      render({ ...running({ text: "He" }) });

      const view = frameOf();

      view.handshake();
      render({ record, running: undefined });
      render({ record, running: undefined, closing: true });
      expect(view.methods()).not.toContain("ui/notifications/tool-cancelled");
      expect(view.methods().at(-1)).toBe("ui/resource-teardown");
    });
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

    void appViews.tearDown(EVERY_VIEW).then(done);

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

    void appViews.tearDown(EVERY_VIEW).then(done);
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

    afterTeardown(action, EVERY_VIEW);
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

  it("makes a new frame for a retired View that is wanted after all (a move that did not happen), never before", async () => {
    render();

    const old = frameOf();

    old.handshake();
    old.sent.length = 0;

    const [handle] = appViews.select(() => true);

    void appViews.tearDown(host);
    old.say({ jsonrpc: "2.0", id: old.sent[0]?.data["id"], result: {} });
    await settle();

    // Torn down, and the frame is the dead one until the caller says it is wanted.
    expect(host.querySelector("iframe")).toBe(old.element);

    handle?.restart();
    await settle();

    expect(host.querySelectorAll("iframe")).toHaveLength(1);
    expect(host.querySelector("iframe")).not.toBe(old.element);
  });

  it("tells its place it has gone when the place ends a View a guard had already torn down", async () => {
    const closed = vi.fn();

    render({ onClosed: closed });

    const view = frameOf();

    view.handshake();
    view.sent.length = 0;
    void appViews.tearDown(host);
    view.say({ jsonrpc: "2.0", id: view.sent[0]?.data["id"], result: {} });
    await settle();
    expect(closed).not.toHaveBeenCalled();

    render({ onClosed: closed, closing: true });
    await settle();

    expect(closed).toHaveBeenCalledTimes(1);
    expect(view.methods()).toEqual(["ui/resource-teardown"]);
  });

  it("asks a View once when its place ends it and a guard asks at the same time", () => {
    const closed = vi.fn();

    render({ onClosed: closed });

    const view = frameOf();

    view.handshake();
    view.sent.length = 0;
    // The place ends it, and a guard asks at the same time.
    render({ onClosed: closed, closing: true });
    void appViews.tearDown(EVERY_VIEW);

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

  it("refuses a View's server calls and messages until its call has a record, and serves them once it has", async () => {
    const appRequest = vi.fn(() =>
      Effect.succeed<McpAppRequestAnswer>({ status: "result", result: { content: [] } }),
    );

    const client: AppRequestClient = { appRequest, appLog: () => undefined };
    const speech = { message: vi.fn(() => Promise.resolve("held" as const)) };

    render({
      client,
      speech,
      record: undefined,
      running: { callId: "c1", server: "docs", tool: "page", arguments: { a: "b" }, final: true },
    });

    const view = frameOf();

    view.handshake();
    await flush();

    ask(view, 7);
    ask(view, 8, "resources/read");
    view.say({
      jsonrpc: "2.0",
      id: 9,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    await flush();

    for (const id of [7, 8, 9])
      expect(answerTo(view, id)).toMatchObject({ error: { code: -32_000 } });
    expect(appRequest).not.toHaveBeenCalled();
    expect(speech.message).not.toHaveBeenCalled();

    // The record is there: the same frame's handlers serve.
    render({ client, speech, record, running: undefined });
    ask(view, 10);
    await flush();
    expect(answerTo(view, 10)).toEqual({ jsonrpc: "2.0", id: 10, result: { content: [] } });
    expect(appRequest).toHaveBeenCalledTimes(1);
  });

  it('forwards only resources/read, and badges it "Read only", when its place says it may only read', async () => {
    render({
      client: answering({ status: "result", result: { contents: [] } }),
      readOnly: true,
    });

    const view = frameOf();

    view.handshake();
    await flush();

    const initialized = view.sent.find((each) => each.data["id"] === 1)?.data;

    expect(initialized).toMatchObject({ result: { hostCapabilities: { serverResources: {} } } });
    expect(JSON.stringify(initialized)).not.toContain("serverTools");
    expect(host.textContent).toContain("Read only");

    ask(view, 7);
    ask(view, 8, "resources/read");
    await flush();

    expect(answerTo(view, 7)).toMatchObject({ error: { code: -32_601 } });
    expect(answerTo(view, 8)).toEqual({ jsonrpc: "2.0", id: 8, result: { contents: [] } });
  });

  it("is made again with every call served, and no badge, when the Session is unarchived under a View that was reopened read only", async () => {
    const client = answering({ status: "result", result: { content: [] } });

    render({ client, readOnly: true });

    const old = frameOf();

    old.handshake();
    old.sent.length = 0;

    render({ client, readOnly: false });

    // The read-only View is told to tear down first, and its frame is there to hear it; the badge goes with the frame.
    expect(old.methods()).toEqual(["ui/resource-teardown"]);
    expect(host.querySelector("iframe")).toBe(old.element);

    old.say({ jsonrpc: "2.0", id: old.sent[0]?.data["id"], result: {} });
    await flush();

    const next = frameOf();

    expect(next.element).not.toBe(old.element);
    expect(host.textContent).not.toContain("Read only");

    next.handshake();
    ask(next, 7);
    await flush();

    expect(answerTo(next, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [] } });
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

describe("what a View says to the conversation, opens and writes to the clipboard", () => {
  const flush = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

  const answerTo = (view: ReturnType<typeof frameOf>, id: number) =>
    view.sent.find((each) => each.data["id"] === id)?.data;

  const capabilitiesOf = (view: ReturnType<typeof frameOf>) => {
    const initialized = answerTo(view, 1) as { result: { hostCapabilities: unknown } };

    return initialized.result.hostCapabilities;
  };

  const withClipboard: AppPage = {
    html: "<p>view</p>",
    meta: { permissions: { clipboardWrite: {} } },
    origin: ORIGIN,
  };

  it("gives clipboard-write only to a View that declared it, to the proxy's page and to the frame", async () => {
    render({ page: withClipboard });

    const declared = frameOf();

    declared.handshake();
    await flush();

    expect(declared.element.getAttribute("allow")).toBe("clipboard-write");
    expect(declared.sent[0]).toMatchObject({
      data: {
        method: "ui/notifications/sandbox-resource-ready",
        params: { permissions: { clipboardWrite: {} } },
      },
    });
    expect(capabilitiesOf(declared)).toMatchObject({
      sandbox: { permissions: { clipboardWrite: {} } },
    });
  });

  it("gives no permission to a View that declared none, or only others", async () => {
    render({
      page: {
        html: "<p>view</p>",
        meta: { permissions: { camera: {}, geolocation: {} } },
        origin: ORIGIN,
      },
    });

    const view = frameOf();

    view.handshake();
    await flush();

    expect(view.element.hasAttribute("allow")).toBe(false);
    expect(JSON.stringify(view.sent[0]?.data)).not.toContain("permissions");
    expect(JSON.stringify(capabilitiesOf(view))).not.toContain("permissions");
  });

  it("advertises openLinks always, and message and context only when the frame has them to serve", async () => {
    render();

    const bare = frameOf();

    bare.handshake();
    await flush();
    expect(capabilitiesOf(bare)).toMatchObject({ openLinks: {} });
    expect(JSON.stringify(capabilitiesOf(bare))).not.toContain("updateModelContext");
    expect(JSON.stringify(capabilitiesOf(bare))).not.toContain('"message"');

    act(() => {
      root.unmount();
    });
    root = createRoot(host);

    render({
      speech: {
        message: () => Promise.resolve("held"),
        context: () => Promise.resolve({ held: true }),
      },
    });

    const speaking = frameOf();

    speaking.handshake();
    await flush();
    expect(capabilitiesOf(speaking)).toMatchObject({
      openLinks: {},
      message: { text: {} },
      updateModelContext: { text: {} },
    });
  });

  it("holds a View's message and answers {} once held, { isError: true } when refused", async () => {
    const message = vi.fn<(text: string) => Promise<"held" | "refused">>();

    message.mockResolvedValueOnce("held").mockResolvedValueOnce("refused");
    render({ speech: { message } });

    const view = frameOf();

    view.handshake();

    const say = (id: number) => {
      view.say({
        jsonrpc: "2.0",
        id,
        method: "ui/message",
        params: { role: "user", content: [{ type: "text", text: "Pick A" }] },
      });
    };

    say(10);
    say(11);
    await flush();

    expect(message).toHaveBeenCalledWith("Pick A");
    expect(answerTo(view, 10)).toMatchObject({ result: {} });
    expect(answerTo(view, 11)).toMatchObject({ result: { isError: true } });
  });

  it("refuses a read-only (archived) View's ui/message and ui/update-model-context, holds nothing and advertises neither", async () => {
    const message = vi.fn<(text: string) => Promise<"held" | "refused">>();
    const context = vi.fn<(text: string) => Promise<{ held: boolean }>>();

    render({ speech: { message, context }, readOnly: true });

    const view = frameOf();

    view.handshake();
    view.say({
      jsonrpc: "2.0",
      id: 12,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "x" }] },
    });
    view.say({
      jsonrpc: "2.0",
      id: 13,
      method: "ui/update-model-context",
      params: { content: [{ type: "text", text: "x" }] },
    });
    await flush();

    expect(message).not.toHaveBeenCalled();
    expect(context).not.toHaveBeenCalled();
    expect(answerTo(view, 12)).toMatchObject({ result: { isError: true } });
    expect(answerTo(view, 13)).toMatchObject({
      error: { code: -32_000, message: "This Session is archived" },
    });
    expect(JSON.stringify(capabilitiesOf(view))).not.toContain("updateModelContext");
    expect(JSON.stringify(capabilitiesOf(view))).not.toContain('"message"');
  });

  it("shows the last context the View told the model as a chip", () => {
    render({ context: { hash: "h", text: "The owner picked row 3", at: 1, delivered: false } });

    const chip = host.querySelector("[data-app-context]");

    expect(chip?.textContent).toContain("Told the model");
    expect(chip?.textContent).toContain("The owner picked row 3");
    expect(chip?.textContent).toContain("Pending");
  });

  describe("ui/open-link", () => {
    const open = (view: ReturnType<typeof frameOf>, id: number, url: unknown) => {
      view.say({ jsonrpc: "2.0", id, method: "ui/open-link", params: { url } });
    };

    const confirmation = () => host.querySelector("[aria-label='Open link?']");

    const press = (label: string) => {
      const button = Array.from(host.querySelectorAll("button")).find(
        (each) => each.textContent === label,
      );

      act(() => {
        button?.click();
      });
    };

    it("asks the owner first, with the whole URL and its host emphasised, and opens nothing before they say", async () => {
      const opened = vi.spyOn(window, "open").mockReturnValue(null);

      render();

      const view = frameOf();

      view.handshake();
      open(view, 20, "https://docs.example.com:8443/guide?q=1#top");
      await flush();

      expect(confirmation()?.textContent).toContain("https://docs.example.com:8443/guide?q=1#top");
      expect(confirmation()?.querySelector("strong")?.textContent).toBe("docs.example.com:8443");
      expect(opened).not.toHaveBeenCalled();
      expect(answerTo(view, 20)).toBeUndefined();
    });

    it("opens the link in a new tab with no opener or referrer on Open, and answers {}", async () => {
      const opened = vi.spyOn(window, "open").mockReturnValue(null);

      render();

      const view = frameOf();

      view.handshake();
      open(view, 21, "https://docs.example.com/");
      await flush();
      press("Open");
      await flush();

      expect(opened).toHaveBeenCalledWith(
        "https://docs.example.com/",
        "_blank",
        "noopener,noreferrer",
      );
      expect(answerTo(view, 21)).toMatchObject({ result: {} });
      expect(confirmation()).toBeNull();
    });

    it("hands the link to the Browser Pane on Open in Browser Pane, which is offered only when the card can", async () => {
      const opened = vi.spyOn(window, "open").mockReturnValue(null);
      const inPane = vi.fn();

      render();

      const view = frameOf();

      view.handshake();
      open(view, 22, "https://docs.example.com/");
      await flush();
      expect(host.textContent).not.toContain("Open in Browser Pane");
      press("Dismiss");
      await flush();

      render({ onOpenInPane: inPane });
      open(view, 23, "https://docs.example.com/a");
      await flush();
      press("Open in Browser Pane");
      await flush();

      expect(inPane).toHaveBeenCalledWith("https://docs.example.com/a");
      expect(opened).not.toHaveBeenCalled();
      expect(answerTo(view, 23)).toMatchObject({ result: {} });
    });

    it("answers -32000 when the owner dismisses it", async () => {
      const opened = vi.spyOn(window, "open").mockReturnValue(null);

      render();

      const view = frameOf();

      view.handshake();
      open(view, 24, "https://docs.example.com/");
      await flush();
      press("Dismiss");
      await flush();

      expect(opened).not.toHaveBeenCalled();
      expect(answerTo(view, 24)).toMatchObject({ error: { code: -32_000 } });
      expect(confirmation()).toBeNull();
    });

    it("answers a newer request in place of a pending one, the old one -32000", async () => {
      vi.spyOn(window, "open").mockReturnValue(null);
      render();

      const view = frameOf();

      view.handshake();
      open(view, 25, "https://one.example.com/");
      open(view, 26, "https://two.example.com/");
      await flush();

      expect(answerTo(view, 25)).toMatchObject({ error: { code: -32_000 } });
      expect(answerTo(view, 26)).toBeUndefined();
      expect(confirmation()?.textContent).toContain("two.example.com");
      expect(confirmation()?.textContent).not.toContain("one.example.com");
    });

    it("refuses anything but http and https with -32602, and shows no confirmation", async () => {
      render();

      const view = frameOf();

      view.handshake();

      const refused = [
        "javascript:alert(1)",
        "data:text/html,x",
        "file:///etc/passwd",
        "ftp://a.example/",
        "//x.example/",
        "not a url",
        "https://u:p@a.example/",
      ];

      for (const [at, url] of refused.entries()) open(view, 30 + at, url);

      open(view, 40, 5);
      await flush();

      for (const at of refused.keys()) {
        expect(answerTo(view, 30 + at)).toMatchObject({ error: { code: -32_602 } });
      }

      expect(answerTo(view, 40)).toMatchObject({ error: { code: -32_602 } });
      expect(confirmation()).toBeNull();
    });
  });
});
