// @effect-diagnostics preferEffectArray:off preferSchemaOverJson:off strictEffectProvide:off -- a fake browser over native arrays, speaking CDP's plain JSON, given to each test's Live View.

import type { LiveViewLinks } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { settle, type Value } from "../session/client.testing.ts";
import { keyPress } from "./cdp.ts";
import { HANDOFF_OVER, make, RETURN_PING_MS, type Frame } from "./connection.ts";
import { deviceMetrics } from "./viewport.ts";

type Listener = (event: Socket.WebSocketEvent) => void;

interface Sent {
  readonly id: number;
  readonly method: string;
  readonly params: { readonly [key: string]: Value };
}

/** How the fake browser answers a command: a result, or nothing (a socket iOS killed). */
type Answer = { readonly [key: string]: Value } | "silent";

/** A page's CDP socket in a fake Browser Run: it opens at once and answers every command, as `answer` says. */
class FakePage implements Socket.WebSocketLike {
  readyState = 0;
  readonly sent: Sent[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    readonly url: string,
    private readonly answer: (method: string) => Answer,
  ) {}

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set();

    set.add(listener);
    this.listeners.set(type, set);

    if (type === "open") {
      queueMicrotask(() => {
        if (this.readyState !== 0) return;

        this.readyState = 1;
        this.dispatch("open", { type: "open" });
      });
    }
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>) {
    const command: Sent = JSON.parse(String(data));

    this.sent.push(command);

    const result = this.answer(command.method);

    if (result === "silent") return;

    queueMicrotask(() => {
      this.dispatch("message", {
        type: "message",
        data: JSON.stringify({ id: command.id, result }),
      });
    });
  }

  close() {
    if (this.readyState === 3) return;

    this.readyState = 3;
    this.dispatch("close", { type: "close", code: 1000 });
  }

  /** The page sends an event. */
  event(method: string, params: { readonly [key: string]: Value }) {
    return Effect.sync(() => {
      this.dispatch("message", { type: "message", data: JSON.stringify({ method, params }) });
    }).pipe(Effect.andThen(settle));
  }

  /** The browser closes the socket (the window closed). */
  drop() {
    return Effect.sync(() => {
      this.close();
    }).pipe(Effect.andThen(settle));
  }

  methods(): string[] {
    return this.sent.map((command) => command.method);
  }

  last(method: string): Sent | undefined {
    return this.sent.findLast((command) => command.method === method);
  }

  private dispatch(type: string, event: Socket.WebSocketEvent) {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) listener(event);
  }
}

const HANDOFF = {
  targetId: "T",
  active: true,
  handoffId: "h1",
  instructions: "Sign in, then press Done",
  timeout: 300_000,
  durationMs: 60_000,
};

const link = (targetId: string, n: number) => `wss://live.example/page/${targetId}?jwt=${n}`;

/** A fake Browser Run and Session: what `live_view` answers, and every page socket opened. */
const setup = (options: { readonly windows?: () => LiveViewLinks["windows"] } = {}) =>
  Effect.gen(function* () {
    const pages: FakePage[] = [];
    const silent = new Set<string>();
    let mints = 0;
    let over = false;

    const answer = (url: string) => (method: string) => {
      if (silent.has(url) || (method === "Cloudflare.getSessionId" && silent.has("*"))) {
        return "silent" as const;
      }

      if (method === "Runtime.evaluate") return { result: { type: "number", value: 2 } };

      return method === "Cloudflare.getHandoffState" ? HANDOFF : {};
    };

    const layer = Layer.succeed(Socket.WebSocketConstructor)((url: string) => {
      const page = new FakePage(url, answer(url));

      pages.push(page);

      return page;
    });

    const mint = Effect.suspend(() => {
      mints += 1;

      if (over) return Effect.fail({ message: HANDOFF_OVER });

      const windows = (options.windows?.() ?? []).map((window) => ({
        ...window,
        link: link(window.targetId, mints),
      }));

      return Effect.succeed({ tab: { targetId: "T", link: link("T", mints) }, windows });
    });

    const view = yield* make(mint).pipe(Effect.provide(layer));

    yield* settle;

    return {
      view,
      pages,
      mints: () => mints,
      state: () => SubscriptionRef.getUnsafe(view.state),
      /** The page sockets opened to `targetId`, oldest first. */
      to: (targetId: string) => pages.filter((page) => page.url.includes(`/page/${targetId}?`)),
      handoffOver: () => {
        over = true;
      },
      /** Every socket open now stops answering, as iOS leaves one after the background. */
      killAll: () => {
        for (const page of pages) silent.add(page.url);
      },
    };
  });

const frame = (sessionId: number) => ({
  data: "jpeg",
  sessionId,
  metadata: {
    deviceWidth: 390,
    deviceHeight: 700,
    offsetTop: 0,
    pageScaleFactor: 1,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
  },
});

describe("a Live View's connection", () => {
  it.effect(
    "connects to the tab with a fresh link, reads the deadline, and starts the screencast",
    () =>
      Effect.gen(function* () {
        const { pages, state, mints } = yield* setup();

        expect(mints()).toBe(1);
        expect(pages.map((page) => page.url)).toEqual([link("T", 1)]);

        const tab = pages[0];

        expect(tab?.methods()).toEqual([
          "Page.enable",
          "Runtime.enable",
          "Cloudflare.getHandoffState",
          "Page.enable",
          "Runtime.enable",
          "Page.startScreencast",
          "Page.bringToFront",
        ]);
        expect(tab?.last("Page.startScreencast")?.params).toMatchObject({ format: "jpeg" });
        expect(state()).toMatchObject({
          status: "live",
          instructions: "Sign in, then press Done",
          // The time left is timeout - durationMs, from now (the test clock's 0).
          deadline: 240_000,
          strip: { tab: "T", windows: [], shown: "T" },
        });
      }).pipe(Effect.scoped),
  );

  it.effect("passes the shown page's frames on, and acknowledges each", () =>
    Effect.gen(function* () {
      const { view, to } = yield* setup();
      const frames: Frame[] = [];

      view.frames((each) => frames.push(each));
      yield* to("T")[0]!.event("Page.screencastFrame", frame(7));

      expect(frames).toEqual([{ targetId: "T", data: "jpeg", metadata: frame(7).metadata }]);
      expect(to("T")[0]?.last("Page.screencastFrameAck")?.params).toEqual({ sessionId: 7 });
    }).pipe(Effect.scoped),
  );

  it.effect("sends the owner's input to the page shown", () =>
    Effect.gen(function* () {
      const { view, to } = yield* setup();

      view.input(keyPress("Tab"));

      expect(to("T")[0]?.methods().slice(-2)).toEqual([
        "Input.dispatchKeyEvent",
        "Input.dispatchKeyEvent",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("sizes the page to the Pane, with touch emulation on a touch screen", () =>
    Effect.gen(function* () {
      const { view, to } = yield* setup();

      yield* view.resize(deviceMetrics({ width: 390, height: 700, dpr: 3, touch: true }, false), {
        maxWidth: 780,
        maxHeight: 1400,
      });
      yield* settle;

      const tab = to("T")[0];

      expect(tab?.last("Emulation.setDeviceMetricsOverride")?.params).toEqual({
        width: 390,
        height: 700,
        deviceScaleFactor: 3,
        mobile: true,
      });
      expect(tab?.last("Emulation.setTouchEmulationEnabled")?.params).toEqual({
        enabled: true,
        maxTouchPoints: 5,
      });
      expect(tab?.last("Page.startScreencast")?.params).toMatchObject({
        maxWidth: 780,
        maxHeight: 1400,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("ends when the handoff completes, from this device or another", () =>
    Effect.gen(function* () {
      const { to, state } = yield* setup();

      yield* to("T")[0]!.event("Cloudflare.handoffComplete", { success: true });

      expect(state().status).toBe("ended");
    }).pipe(Effect.scoped),
  );

  it.effect("ends when the Session says the handoff is over", () =>
    Effect.gen(function* () {
      const { view, handoffOver, killAll, state } = yield* setup();

      handoffOver();
      killAll();

      const returned = yield* Effect.forkChild(view.returned);

      yield* TestClock.adjust(RETURN_PING_MS);
      yield* Fiber.join(returned);

      expect(state().status).toBe("ended");
    }).pipe(Effect.scoped),
  );

  it.effect("asks the Session whether the handoff still waits, and ends when it does not", () =>
    Effect.gen(function* () {
      const { view, handoffOver, state, mints } = yield* setup();

      yield* view.verify;

      expect(mints()).toBe(2);
      expect(state().status).toBe("live");

      handoffOver();
      yield* view.verify;

      expect(state().status).toBe("ended");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps its connection on return when it answers the ping", () =>
    Effect.gen(function* () {
      const { view, pages, mints } = yield* setup();

      yield* view.returned;

      expect(mints()).toBe(1);
      expect(pages).toHaveLength(1);
      expect(pages[0]?.last("Cloudflare.getSessionId")).toBeDefined();
    }).pipe(Effect.scoped),
  );

  it.effect(
    "reconnects with a fresh link on return when the socket does not answer, and sizes the page again",
    () =>
      Effect.gen(function* () {
        const { view, to, mints, state, killAll } = yield* setup();

        yield* view.resize(deviceMetrics({ width: 390, height: 700, dpr: 3, touch: true }, false), {
          maxWidth: 780,
          maxHeight: 1400,
        });
        killAll();

        // `visibilitychange` and `pageshow` both come back: one check, one reconnect.
        const returned = yield* Effect.forkChild(view.returned);
        const again = yield* Effect.forkChild(view.returned);

        yield* TestClock.adjust(RETURN_PING_MS);
        yield* Fiber.join(returned);
        yield* Fiber.join(again);

        expect(mints()).toBe(2);
        expect(to("T").map((page) => page.url)).toEqual([link("T", 1), link("T", 2)]);
        expect(to("T")[0]?.readyState).toBe(3);
        expect(to("T")[1]?.last("Emulation.setDeviceMetricsOverride")?.params).toMatchObject({
          width: 390,
        });
        expect(to("T")[1]?.methods()).toContain("Page.startScreencast");
        expect(state().status).toBe("live");
      }).pipe(Effect.scoped),
  );

  it.effect("shows a window when the tab opens one, and goes back to the tab when it closes", () =>
    Effect.gen(function* () {
      let windows: LiveViewLinks["windows"] = [];
      const { view, to, state } = yield* setup({ windows: () => windows });
      const frames: Frame[] = [];

      view.frames((each) => frames.push(each));

      windows = [{ targetId: "W", openerId: "T", title: "Sign in with Example", link: "" }];
      yield* to("T")[0]!.event("Page.windowOpen", { url: "https://id.example/" });

      const popup = to("W")[0];

      expect(state().strip).toMatchObject({ shown: "W", windows: [{ targetId: "W" }] });
      expect(to("T")[0]?.methods()).toContain("Page.stopScreencast");
      expect(popup?.methods()).toEqual(
        expect.arrayContaining(["Page.startScreencast", "Page.bringToFront"]),
      );

      // Only the shown page's frames reach the Pane.
      yield* to("T")[0]!.event("Page.screencastFrame", frame(1));
      yield* popup!.event("Page.screencastFrame", frame(2));

      expect(frames.map((each) => each.targetId)).toEqual(["W"]);

      // The pop-up closes itself.
      windows = [];
      yield* popup!.drop();

      expect(state().strip).toMatchObject({ shown: "T", windows: [] });
      expect(to("T")[0]?.last("Page.bringToFront")).toBeDefined();
      expect(
        to("T")[0]
          ?.methods()
          .filter((method) => method === "Page.startScreencast"),
      ).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("waits for a window that opened to be listed", () =>
    Effect.gen(function* () {
      let windows: LiveViewLinks["windows"] = [];
      const { to, state, mints } = yield* setup({ windows: () => windows });

      const opening = yield* Effect.forkChild(
        to("T")[0]!.event("Page.windowOpen", { url: "https://id.example/" }),
      );

      yield* settle;

      expect(mints()).toBe(2);

      windows = [{ targetId: "W", openerId: "T", title: "", link: "" }];
      yield* TestClock.adjust(500);
      yield* Fiber.join(opening);
      yield* settle;

      expect(mints()).toBe(3);
      expect(state().strip?.shown).toBe("W");
    }).pipe(Effect.scoped),
  );

  it.effect("switches between the tab and its windows when the owner picks one", () =>
    Effect.gen(function* () {
      const windows = [{ targetId: "W", openerId: "T", title: "Pop-up", link: "" }];
      const { view, to, state } = yield* setup({ windows: () => windows });

      expect(state().strip?.shown).toBe("T");

      yield* view.show("W");

      expect(state().strip?.shown).toBe("W");
      expect(to("W")).toHaveLength(1);

      yield* view.show("T");

      expect(state().strip?.shown).toBe("T");
      // The window's connection closes when it is not shown; the tab's stays, and the window stays in the strip.
      expect(to("W")[0]?.readyState).toBe(3);
      expect(to("T")[0]?.readyState).toBe(1);
      expect(state().strip?.windows).toEqual([{ targetId: "W", openerId: "T", title: "Pop-up" }]);

      yield* view.show("W");

      expect(state().strip?.shown).toBe("W");
      expect(to("W")[1]?.readyState).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "clears the viewport, then sends Done or Failed on the tab's connection, and ends",
    () =>
      Effect.gen(function* () {
        const { view, to, state } = yield* setup();

        yield* view.finish(false, "No account");

        const methods = to("T")[0]?.methods() ?? [];

        expect(methods.slice(-3)).toEqual([
          "Emulation.clearDeviceMetricsOverride",
          "Emulation.setTouchEmulationEnabled",
          "Cloudflare.handoffComplete",
        ]);
        expect(to("T")[0]?.last("Cloudflare.handoffComplete")?.params).toEqual({
          success: false,
          reason: "No account",
        });
        expect(state().status).toBe("ended");
      }).pipe(Effect.scoped),
  );

  it.effect("clears the viewport and closes when the Pane closes, without ending the handoff", () =>
    Effect.gen(function* () {
      const pages = yield* Effect.scoped(
        Effect.gen(function* () {
          const { pages } = yield* setup();

          return pages;
        }),
      );

      expect(pages[0]?.methods().slice(-2)).toEqual([
        "Emulation.clearDeviceMetricsOverride",
        "Emulation.setTouchEmulationEnabled",
      ]);
      expect(pages[0]?.methods()).not.toContain("Cloudflare.handoffComplete");
      expect(pages[0]?.readyState).toBe(3);
    }),
  );

  it.effect("reads a script's value in the page shown", () =>
    Effect.gen(function* () {
      const { view } = yield* setup();

      expect(yield* view.evaluate("1 + 1", Schema.Finite)).toBe(2);
      expect(yield* Effect.flip(view.evaluate("1 + 1", Schema.String))).toMatchObject({
        message: "The page's answer could not be read.",
      });
    }).pipe(Effect.scoped),
  );
});
