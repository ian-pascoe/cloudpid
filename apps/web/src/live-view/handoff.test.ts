// @effect-diagnostics preferEffectArray:off preferSchemaOverJson:off strictEffectProvide:off -- a fake browser over native arrays, speaking CDP's plain JSON, given to each test's Live View.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { settle } from "../session/client.testing.ts";
import { fakeBrowser } from "./connection.testing.ts";
import { RETURN_PING_MS } from "./connection.ts";
import { openHandoff } from "./handoff.ts";

const HANDOFF = {
  targetId: "T",
  active: true,
  handoffId: "h1",
  instructions: "Sign in, then press Done",
  timeout: 300_000,
  durationMs: 60_000,
};

/** A Browser Handoff's Live View over a fake Browser Run and Session. */
const setup = () =>
  Effect.gen(function* () {
    const fake = fakeBrowser({
      answer: (method) => (method === "Cloudflare.getHandoffState" ? HANDOFF : undefined),
    });

    const view = yield* openHandoff(fake.mint).pipe(Effect.provide(fake.layer));

    yield* settle;

    return {
      ...fake,
      view,
      state: () => SubscriptionRef.getUnsafe(view.state),
      handoff: () => SubscriptionRef.getUnsafe(view.handoff),
    };
  });

describe("a Browser Handoff's Live View", () => {
  it.effect("reads the instructions and the deadline from the handoff before it is live", () =>
    Effect.gen(function* () {
      const { pages, state, handoff } = yield* setup();

      expect(pages[0]?.methods().slice(0, 3)).toEqual([
        "Page.enable",
        "Runtime.enable",
        "Cloudflare.getHandoffState",
      ]);
      expect(state().status).toBe("live");
      expect(handoff()).toEqual({
        instructions: "Sign in, then press Done",
        // The time left is timeout - durationMs, from now (the test clock's 0).
        deadline: 240_000,
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
      const { view, finish, killAll, state } = yield* setup();

      finish();
      killAll();

      const returned = yield* Effect.forkChild(view.returned);

      yield* TestClock.adjust(RETURN_PING_MS);
      yield* Fiber.join(returned);

      expect(state().status).toBe("ended");
    }).pipe(Effect.scoped),
  );

  it.effect("ends when the browser says the handoff is no longer active", () =>
    Effect.gen(function* () {
      const fake = fakeBrowser({
        answer: (method) =>
          method === "Cloudflare.getHandoffState" ? { ...HANDOFF, active: false } : undefined,
      });

      const view = yield* openHandoff(fake.mint).pipe(Effect.provide(fake.layer));

      yield* settle;

      expect(SubscriptionRef.getUnsafe(view.state).status).toBe("ended");
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

  it.effect("does not complete the handoff when the Pane closes", () =>
    Effect.gen(function* () {
      const pages = yield* Effect.scoped(
        Effect.gen(function* () {
          const { pages } = yield* setup();

          return pages;
        }),
      );

      expect(pages[0]?.methods()).not.toContain("Cloudflare.handoffComplete");
      expect(pages[0]?.readyState).toBe(3);
    }),
  );
});
