// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a Live View.

// What a Browser Handoff adds to a Live View's connection (#154, ADR-0013), on the tab it handed over: its instructions
// and deadline (`Cloudflare.getHandoffState`), `Cloudflare.handoffComplete` heard from this device or another (which ends
// the Live View), and Done or Failed sent by the owner. The links come from the Session's `live_view`, which fails with
// `LIVE_VIEW_HANDOFF_OVER` once the handoff has ended. The connection (`connection.ts`) knows none of this; this layer
// hooks the tab's connection (`AttachTab`) and the Live View Pane puts the handoff's chrome on top.

import { LIVE_VIEW_HANDOFF_OVER, type LiveViewLinks } from "@cloudpid/protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { LiveViewError } from "./cdp-socket.ts";
import { LiveViewOver, make, type AttachTab, type LiveView } from "./connection.ts";

/** What the handoff says of itself, from its state. */
export interface BrowserHandoffState {
  /** What the agent asked for. */
  readonly instructions: string | null;
  /** When the handoff times out, in ms since the epoch. */
  readonly deadline: number | null;
}

/** What the handoff says before its Live View is connected: nothing. */
export const INITIAL_BROWSER_HANDOFF_STATE: BrowserHandoffState = {
  instructions: null,
  deadline: null,
};

/** `Cloudflare.getHandoffState`'s answer: `timeout - durationMs` is the time left. */
const GetHandoffState = Schema.Struct({
  active: Schema.Boolean,
  instructions: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Finite),
  durationMs: Schema.optional(Schema.Finite),
});

const Ignored = Schema.Unknown;

/** A Live View with the handoff's state and the way to finish it. */
export interface HandoffLiveView extends LiveView {
  /** The handoff's instructions and deadline: the same object until one changes. */
  readonly handoff: SubscriptionRef.SubscriptionRef<BrowserHandoffState>;
  /**
   * Done (`success`) or Failed with an optional `reason`: the viewport is cleared, then `Cloudflare.handoffComplete` is
   * sent on the tab's connection, as the hosted page does. The Live View ends.
   */
  readonly finish: (success: boolean, reason?: string) => Effect.Effect<void, LiveViewError>;
}

/**
 * The Live View of a Browser Handoff, for as long as the scope is open, with `mint` asking the Session for fresh links
 * (`SessionClient.liveView`). It connects at once. Closing the scope closes its connections; it does not end the handoff.
 */
export const openHandoffLiveView = Effect.fnUntraced(function* (
  mint: Effect.Effect<LiveViewLinks, { readonly message: string }>,
) {
  const handoff = yield* SubscriptionRef.make(INITIAL_BROWSER_HANDOFF_STATE);

  const links = mint.pipe(
    Effect.mapError((error) =>
      error.message === LIVE_VIEW_HANDOFF_OVER
        ? LiveViewOver.make({ message: error.message })
        : LiveViewError.make({ message: error.message }),
    ),
  );

  const attach: AttachTab = (tab) =>
    Effect.gen(function* () {
      tab.on("Cloudflare.handoffComplete", Ignored, () => tab.end);

      const state = yield* tab.call("Cloudflare.getHandoffState", {}, GetHandoffState);

      if (!state.active) return yield* LiveViewOver.make({ message: "The handoff is over." });

      const now = yield* Clock.currentTimeMillis;

      yield* SubscriptionRef.set(handoff, {
        instructions: state.instructions ?? null,
        deadline:
          state.timeout === undefined ? null : now + state.timeout - (state.durationMs ?? 0),
      });
    });

  const view = yield* make(links, attach);

  const live: HandoffLiveView = {
    ...view,
    handoff,
    finish: (success, reason) =>
      view.withTab((tab) =>
        Effect.gen(function* () {
          // Best effort: the browser host gives the agent its viewport back when the handoff ends anyway.
          view.clearViewport();

          yield* tab.call(
            "Cloudflare.handoffComplete",
            reason === undefined || reason === "" ? { success } : { success, reason },
            Ignored,
          );
          yield* tab.end;
        }),
      ),
  };

  return live;
});
