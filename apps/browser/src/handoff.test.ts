// A Browser Handoff in the browser host (`./handoff.ts`), over a scripted CDP connection: it hands the conversation's tab
// to the owner through Browser Run's structured handoff, hears the owner finish as the `Cloudflare.handoffComplete`
// event, and finds a handoff again after the host restarts (a second `HandoffHost` over the same records).
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off preferEffectRecord:off
import type { Schema } from "effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { BrowserGoneError, type CdpEvent } from "./cdp.ts";
import {
  fakeTransport,
  linkTo,
  page,
  records,
  TOKEN,
  type Viewport,
  WINDOW_SIZE,
} from "./cdp.testing.ts";
import { HandoffHost } from "./handoff.ts";

const REQUEST = {
  requestId: "7",
  conversationId: 3,
  instructions: "Log in, then press Done",
  timeoutMs: 1_800_000,
};

const hostOver = (
  transports: ReturnType<typeof fakeTransport>[],
  store = records(),
  tab: "none" | { readonly browserSessionId: string; readonly targetId: string } = {
    browserSessionId: "browser-1",
    targetId: "tab-1",
  },
  clock = { now: 1_000 },
) => {
  const opened: string[] = [];
  const asked: number[] = [];
  const scheduled: number[] = [];

  const host = new HandoffHost({
    records: store,
    graceMs: 20,
    now: () => clock.now,
    schedule: (at) => scheduled.push(at),
    browser: {
      tabOf: (conversationId) => {
        asked.push(conversationId);

        return Promise.resolve(tab === "none" ? undefined : tab);
      },
      connect: (browserSessionId) => {
        opened.push(browserSessionId);

        const next = transports.shift();

        return next === undefined
          ? Promise.reject(new Error("no more connections"))
          : Promise.resolve(next.transport);
      },
    },
  });

  return { host, store, opened, asked, scheduled, clock };
};

const COMPLETE = (params: Schema.Json): CdpEvent => ({
  method: "Cloudflare.handoffComplete",
  params,
  sessionId: "cdp-1",
});

describe("a Browser Handoff in the browser host", () => {
  it("attaches to the conversation's tab, notes its viewport, and starts Browser Run's handoff without minting a link", async () => {
    const cdp = fakeTransport();
    const { host, asked, opened, store } = hostOver([cdp]);

    expect(await host.start(REQUEST)).toEqual({ startedAt: 1_000 });
    expect(asked).toEqual([3]);
    expect(opened).toEqual(["browser-1"]);

    expect(cdp.sent).toEqual([
      { method: "Target.attachToTarget", params: { targetId: "tab-1", flatten: true } },
      {
        method: "Runtime.evaluate",
        params: { expression: expect.stringContaining("innerWidth"), returnByValue: true },
        sessionId: "cdp-1",
      },
      {
        method: "Cloudflare.handoff",
        params: { instructions: "Log in, then press Done", timeout: 1_800_000 },
        sessionId: "cdp-1",
      },
    ]);
    expect(cdp.methods()).not.toContain("Cloudflare.getLiveView");
    expect(JSON.stringify([...store.list({ prefix: "" })])).not.toContain(TOKEN);
  });

  it("answers a second start under the same request with the same handoff", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    expect(await host.start(REQUEST)).toEqual({ startedAt: 1_000 });
    expect(cdp.methods().filter((method) => method === "Cloudflare.handoff")).toHaveLength(1);

    // Once the owner has finished, a start that comes again says the handoff is over.
    cdp.emit(COMPLETE({ success: true }));

    expect(await host.start(REQUEST)).toEqual({ startedAt: 1_000, over: true });
  });

  it("fails when the conversation has no tab, or the tab cannot be attached", async () => {
    const none = hostOver([], records(), "none");

    await expect(none.host.start(REQUEST)).rejects.toThrow(/no open tab/);

    const gone = fakeTransport({});
    const broken = hostOver([gone]);

    gone.transport.send = () => Promise.reject(new Error("No target with given id"));
    await expect(broken.host.start(REQUEST)).rejects.toThrow(/tab is not available/);
    expect(gone.state.closed).toBe(true);
    expect(await broken.host.wait("7", 10)).toEqual({ state: "unknown" });
  });

  it("forgets a handoff Browser Run would not start", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);
    const send = cdp.transport.send.bind(cdp.transport);

    cdp.transport.send = (method, params, sessionId) =>
      method === "Cloudflare.handoff"
        ? Promise.reject(new Error("a handoff is already active"))
        : send(method, params, sessionId);

    await expect(host.start(REQUEST)).rejects.toThrow(/already active/);
    expect(cdp.state.closed).toBe(true);
    expect(await host.wait("7", 10)).toEqual({ state: "unknown" });
  });

  it("keeps waiting while the owner is busy, and checks with Browser Run each quiet round", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    expect(await host.wait("7", 20)).toEqual({ state: "waiting" });
    expect(cdp.methods().filter((method) => method === "Cloudflare.getHandoffState")).toHaveLength(
      2,
    );
  });

  it("resumes the wait the moment the owner finishes", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    const waiting = host.wait("7", 60_000);

    await new Promise((resolve) => setTimeout(resolve, 5));
    cdp.emit(COMPLETE({ handoffId: "handoff-1", success: true }));

    expect(await waiting).toEqual({ state: "complete", success: true });
    // And later rounds say the same.
    expect(await host.wait("7", 10)).toEqual({ state: "complete", success: true });
  });

  it("reports the reason the owner gave when they could not do it", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);
    cdp.emit(COMPLETE({ success: false, reason: "No code arrived" }));

    expect(await host.wait("7", 10)).toEqual({
      state: "complete",
      success: false,
      reason: "No code arrived",
    });
  });

  it("ignores the end of another handoff on the same tab", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);
    cdp.emit(COMPLETE({ handoffId: "earlier", success: true }));

    expect(await host.wait("7", 10)).toEqual({ state: "waiting" });
  });

  it("says the handoff ended without a word when Browser Run no longer has it and no event came", async () => {
    const cdp = fakeTransport({ "Cloudflare.getHandoffState": { active: false } });
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    expect(await host.wait("7", 10)).toEqual({ state: "ended" });
  });

  it("finds the handoff again after the host restarts, on a connection of its own, and hears it end there", async () => {
    const store = records();
    const first = fakeTransport();

    await hostOver([first], store).host.start(REQUEST);

    // A new instance over the same records: it has no connection and no listener.
    const second = fakeTransport();
    const { host, opened } = hostOver([second], store);

    const waiting = host.wait("7", 60_000);

    await new Promise((resolve) => setTimeout(resolve, 5));
    second.emit(COMPLETE({ handoffId: "handoff-1", success: true }));

    expect(await waiting).toEqual({ state: "complete", success: true });
    expect(opened).toEqual(["browser-1"]);
    expect(second.methods()).toEqual([
      "Target.attachToTarget",
      "Cloudflare.getHandoffState",
      // The agent's viewport, given back, and the tab's windows looked for.
      "Emulation.setDeviceMetricsOverride",
      "Runtime.evaluate",
      "Target.getTargets",
    ]);
  });

  it("says a handoff that ended while the host was away ended, and one whose browser is gone too", async () => {
    const store = records();

    await hostOver([fakeTransport()], store).host.start(REQUEST);

    const over = hostOver(
      [fakeTransport({ "Cloudflare.getHandoffState": { active: false } })],
      store,
    );

    expect(await over.host.wait("7", 10)).toEqual({ state: "ended" });

    const store2 = records();

    await hostOver([fakeTransport()], store2).host.start(REQUEST);

    // Browser Run says the browser is gone.
    const gone = new HandoffHost({
      records: store2,
      now: () => 1_000,
      browser: {
        tabOf: () => Promise.resolve(undefined),
        connect: () => Promise.reject(new BrowserGoneError("gone")),
      },
    });

    expect(await gone.wait("7", 10)).toEqual({ state: "ended" });
  });

  it("asks the Session again when the connection cannot be reopened for another reason", async () => {
    const store = records();

    await hostOver([fakeTransport()], store).host.start(REQUEST);

    // The host has no connection to give: a network failure, not Browser Run saying the browser is gone.
    await expect(hostOver([], store).host.wait("7", 10)).rejects.toThrow(/no more connections/);

    // The handoff is still there for the next round.
    const next = fakeTransport();

    expect(await hostOver([next], store).host.wait("7", 10)).toEqual({ state: "waiting" });
  });

  it("counts an event that comes before Browser Run answers the handoff command as the handoff's end", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);
    const send = cdp.transport.send.bind(cdp.transport);

    cdp.transport.send = async (method, params, sessionId) => {
      const answer = await send(method, params, sessionId);

      if (method === "Cloudflare.handoff") {
        cdp.emit(COMPLETE({ handoffId: "handoff-1", success: true }));
      }

      return answer;
    };

    await host.start(REQUEST);

    expect(await host.wait("7", 10)).toEqual({ state: "complete", success: true });
  });

  it("ends a handoff the owner has not finished in Browser Run, then forgets it", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);
    await host.end("7");

    expect(cdp.sent).toContainEqual({
      method: "Cloudflare.handoffComplete",
      params: { success: false, reason: "The agent stopped waiting" },
      sessionId: "cdp-1",
    });
    expect(cdp.state.closed).toBe(true);
    expect(await host.wait("7", 10)).toEqual({ state: "unknown" });
  });

  it("does not end again what the owner already finished, and forgets a handoff that is not there", async () => {
    const cdp = fakeTransport();
    const { host } = hostOver([cdp]);

    await host.start(REQUEST);
    cdp.emit(COMPLETE({ success: true }));
    await host.end("7");
    await host.end("nope");

    expect(cdp.methods()).not.toContain("Cloudflare.handoffComplete");
    expect(cdp.state.closed).toBe(true);
  });

  it("ends a handoff over a new connection when the host restarted since it started", async () => {
    const store = records();

    await hostOver([fakeTransport()], store).host.start(REQUEST);

    const restarted = fakeTransport();
    const { host, opened } = hostOver([restarted], store);

    await host.end("7");

    expect(opened).toEqual(["browser-1"]);
    expect(restarted.sent).toContainEqual({
      method: "Cloudflare.handoffComplete",
      params: { success: false, reason: "The agent stopped waiting" },
      sessionId: "cdp-1",
    });
    expect(restarted.state.closed).toBe(true);
    expect(await host.wait("7", 10)).toEqual({ state: "unknown" });
  });

  it("joins a second start of the same request while the first is in flight, and opens one handoff", async () => {
    const cdp = fakeTransport();
    const { host, asked } = hostOver([cdp]);

    const [first, second] = await Promise.all([host.start(REQUEST), host.start(REQUEST)]);

    expect(second).toEqual(first);
    expect(asked).toEqual([3]);
    expect(cdp.methods().filter((method) => method === "Cloudflare.handoff")).toHaveLength(1);
  });

  it("lets a start in flight finish before it ends the handoff, and refuses a start that comes after", async () => {
    const cdp = fakeTransport();
    const { host, store } = hostOver([cdp]);

    const starting = host.start(REQUEST);
    const ending = host.end("7");

    await starting;
    await ending;

    expect(cdp.methods()).toContain("Cloudflare.handoffComplete");
    expect(cdp.state.closed).toBe(true);
    expect(await host.wait("7", 10)).toEqual({ state: "unknown" });
    await expect(host.start(REQUEST)).rejects.toThrow(/already ended/);
    expect([...store.list({ prefix: "handoff:" })]).toEqual([]);
  });

  it("prunes a handoff past its deadline that nobody ended, and a tombstone past its time", async () => {
    const cdp = fakeTransport();
    const { host, store, clock, scheduled } = hostOver([cdp]);

    await host.start(REQUEST);
    // Woken once the record is of no use: its deadline and five minutes more.
    expect(scheduled).toEqual([1_000 + 1_800_000 + 300_000]);

    expect(host.prune()).toBe(1_000 + 1_800_000 + 300_000);
    expect([...store.list({ prefix: "handoff:" })]).toHaveLength(1);

    clock.now = 1_000 + 1_800_000 + 300_000;

    expect(host.prune()).toBeUndefined();
    expect([...store.list({ prefix: "handoff:" })]).toEqual([]);
    expect(cdp.state.closed).toBe(true);

    await host.end("8");
    expect([...store.list({ prefix: "handoff-ended:" })]).toHaveLength(1);

    clock.now += 3_600_000;
    expect(host.prune()).toBeUndefined();
    expect([...store.list({ prefix: "handoff-ended:" })]).toEqual([]);
  });
});

/** Where a page is, as the agent's code would see it after a handoff. */
const settledViewport = (cdp: ReturnType<typeof fakeTransport>) => cdp.state.viewport;

/** The owner's phone, connected to the tab, sets its own size. */
const PHONE: Viewport = { width: 390, height: 844, deviceScaleFactor: 3 };

describe("Live View links", () => {
  it("mints a 60-second link for the tab and for each window it opened, directly or through another, by target", async () => {
    const cdp = fakeTransport({
      "Target.getTargets": {
        targetInfos: [
          page("other-tab"),
          page("tab-1", { attached: true }),
          page("popup-1", { openerId: "tab-1", canAccessOpener: true, title: "Sign in" }),
          page("popup-2", { openerId: "popup-1", title: "Approve" }),
          page("stranger", { openerId: "other-tab" }),
          { ...page("worker"), type: "service_worker", openerId: "tab-1" },
        ],
      },
    });

    const { host, store } = hostOver([cdp]);

    await host.start(REQUEST);

    const from = cdp.sent.length;

    expect(await host.liveView("7")).toEqual({
      tab: { targetId: "tab-1", link: linkTo("tab-1") },
      windows: [
        { targetId: "popup-1", openerId: "tab-1", title: "Sign in", link: linkTo("popup-1") },
        { targetId: "popup-2", openerId: "popup-1", title: "Approve", link: linkTo("popup-2") },
      ],
    });

    const minted = cdp.sent.slice(from).filter((sent) => sent.method === "Cloudflare.getLiveView");

    // Each with its own target: without one, Browser Run picks the newest page, not the handed-over tab.
    expect(minted.map((sent) => sent.params)).toEqual([
      { mode: "tab", expiresInMs: 60_000, targetId: "tab-1" },
      { mode: "tab", expiresInMs: 60_000, targetId: "popup-1" },
      { mode: "tab", expiresInMs: 60_000, targetId: "popup-2" },
    ]);
    // The windows are read on the browser, not in the tab's session.
    expect(cdp.sent.find((sent) => sent.method === "Target.getTargets")).toEqual({
      method: "Target.getTargets",
      params: {},
    });
    // A link is the client's: it is not kept.
    expect(JSON.stringify([...store.list({ prefix: "" })])).not.toContain(TOKEN);
  });

  it("leaves out a window that closes between the listing and its link", async () => {
    const cdp = fakeTransport({
      "Target.getTargets": {
        targetInfos: [
          page("tab-1", { attached: true }),
          page("popup-1", { openerId: "tab-1", title: "Sign in" }),
          page("popup-2", { openerId: "tab-1", title: "Help" }),
        ],
      },
      "Cloudflare.getLiveView": (params) => {
        const asked = params?.["targetId"];
        const targetId = Predicate.isString(asked) ? asked : "";

        if (targetId === "popup-1") throw new Error("No target with given id found");

        return { webSocketDebuggerUrl: linkTo(targetId) };
      },
    });

    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    expect(await host.liveView("7")).toEqual({
      tab: { targetId: "tab-1", link: linkTo("tab-1") },
      windows: [{ targetId: "popup-2", openerId: "tab-1", title: "Help", link: linkTo("popup-2") }],
    });
  });

  it("mints anew each time it is asked, on a new connection after the host restarted", async () => {
    const store = records();

    await hostOver([fakeTransport()], store).host.start(REQUEST);

    const restarted = fakeTransport();
    const { host, opened } = hostOver([restarted], store);

    expect((await host.liveView("7")).tab).toEqual({ targetId: "tab-1", link: linkTo("tab-1") });
    expect((await host.liveView("7")).windows).toEqual([]);
    expect(opened).toEqual(["browser-1"]);
    expect(
      restarted.methods().filter((method) => method === "Cloudflare.getLiveView"),
    ).toHaveLength(2);
  });

  it("refuses a handoff that is over, however it ended, and one it never had", async () => {
    const done = fakeTransport();
    const finished = hostOver([done]).host;

    await finished.start(REQUEST);
    done.emit(COMPLETE({ success: true }));
    await expect(finished.liveView("7")).rejects.toThrow("the handoff is over");

    const stopped = hostOver([fakeTransport()]).host;

    await stopped.start(REQUEST);
    await stopped.end("7");
    await expect(stopped.liveView("7")).rejects.toThrow("the handoff is over");

    const lost = fakeTransport({ "Cloudflare.getHandoffState": { active: false } });
    const timedOut = hostOver([lost]).host;

    await timedOut.start(REQUEST);
    expect(await timedOut.wait("7", 10)).toEqual({ state: "ended" });
    await expect(timedOut.liveView("7")).rejects.toThrow("the handoff is over");

    await expect(hostOver([]).host.liveView("nope")).rejects.toThrow("the handoff is over");
    expect(lost.methods()).not.toContain("Cloudflare.getLiveView");
  });
});

describe("the agent's viewport after a handoff", () => {
  /** A started handoff whose tab the owner's phone resized. */
  const resizedByPhone = async (
    agent: Viewport = { width: 780, height: 493, deviceScaleFactor: 1 },
  ) => {
    const cdp = fakeTransport();

    cdp.state.viewport = { ...agent };

    const over = hostOver([cdp]);

    await over.host.start(REQUEST);
    cdp.state.viewport = { ...PHONE };

    return { ...over, cdp };
  };

  const RESTORE = {
    method: "Emulation.setDeviceMetricsOverride",
    params: { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false },
    sessionId: "cdp-1",
  };

  it("is set back to the size the tab had at the start when the owner presses Done", async () => {
    const { host, cdp } = await resizedByPhone({ width: 1000, height: 700, deviceScaleFactor: 1 });

    cdp.emit(COMPLETE({ handoffId: "handoff-1", success: true }));

    expect(await host.wait("7", 10)).toEqual({ state: "complete", success: true });
    expect(cdp.sent).toContainEqual(RESTORE);
    expect(settledViewport(cdp)).toEqual({ width: 1000, height: 700, deviceScaleFactor: 1 });
  });

  it("is set back when the owner reports failure", async () => {
    const { host, cdp } = await resizedByPhone();

    cdp.emit(COMPLETE({ success: false, reason: "No code came" }));
    await host.wait("7", 10);

    expect(settledViewport(cdp)).toEqual({ width: 780, height: 493, deviceScaleFactor: 1 });
  });

  it("is set back when Browser Run times the handoff out", async () => {
    const { host, cdp } = await resizedByPhone();

    cdp.emit(COMPLETE({ success: false, reason: "Handoff timed out" }));
    await host.wait("7", 10);

    expect(settledViewport(cdp)).toEqual({ width: 780, height: 493, deviceScaleFactor: 1 });

    const lost = await resizedByPhone();

    lost.cdp.transport.send = (
      (send) => (method, params, sessionId) =>
        method === "Cloudflare.getHandoffState"
          ? Promise.resolve({ active: false })
          : send(method, params, sessionId)
    )(lost.cdp.transport.send.bind(lost.cdp.transport));

    expect(await lost.host.wait("7", 10)).toEqual({ state: "ended" });
    expect(settledViewport(lost.cdp)).toEqual({ width: 780, height: 493, deviceScaleFactor: 1 });
  });

  it("is set back when the agent stops waiting, before the connection closes", async () => {
    const { host, cdp } = await resizedByPhone();

    await host.end("7");

    expect(settledViewport(cdp)).toEqual({ width: 780, height: 493, deviceScaleFactor: 1 });
    expect(cdp.state.closed).toBe(true);
  });

  it("is set again when the tab's width does not show the first try, and set once per handoff", async () => {
    const { host, cdp } = await resizedByPhone();

    cdp.state.ignoreOverrides = 1;
    cdp.emit(COMPLETE({ success: true }));
    await host.wait("7", 10);
    await host.end("7");

    expect(settledViewport(cdp)).toEqual({ width: 780, height: 493, deviceScaleFactor: 1 });
    expect(
      cdp.methods().filter((method) => method === "Emulation.setDeviceMetricsOverride"),
    ).toHaveLength(2);
  });
});

describe("the windows' viewports after a handoff", () => {
  const POPUPS = {
    "Target.getTargets": {
      targetInfos: [
        page("tab-1", { attached: true }),
        page("popup-1", { openerId: "tab-1" }),
        page("popup-2", { openerId: "popup-1" }),
        page("other-tab"),
      ],
    },
  };

  /** A handoff whose windows the owner's Live View was given links to, then resized to the phone. */
  const resizedWindows = async () => {
    const cdp = fakeTransport(POPUPS);
    const over = hostOver([cdp]);

    await over.host.start(REQUEST);
    await over.host.liveView("7");
    cdp.state.windows.set("cdp-popup-1", { ...PHONE });
    cdp.state.windows.set("cdp-popup-2", { ...PHONE });

    return { ...over, cdp };
  };

  it("are cleared at the end of the handoff, in each window's own session, and the tab's given back too", async () => {
    const { host, cdp } = await resizedWindows();

    cdp.emit(COMPLETE({ success: true }));
    await host.wait("7", 10);

    expect(cdp.state.windows.get("cdp-popup-1") ?? WINDOW_SIZE).toEqual(WINDOW_SIZE);
    expect(cdp.state.windows.get("cdp-popup-2") ?? WINDOW_SIZE).toEqual(WINDOW_SIZE);
    expect(cdp.sent).toContainEqual({
      method: "Emulation.clearDeviceMetricsOverride",
      params: {},
      sessionId: "cdp-popup-2",
    });
    expect(cdp.state.viewport).toEqual({ width: 780, height: 493, deviceScaleFactor: 1 });
    // A page with no opener is not the handoff's: left alone.
    expect(cdp.sent.some((sent) => sent.sessionId === "cdp-other-tab")).toBe(false);
  });

  it("are set to the size each window had when first listed, when a clear does not take", async () => {
    const { host, cdp } = await resizedWindows();

    cdp.state.ignoreClears = 2;
    await host.end("7");

    expect(cdp.state.windows.get("cdp-popup-1")).toEqual(WINDOW_SIZE);
    expect(cdp.state.windows.get("cdp-popup-2")).toEqual(WINDOW_SIZE);
    expect(cdp.sent).toContainEqual({
      method: "Emulation.setDeviceMetricsOverride",
      params: { ...WINDOW_SIZE, mobile: false },
      sessionId: "cdp-popup-1",
    });
  });

  it("are given back on a new connection after the host restarted, from the sizes it kept", async () => {
    const store = records();
    const first = fakeTransport(POPUPS);
    const before = hostOver([first], store);

    await before.host.start(REQUEST);
    await before.host.liveView("7");

    const restarted = fakeTransport(POPUPS);

    restarted.state.windows.set("cdp-popup-1", { ...PHONE });
    restarted.state.ignoreClears = 2;

    await hostOver([restarted], store).host.end("7");

    expect(restarted.state.windows.get("cdp-popup-1")).toEqual(WINDOW_SIZE);
  });
});

describe("the windows a handoff leaves open", () => {
  it("are told by origin only, never by URL", async () => {
    const cdp = fakeTransport({
      "Target.getTargets": {
        targetInfos: [
          page("tab-1", { attached: true }),
          page("popup-1", {
            openerId: "tab-1",
            url: "https://accounts.example.com/oauth/callback?code=SECRET-CODE",
          }),
          page("popup-2", { openerId: "popup-1", url: "https://id.example.org:8443/approve" }),
          page("blank", { openerId: "tab-1", url: "about:blank" }),
          page("other-tab", { url: "https://elsewhere.example.net/" }),
        ],
      },
    });

    const { host } = hostOver([cdp]);

    await host.start(REQUEST);
    cdp.emit(COMPLETE({ success: true }));
    await host.wait("7", 10);

    const ended = await host.end("7");

    expect(ended).toEqual({
      // Breadth first: a window after the one that opened it.
      windowOrigins: ["https://accounts.example.com", "about:blank", "https://id.example.org:8443"],
    });
    expect(JSON.stringify(ended)).not.toContain("SECRET-CODE");
  });

  it("are none when the tab opened none, and unknown for a handoff that is not there", async () => {
    const { host } = hostOver([fakeTransport()]);

    await host.start(REQUEST);

    expect(await host.end("7")).toEqual({ windowOrigins: [] });
    expect(await host.end("nope")).toEqual({});
  });

  it("are unknown, not none, when they could not be read before the cleanup gave up", async () => {
    const cdp = fakeTransport({
      "Target.getTargets": () => {
        throw new Error("Browser Run is not answering");
      },
    });

    const { host } = hostOver([cdp]);

    await host.start(REQUEST);

    expect(await host.end("7")).toEqual({});
    expect(cdp.state.closed).toBe(true);
  });
});
