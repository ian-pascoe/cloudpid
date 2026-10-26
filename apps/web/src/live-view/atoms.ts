// @effect-diagnostics anyUnknownInErrorContext:off -- the Live View an atom holds, whatever its source fails with.

// The Live View's screen as atoms (ADR-0011): its state, the strip's buttons and Try again, for the Live View an atom
// holds, whatever its link source (a Browser Handoff's: `handoff-atoms.ts`). The Live View is connected while a Pane
// reads its atom.

import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Effect from "effect/Effect";
import { settledFailureOf } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import { INITIAL_LIVE_VIEW_STATE, type LiveView, type LiveViewState } from "./connection.ts";

/** A Live View a Pane connects by reading it: built when first read, with links from its source. */
export type LiveViewAtom = Atom.Atom<AsyncResult.AsyncResult<LiveView, unknown>>;

const stateRefAtom = Atom.family((view: LiveViewAtom) =>
  appRuntime.subscriptionRef((get) => get.result(view).pipe(Effect.map((built) => built.state))),
);

/**
 * The Live View's state: `connecting` until it is built, and `lost` (with Try again) when it could not be: its link
 * source failed to start.
 */
export const liveViewStateAtom = Atom.family((view: LiveViewAtom) =>
  Atom.make((get): LiveViewState => {
    const built = get(view);

    // Built again (Try again): connecting, until it fails again.
    if (AsyncResult.isFailure(built) && !built.waiting) {
      return {
        ...INITIAL_LIVE_VIEW_STATE,
        status: "lost",
        failure: settledFailureOf(built) ?? "The Live View could not start.",
      };
    }

    return AsyncResult.getOrElse(get(stateRefAtom(view)), () => INITIAL_LIVE_VIEW_STATE);
  }),
);

/** Show the tab or one of its windows. */
export const showLiveViewWindowAtom = Atom.family((view: LiveViewAtom) =>
  appRuntime.fn((targetId: string, get) =>
    get.result(view).pipe(Effect.flatMap((built) => built.show(targetId))),
  ),
);

/** Try again: connect again after the Live View was lost, or build it again when it could not be built. */
export const retryLiveViewAtom = Atom.family((view: LiveViewAtom) =>
  appRuntime.fn((_: void, get) => {
    if (AsyncResult.isFailure(get(view))) {
      get.refresh(view);

      return Effect.void;
    }

    return get.result(view).pipe(Effect.flatMap((built) => built.retry));
  }),
);
