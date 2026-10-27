// @effect-diagnostics preferEffectArray:off preferSchemaOverJson:off strictEffectProvide:off -- a fake browser over native arrays, speaking CDP's plain JSON, given to each test's Live View.

import type { LiveViewLinks } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { settle } from "../session/client.testing.ts";
import { keyPress } from "./cdp.ts";
import { fakeBrowser, frame, link } from "./connection.testing.ts";
import { GONE_GRACE_MS, make, RETURN_PING_MS, type Frame, whenEnded } from "./connection.ts";
import { deviceMetrics } from "./viewport.ts";

/** A Live View over a fake Browser Run, its links from a fake link source that knows nothing of handoffs. */
const setup = (options: Parameters<typeof fakeBrowser>[0] = {}) =>
  Effect.gen(function* () {
    const fake = fakeBrowser(options);
    const view = yield* make(fake.source).pipe(Effect.provide(fake.layer));

    yield* settle;

    return { ...fake, view, state: () => SubscriptionRef.getUnsafe(view.state) };
  });

describe("a Live View's connection", () => {
  it.effect("connects to the tab with a fresh link and starts the screencast", () =>
    Effect.gen(function* () {
      const { pages, state, mints } = yield* setup();

      expect(mints()).toBe(1);
      expect(pages.map((page) => page.url)).toEqual([link("T", 1)]);

      const tab = pages[0];

      expect(tab?.methods()).toEqual([
        "Page.enable",
        "Runtime.enable",
        "Page.enable",
        "Runtime.enable",
        "Page.startScreencast",
        "Page.bringToFront",
      ]);
      expect(tab?.last("Page.startScreencast")?.params).toMatchObject({ format: "jpeg" });
      expect(state()).toMatchObject({
        status: "live",
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

  it.effect("ends when the link source is over", () =>
    Effect.gen(function* () {
      const { view, finish, killAll, state } = yield* setup();

      finish();
      killAll();

      const returned = yield* Effect.forkChild(view.returned);

      yield* TestClock.adjust(RETURN_PING_MS);
      yield* Fiber.join(returned);

      expect(state().status).toBe("ended");
    }).pipe(Effect.scoped),
  );

  it.effect("says when it has ended, and not before", () =>
    Effect.gen(function* () {
      const { view, finish, killAll } = yield* setup();
      const ended = yield* Effect.forkChild(whenEnded(view));

      yield* settle;
      expect(ended.pollUnsafe()).toBeUndefined();

      finish();
      killAll();

      const returned = yield* Effect.forkChild(view.returned);

      yield* TestClock.adjust(RETURN_PING_MS);
      yield* Fiber.join(returned);
      yield* Fiber.join(ended);
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

  it.effect(
    "enables the DOM agent once per connection before its first DOM call, again after a reconnect",
    () =>
      Effect.gen(function* () {
        const { view, to, killAll } = yield* setup();

        const domCalls = (index: number) =>
          (to("T")[index]?.methods() ?? []).filter((method) => method.startsWith("DOM."));

        yield* view.call("Runtime.releaseObject", { objectId: "o" }, Schema.Unknown);
        expect(domCalls(0)).toEqual([]);

        yield* view.call("DOM.getNodeForLocation", { x: 1, y: 2 }, Schema.Unknown);
        yield* view.call("DOM.getBoxModel", { backendNodeId: 3 }, Schema.Unknown);
        expect(domCalls(0)).toEqual(["DOM.enable", "DOM.getNodeForLocation", "DOM.getBoxModel"]);

        // The socket dies; the Live View reconnects on return: a new connection, enabled again.
        killAll();

        const returned = yield* Effect.forkChild(view.returned);

        yield* TestClock.adjust(RETURN_PING_MS);
        yield* Fiber.join(returned);
        yield* view.call("DOM.getNodeForLocation", { x: 1, y: 2 }, Schema.Unknown);
        yield* view.call("DOM.getNodeForLocation", { x: 3, y: 4 }, Schema.Unknown);

        expect(domCalls(1)).toEqual([
          "DOM.enable",
          "DOM.getNodeForLocation",
          "DOM.getNodeForLocation",
        ]);
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

  it.effect(
    "brings back a window still listed after its socket dropped, once the grace is over",
    () =>
      Effect.gen(function* () {
        const windows = [{ targetId: "W", openerId: "T", title: "Sign in", link: "" }];
        const { view, to, state } = yield* setup({ windows: () => windows });

        yield* view.show("W");
        yield* to("W")[0]!.drop();

        // The host may list a window that closed a moment longer: it is left out for the grace.
        expect(state().strip).toMatchObject({ shown: "T", windows: [] });

        yield* TestClock.adjust(GONE_GRACE_MS);
        yield* settle;

        // Still listed: it was open all along (a blip), so it is back, and shown again.
        expect(state().strip).toMatchObject({ shown: "W", windows: [{ targetId: "W" }] });
        expect(to("W")[1]?.readyState).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("does not open a window's socket after the Live View closed", () =>
    Effect.gen(function* () {
      const windows = [{ targetId: "W", openerId: "T", title: "Sign in", link: "" }];

      const opened = yield* Effect.scoped(
        Effect.gen(function* () {
          const { view, to } = yield* setup({ windows: () => windows });

          yield* view.show("W");
          yield* to("W")[0]!.drop();

          return to;
        }),
      );

      yield* TestClock.adjust(GONE_GRACE_MS);
      yield* settle;

      expect(opened("W")).toHaveLength(1);
    }),
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

  it.effect("clears the viewport and closes when the Pane closes", () =>
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
