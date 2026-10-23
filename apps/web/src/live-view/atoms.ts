// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a key.

// A Live View as atoms (ADR-0011): one connection per Browser Handoff, open while its Pane reads it (the Pane stays
// mounted while another tab is shown), and its state. Closing the Pane disposes the atom, which closes the scope: the
// viewport is cleared and the sockets close, and the handoff goes on.

import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "../runtime.ts";
import { sessionClientAtom } from "../session/atoms.ts";
import { INITIAL_LIVE_VIEW_STATE, make } from "./connection.ts";

/** The Browser Handoff `requestId` of Session `sessionId`. */
export interface LiveViewKey {
  readonly sessionId: string;
  readonly requestId: string;
}

/** The key of a handoff, with both fields set, so equal keys are equal values. */
export const liveViewKey = (sessionId: string, requestId: string): LiveViewKey => ({
  sessionId,
  requestId,
});

/** The handoff's Live View: it connects when first read, with links its Session mints for this client. */
export const liveViewAtom = Atom.family((key: LiveViewKey) =>
  appRuntime.atom((get) =>
    get
      .result(sessionClientAtom(key.sessionId))
      .pipe(Effect.flatMap((client) => make(client.liveView(key.requestId)))),
  ),
);

const stateRefAtom = Atom.family((key: LiveViewKey) =>
  appRuntime.subscriptionRef((get) =>
    get.result(liveViewAtom(key)).pipe(Effect.map((view) => view.state)),
  ),
);

/** The Live View's state: `connecting` until it is built. */
export const liveViewStateAtom = Atom.family((key: LiveViewKey) =>
  Atom.map(stateRefAtom(key), (result) =>
    AsyncResult.getOrElse(result, () => INITIAL_LIVE_VIEW_STATE),
  ),
);

/** Mint links for Browser Handoff `requestId` of Session `sessionId`: for the hosted Live View, opened on a tap. */
export const mintLiveViewAtom = Atom.family((sessionId: string) =>
  appRuntime.fn(
    (requestId: string, get) =>
      get
        .result(sessionClientAtom(sessionId))
        .pipe(Effect.flatMap((client) => client.liveView(requestId))),
    { concurrent: true },
  ),
);

/** How the owner ends a handoff from the Live View: Done, or Failed with an optional reason. */
export interface Outcome {
  readonly success: boolean;
  readonly reason?: string;
}

/** Done or Failed: sent on the tab's connection; the Live View ends, and its Pane closes. */
export const finishLiveViewAtom = Atom.family((key: LiveViewKey) =>
  appRuntime.fn((outcome: Outcome, get) =>
    get
      .result(liveViewAtom(key))
      .pipe(Effect.flatMap((view) => view.finish(outcome.success, outcome.reason))),
  ),
);

/** Show the tab or one of its windows. */
export const showLiveViewWindowAtom = Atom.family((key: LiveViewKey) =>
  appRuntime.fn((targetId: string, get) =>
    get.result(liveViewAtom(key)).pipe(Effect.flatMap((view) => view.show(targetId))),
  ),
);

/** Connect again after the Live View was lost. */
export const retryLiveViewAtom = Atom.family((key: LiveViewKey) =>
  appRuntime.fn((_: void, get) =>
    get.result(liveViewAtom(key)).pipe(Effect.flatMap((view) => view.retry)),
  ),
);

/** Ask the Session whether the handoff still waits; the Live View ends when it does not. */
export const verifyLiveViewAtom = Atom.family((key: LiveViewKey) =>
  appRuntime.fn((_: void, get) =>
    get.result(liveViewAtom(key)).pipe(Effect.flatMap((view) => view.verify)),
  ),
);

/** Whether the Live View shows the Desktop layout (a 1280-wide viewport, panned and zoomed here). */
export const desktopLayoutAtom = Atom.family((_key: LiveViewKey) => Atom.make(false));

/** Whether the Failed form, which asks for an optional reason, is open. */
export const failingAtom = Atom.family((_key: LiveViewKey) => Atom.make(false));
