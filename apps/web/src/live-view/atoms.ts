// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a key.

// A Live View as atoms (ADR-0011): one connection per Browser Handoff, open while its Pane reads it (the Pane stays
// mounted while another tab is shown), and its state. Closing the Pane disposes the atom, which closes the scope: the
// viewport is cleared, the sockets close and whatever the screen was running is interrupted, and the handoff goes on.

import type { BrowserHandoffRequest } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { settledFailureOf } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import { agentLabel } from "../session/agents.ts";
import {
  browserHandoffRequestsAtom,
  listedBrowserHandoffRequestsAtom,
  sessionClientAtom,
  taskGraphAtom,
} from "../session/atoms.ts";
import { INITIAL_LIVE_VIEW_STATE, make, type LiveViewState } from "./connection.ts";

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

/**
 * The Live View's state: `connecting` until it is built, and `lost` (with Try again) when it could not be: the
 * Session's client failed.
 */
export const liveViewStateAtom = Atom.family((key: LiveViewKey) =>
  Atom.make((get): LiveViewState => {
    const built = get(liveViewAtom(key));

    // Built again (Try again): connecting, until it fails again.
    if (AsyncResult.isFailure(built) && !built.waiting) {
      return {
        ...INITIAL_LIVE_VIEW_STATE,
        status: "lost",
        failure: settledFailureOf(built) ?? "The Live View could not start.",
      };
    }

    return AsyncResult.getOrElse(get(stateRefAtom(key)), () => INITIAL_LIVE_VIEW_STATE);
  }),
);

/**
 * The handoff's request in the Session's list: undefined while this socket has not listed the handoffs yet, null once
 * a list came without it (the handoff is over, and its Pane closes).
 */
export const handoffRequestAtom = Atom.family((key: LiveViewKey) =>
  Atom.make((get): BrowserHandoffRequest | null | undefined => {
    const listed = get(listedBrowserHandoffRequestsAtom(key.sessionId));

    if (listed === null) return undefined;

    return Option.getOrNull(Arr.findFirst(listed, (request) => request.id === key.requestId));
  }),
);

/** The agent each waiting Browser Handoff of Session `sessionId` is for, by request ID, when it is a subagent. */
export const handoffAgentsAtom = Atom.family((sessionId: string) =>
  Atom.make((get): ReadonlyMap<string, string | undefined> => {
    const graph = get(taskGraphAtom(sessionId));

    return new Map(
      Arr.map(get(browserHandoffRequestsAtom(sessionId)), (request) => [
        request.id,
        agentLabel(graph, request.conversationId),
      ]),
    );
  }),
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

/** Try again: connect again after the Live View was lost, or build it again when it could not be built. */
export const retryLiveViewAtom = Atom.family((key: LiveViewKey) =>
  appRuntime.fn((_: void, get) => {
    if (AsyncResult.isFailure(get(liveViewAtom(key)))) {
      get.refresh(liveViewAtom(key));

      return Effect.void;
    }

    return get.result(liveViewAtom(key)).pipe(Effect.flatMap((view) => view.retry));
  }),
);
