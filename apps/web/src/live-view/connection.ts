// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a page or two over native arrays and maps; and a plain constructor of a Live View.

// One Live View's connections (#154, ADR-0013), as an Effect program that lives in a scope: the Pane's. It asks the
// Session for Live View links (`live_view`, links good for 60 s) when it opens, on every reconnect, when a page hears
// `Page.windowOpen`, and when a window's connection closes, and connects straight to Browser Run with them: frames never
// cross the Session.
//
// The handed-over tab's connection stays open while the Live View is: it reads the handoff's deadline
// (`Cloudflare.getHandoffState`), hears `Cloudflare.handoffComplete` (from this device or another, which ends the Live
// View), and sends Done or Failed. The page shown (the tab, or one of its windows: `windows.ts`) gets the viewport, the
// screencast (`Page.bringToFront` too: a page not in front sends no frames) and the owner's input.
//
// iOS kills a socket within ~20 s in the background without a close event, and it still reads as open. So on return
// (`returned`, called for `visibilitychange` to visible and `pageshow`) each connection is pinged with
// `Cloudflare.getSessionId`; one that does not answer in `RETURN_PING_MS` is dropped and the Live View reconnects with
// fresh links, the viewport applied again.

import type { LiveViewLinks } from "@cloudpid/protocol";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { CdpCommand } from "./cdp.ts";
import { LiveViewError, openPage, type CdpPage } from "./cdp-socket.ts";
import type { DeviceMetrics, ScreencastSize } from "./viewport.ts";
import { selectWindow, stripOf, windowClosed, type WindowStrip } from "./windows.ts";

/** The Session's answer to `live_view` once the handoff has ended. */
export const HANDOFF_OVER = "the handoff is over";

/** How long a connection has to answer the ping on return, in ms. */
export const RETURN_PING_MS = 1500;

/** How many times a lost connection is tried again, and how long apart, before the Live View gives up. */
export const RECONNECT_ATTEMPTS = 3;
export const RECONNECT_DELAY_MS = 1000;

/** How often, and how long apart, a window that opened is looked for when the first reading does not list it yet. */
const WINDOW_LOOKS = 3;
const WINDOW_LOOK_DELAY_MS = 500;

export type LiveViewStatus =
  /** Asking for links and connecting, the first time. */
  | "connecting"
  /** Connected: frames come and input goes. */
  | "live"
  /** Connecting again after a connection was lost. */
  | "reconnecting"
  /** Connecting failed: `failure` says why, and `retry` tries again. */
  | "lost"
  /** The handoff ended (Done, Failed, Stop, timeout, or another device): the Pane closes. */
  | "ended";

export interface LiveViewState {
  readonly status: LiveViewStatus;
  readonly failure: string | null;
  /** What the agent asked for, from the handoff's state. */
  readonly instructions: string | null;
  /** When the handoff times out, in ms since the epoch, from the handoff's state. */
  readonly deadline: number | null;
  /** The tab, its windows, and the page shown; null until connected. */
  readonly strip: WindowStrip | null;
}

export const INITIAL_LIVE_VIEW_STATE: LiveViewState = {
  status: "connecting",
  failure: null,
  instructions: null,
  deadline: null,
  strip: null,
};

/** What a screencast frame's metadata says about the page. */
export const FrameMetadata = Schema.Struct({
  deviceWidth: Schema.Finite,
  deviceHeight: Schema.Finite,
  offsetTop: Schema.Finite,
  pageScaleFactor: Schema.Finite,
  scrollOffsetX: Schema.Finite,
  scrollOffsetY: Schema.Finite,
});

export type FrameMetadata = typeof FrameMetadata.Type;

const ScreencastFrame = Schema.Struct({
  data: Schema.String,
  sessionId: Schema.Finite,
  metadata: FrameMetadata,
});

/** One frame of the page shown: a base64 JPEG and what it shows. */
export interface Frame {
  readonly targetId: string;
  readonly data: string;
  readonly metadata: FrameMetadata;
}

/** `Cloudflare.getHandoffState`'s answer: `timeout - durationMs` is the time left. */
const HandoffState = Schema.Struct({
  active: Schema.Boolean,
  instructions: Schema.optional(Schema.String),
  timeout: Schema.optional(Schema.Finite),
  durationMs: Schema.optional(Schema.Finite),
});

const Ignored = Schema.Unknown;

const Evaluation = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
  exceptionDetails: Schema.optional(Schema.Unknown),
});

/** A Live View, for as long as its scope is open. */
export interface LiveView {
  /** Its status, the handoff's instructions and deadline, and the window strip: the same object until one changes. */
  readonly state: SubscriptionRef.SubscriptionRef<LiveViewState>;
  /** Hear the frames of the page shown; returns how to stop. */
  readonly frames: (listener: (frame: Frame) => void) => () => void;
  /** Send the owner's input to the page shown. */
  readonly input: (commands: readonly CdpCommand[]) => void;
  /** Evaluate `expression` in the page shown, its value read by `schema`. */
  readonly evaluate: <A>(
    expression: string,
    schema: Schema.Decoder<A>,
  ) => Effect.Effect<A, LiveViewError>;
  /** Show the tab or one of its windows (the strip's buttons). */
  readonly show: (targetId: string) => Effect.Effect<void>;
  /** Size the page shown, and the ones shown later, to `metrics`, with frames up to `size`. */
  readonly resize: (metrics: DeviceMetrics, size: ScreencastSize) => Effect.Effect<void>;
  /** The page came back to the front: check each connection, and reconnect when one does not answer. */
  readonly returned: Effect.Effect<void>;
  /** Try again after the Live View was lost. */
  readonly retry: Effect.Effect<void>;
  /** Ask the Session whether the handoff still waits (its request left the Session's list): ends when it does not. */
  readonly verify: Effect.Effect<void>;
  /**
   * Done (`success`) or Failed with an optional `reason`: the viewport is cleared, then `Cloudflare.handoffComplete` is
   * sent on the tab's connection, as the hosted page does. The Live View ends.
   */
  readonly finish: (success: boolean, reason?: string) => Effect.Effect<void, LiveViewError>;
  /** Clear the viewport the Live View set, best effort: the page is going away (`pagehide`). */
  readonly clearViewport: () => void;
}

/** The handoff ended: a sentinel failure that stops whatever was connecting. */
const ended = LiveViewError.make({ message: HANDOFF_OVER });

/**
 * The Live View of a Browser Handoff, for as long as the scope is open, with `mint` asking the Session for fresh links
 * (`SessionClient.liveView`). It connects at once. Closing the scope clears the viewport (best effort) and closes its
 * connections; it does not end the handoff.
 */
export const make = Effect.fnUntraced(function* (
  mint: Effect.Effect<LiveViewLinks, { readonly message: string }>,
) {
  const makeWebSocket = yield* Socket.WebSocketConstructor;
  const state = yield* SubscriptionRef.make(INITIAL_LIVE_VIEW_STATE);
  const lock = Semaphore.makeUnsafe(1);
  const run = yield* FiberSet.makeRuntime<never, void, never>();
  const listeners = new Set<(frame: Frame) => void>();

  let current = INITIAL_LIVE_VIEW_STATE;
  let tab: CdpPage | null = null;
  let shown: CdpPage | null = null;
  let viewport: { readonly metrics: DeviceMetrics; readonly size: ScreencastSize } | null = null;
  let closing = false;
  let over = false;

  /** Windows whose connection closed: left out of later readings, which may list them a moment longer. */
  const gone = new Set<string>();

  const update = (change: Partial<LiveViewState>) =>
    Effect.suspend(() => {
      current = { ...current, ...change };

      return SubscriptionRef.set(state, current);
    });

  const isOver = () => over || closing;

  /** Every connection open: the tab's, and the window shown when it is not the tab. */
  const pages = (): CdpPage[] => {
    const open: CdpPage[] = [];

    if (tab !== null) open.push(tab);

    if (shown !== null && shown !== tab) open.push(shown);

    return open;
  };

  /** Close every connection, forgotten first so that their close is not taken for a lost connection. */
  const closeAll = () => {
    const open = pages();

    tab = null;
    shown = null;

    for (const page of open) page.close();
  };

  const end = Effect.suspend(() => {
    over = true;
    closeAll();

    return update({ status: "ended" });
  });

  /** Fresh links, without the windows known to be closed; the Live View ends when the handoff has. */
  const links = Effect.gen(function* () {
    const minted = yield* mint.pipe(
      Effect.mapError((error) =>
        error.message === HANDOFF_OVER ? ended : LiveViewError.make({ message: error.message }),
      ),
      Effect.tapError((error) => (error === ended ? end : Effect.void)),
    );

    return {
      tab: minted.tab,
      windows: minted.windows.filter((window) => !gone.has(window.targetId)),
    };
  });

  const bestEffort = <A, E>(effect: Effect.Effect<A, E>) => Effect.ignore(effect);

  /** The viewport on `page`: the Pane's size, and touch emulation on a touch screen. */
  const applyViewport = (page: CdpPage) =>
    Effect.gen(function* () {
      if (viewport === null) return;

      const { metrics } = viewport.metrics;

      yield* bestEffort(page.call("Emulation.setDeviceMetricsOverride", metrics, Ignored));
      yield* bestEffort(
        page.call(
          "Emulation.setTouchEmulationEnabled",
          viewport.metrics.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false },
          Ignored,
        ),
      );
    });

  const startScreencast = (page: CdpPage) =>
    Effect.gen(function* () {
      const size = viewport?.size ?? {};

      yield* bestEffort(
        page.call("Page.startScreencast", { format: "jpeg", quality: 70, ...size }, Ignored),
      );
      // A page that is not in front sends no frames.
      yield* bestEffort(page.call("Page.bringToFront", {}, Ignored));
    });

  /** Hear a page's frames (the shown one's go to the listeners) and the windows it opens. */
  const attach = (page: CdpPage) => {
    page.on("Page.screencastFrame", ScreencastFrame, (frame) => {
      page.send("Page.screencastFrameAck", { sessionId: frame.sessionId });

      if (shown !== page) return;

      for (const listener of Array.from(listeners)) {
        listener({ targetId: page.targetId, data: frame.data, metadata: frame.metadata });
      }
    });
    page.on("Page.windowOpen", Ignored, () => {
      run(windowOpened);
    });
  };

  /** Make `page` the page shown: the last one's screencast stops (and a window's connection closes). */
  const display = (page: CdpPage) =>
    Effect.gen(function* () {
      const previous = shown;

      if (previous !== null && previous !== page) {
        previous.send("Page.stopScreencast");

        if (previous !== tab) previous.close();
      }

      shown = page;

      yield* bestEffort(page.call("Page.enable", {}, Ignored));
      yield* bestEffort(page.call("Runtime.enable", {}, Ignored));
      yield* applyViewport(page);
      yield* startScreencast(page);
    });

  /** Show `targetId`: the tab, or a window, connected with its link in `minted`. */
  const showTarget = (targetId: string, minted: LiveViewLinks) =>
    Effect.gen(function* () {
      if (tab === null || shown?.targetId === targetId) return;

      if (targetId === tab.targetId) {
        yield* display(tab);

        return;
      }

      const link = minted.windows.find((window) => window.targetId === targetId)?.link;

      if (link === undefined) {
        yield* display(tab);

        return;
      }

      const page = yield* openPage(makeWebSocket, link, targetId);

      attach(page);
      run(
        page.closed.pipe(
          Effect.andThen(() => {
            if (isOver() || page === tab) return Effect.void;

            gone.add(page.targetId);

            return shown === page ? windowLost(page.targetId) : Effect.void;
          }),
        ),
      );

      yield* display(page);
    });

  /** Read the windows again and show what the strip says; `opened` waits for a new window to be listed. */
  const refresh = (opened: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (isOver() || tab === null) return;

        for (let look = 1; ; look++) {
          const minted = yield* links;
          const before = current.strip;
          const strip = stripOf(minted, before ?? undefined);

          const known = new Set(before?.windows.map((window) => window.targetId) ?? []);
          const found = strip.windows.some((window) => !known.has(window.targetId));

          if (!opened || found || look >= WINDOW_LOOKS) {
            yield* update({ strip });
            yield* showTarget(strip.shown, minted);

            return;
          }

          yield* Effect.sleep(Duration.millis(WINDOW_LOOK_DELAY_MS));
        }
      }),
    );

  const windowOpened: Effect.Effect<void> = Effect.ignore(refresh(true));

  /** The window shown closed: back to its opener, then the windows are read again. */
  const windowLost = (targetId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (current.strip !== null) yield* update({ strip: windowClosed(current.strip, targetId) });

      if (shown?.targetId === targetId) shown = null;

      yield* Effect.ignore(refresh(false));
    });

  /** Connect afresh: new links, the tab's connection, the handoff's state, and the page shown. */
  const connect = lock.withPermits(1)(
    Effect.gen(function* () {
      if (isOver()) return;

      closeAll();

      const minted = yield* links;
      const page = yield* openPage(makeWebSocket, minted.tab.link, minted.tab.targetId);

      tab = page;
      attach(page);
      page.on("Cloudflare.handoffComplete", Ignored, () => {
        run(end);
      });
      run(
        page.closed.pipe(
          Effect.andThen(() => (isOver() || tab !== page ? Effect.void : reconnect)),
        ),
      );

      yield* bestEffort(page.call("Page.enable", {}, Ignored));
      yield* bestEffort(page.call("Runtime.enable", {}, Ignored));

      const handoff = yield* page.call("Cloudflare.getHandoffState", {}, HandoffState);

      if (!handoff.active) return yield* Effect.fail(ended).pipe(Effect.tapError(() => end));

      const now = yield* Clock.currentTimeMillis;

      const deadline =
        handoff.timeout === undefined ? null : now + handoff.timeout - (handoff.durationMs ?? 0);

      // The handoff ended while this connected.
      if (isOver()) {
        page.close();

        return;
      }

      const strip = stripOf(minted, current.strip ?? undefined);

      yield* update({
        status: "live",
        failure: null,
        instructions: handoff.instructions ?? null,
        deadline,
        strip,
      });
      yield* showTarget(strip.shown, minted);
    }),
  );

  /** Connect again until it works, the handoff is over, or `RECONNECT_ATTEMPTS` failed: then the Live View is lost. */
  const reconnect: Effect.Effect<void> = Effect.gen(function* () {
    if (isOver()) return;

    yield* update({ status: current.strip === null ? "connecting" : "reconnecting" });

    for (let attempt = 1; ; attempt++) {
      const exit = yield* Effect.exit(connect);

      if (Exit.isSuccess(exit) || isOver()) return;

      if (attempt >= RECONNECT_ATTEMPTS) {
        const failure = Exit.findErrorOption(exit).pipe(
          Option.map((error) => error.message),
          Option.getOrElse(() => "The Live View was lost."),
        );

        yield* update({ status: "lost", failure });

        return;
      }

      yield* Effect.sleep(Duration.millis(RECONNECT_DELAY_MS));
    }
  });

  const answers = (page: CdpPage) =>
    page.call("Cloudflare.getSessionId", {}, Ignored, RETURN_PING_MS).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const clearViewport = () => {
    for (const page of pages()) {
      page.send("Emulation.clearDeviceMetricsOverride");
      page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (!over) clearViewport();

      closing = true;
      closeAll();
      listeners.clear();
    }),
  );

  run(reconnect);

  const liveView: LiveView = {
    state,
    frames: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    input: (commands) => {
      shown?.input(commands);
    },
    evaluate: (expression, schema) =>
      Effect.suspend(() => {
        if (shown === null) {
          return Effect.fail(LiveViewError.make({ message: "The Live View is not connected." }));
        }

        return shown
          .call(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true },
            Evaluation,
          )
          .pipe(
            Effect.flatMap((reply) =>
              reply.exceptionDetails === undefined
                ? Effect.fromOption(Schema.decodeUnknownOption(schema)(reply.result.value)).pipe(
                    Effect.mapError(() =>
                      LiveViewError.make({ message: "The page's answer could not be read." }),
                    ),
                  )
                : Effect.fail(LiveViewError.make({ message: "The page's script failed." })),
            ),
          );
      }),
    show: (targetId) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (current.strip === null || isOver()) return;

          const strip = selectWindow(current.strip, targetId);

          if (strip === current.strip) return;

          yield* update({ strip });

          if (tab !== null && targetId === tab.targetId) {
            yield* display(tab);

            return;
          }

          yield* showTarget(targetId, yield* links);
        }).pipe(Effect.ignore),
      ),
    resize: (metrics, size) =>
      Effect.gen(function* () {
        const before = viewport;

        viewport = { metrics, size };

        if (shown === null) return;

        yield* applyViewport(shown);

        if (
          before === null ||
          before.size.maxWidth !== size.maxWidth ||
          before.size.maxHeight !== size.maxHeight
        ) {
          shown.send("Page.stopScreencast");
          yield* startScreencast(shown);
        }
      }),
    returned: Effect.gen(function* () {
      if (isOver()) return;

      if (current.status === "lost") {
        yield* reconnect;

        return;
      }

      if (current.status !== "live") return;

      const checks = yield* Effect.forEach(pages(), answers, { concurrency: "unbounded" });

      if (checks.length === 0 || checks.some((ok) => !ok)) {
        // Drop the dead sockets first, so their close does not start a reconnect of its own.
        const dead = pages();

        tab = null;
        shown = null;

        for (const page of dead) page.close();

        yield* reconnect;

        if (viewport !== null && shown !== null) yield* applyViewport(shown);
      }
    }),
    retry: Effect.suspend(() => (current.status === "lost" ? reconnect : Effect.void)),
    verify: Effect.suspend(() => (isOver() ? Effect.void : Effect.ignore(links))),
    finish: (success, reason) =>
      Effect.gen(function* () {
        if (tab === null) {
          return yield* LiveViewError.make({ message: "The Live View is not connected." });
        }

        // Best effort: the browser host gives the agent its viewport back when the handoff ends anyway.
        clearViewport();

        yield* tab.call(
          "Cloudflare.handoffComplete",
          reason === undefined || reason === "" ? { success } : { success, reason },
          Ignored,
        );
        yield* end;
      }),
    clearViewport,
  };

  return liveView;
});
