// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a page or two over native arrays and maps; and a plain constructor of a Live View.

// One Live View's connections (#154, ADR-0013), as an Effect program that lives in a scope: the Pane's. It asks its link
// source (`LinkSource`: for a Browser Handoff, the Session's `live_view`; links good for 60 s) for links when it opens,
// on every reconnect, when a page hears `Page.windowOpen`, and when a window's connection closes, and connects straight
// to Browser Run with them: frames never cross the Session. It knows nothing of what the links are for: a Pane that has
// more to say to the tab (the handoff's: `handoff.ts`) hooks the tab's connection with `AttachTab`.
//
// The tab's connection stays open while the Live View is. The page shown (the tab, or one of its windows: `windows.ts`)
// gets the viewport, the screencast (`Page.bringToFront` too: a page not in front sends no frames) and the owner's input.
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
import { coalesced } from "./coalesced.ts";
import type { DeviceMetrics, ScreencastSize } from "./viewport.ts";
import { selectWindow, stripOf, windowClosed, type WindowStrip } from "./windows.ts";

/** How long a connection has to answer the ping on return, in ms. */
export const RETURN_PING_MS = 1500;

/** How many times a lost connection is tried again, and how long apart, before the Live View gives up. */
export const RECONNECT_ATTEMPTS = 3;
export const RECONNECT_DELAY_MS = 1000;

/** How often, and how long apart, a window that opened is looked for when the first reading does not list it yet. */
const WINDOW_LOOKS = 3;
const WINDOW_LOOK_DELAY_MS = 500;

/**
 * How long a window whose connection closed is left out of the browser host's list, in ms: the host may list a window
 * that closed a moment longer. After it, the host's list decides again (and is read once more), so a pop-up that is
 * still open after a blip of its socket comes back.
 */
export const GONE_GRACE_MS = 2000;

export type LiveViewStatus =
  /** Asking for links and connecting, the first time. */
  | "connecting"
  /** Connected: frames come and input goes. */
  | "live"
  /** Connecting again after a connection was lost. */
  | "reconnecting"
  /** Connecting failed: `failure` says why, and `retry` tries again. */
  | "lost"
  /** The link source is over (a handoff ended: Done, Failed, Stop, timeout, or another device): the Pane closes. */
  | "ended";

export interface LiveViewState {
  readonly status: LiveViewStatus;
  readonly failure: string | null;
  /** The tab, its windows, and the page shown; null until connected. */
  readonly strip: WindowStrip | null;
}

export const INITIAL_LIVE_VIEW_STATE: LiveViewState = {
  status: "connecting",
  failure: null,
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

const Ignored = Schema.Unknown;

const Evaluation = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
  exceptionDetails: Schema.optional(Schema.Unknown),
});

/** Where a Live View gets its links: fresh ones for the tab and its windows on each call (good for 60 s). */
export type LinkSource = Effect.Effect<LiveViewLinks, LiveViewError | LiveViewOver>;

/**
 * What a link source (or `AttachTab`) fails with once it is over for good (a handoff that ended): the Live View ends
 * instead of retrying. Matched by its tag.
 */
export class LiveViewOver extends Schema.TaggedError<
  LiveViewOver,
  { readonly brand: unique symbol }
>()("LiveViewOver", { message: Schema.String }) {}

/** The tab's connection, as a Pane that puts more on it than the screen does sees it. */
export interface TabHandle {
  readonly call: CdpPage["call"];
  /**
   * Hear event `method` on the connection this handle wraps only; `handler` runs in the Live View's scope. `attach`
   * runs again on each connection, so a listener it adds applies to each; one added through `withTab` is lost when the
   * tab reconnects.
   */
  readonly on: <A>(
    method: string,
    schema: Schema.Decoder<A>,
    handler: (params: A) => Effect.Effect<void>,
  ) => void;
  /** End the Live View: its connections close and its status is `ended`. */
  readonly end: Effect.Effect<void>;
}

/**
 * Run on every connection of the tab, once its domains are enabled and before the Live View is `live`. Failing with
 * `LiveViewOver` ends the Live View; any other failure fails the connection (it is tried again).
 */
export type AttachTab = (tab: TabHandle) => Effect.Effect<void, LiveViewError | LiveViewOver>;

/** A Live View, for as long as its scope is open. */
export interface LiveView {
  /** Its status and the window strip: the same object until one changes. */
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
  /**
   * Connect afresh now, with new links and the viewport applied again: the link source shows another tab than the one
   * connected (a Browser Pane following the Owner tab another device switched to). It runs in the Live View's own fiber,
   * so a caller that is interrupted after it began (a newer switch replacing it) does not leave the Live View closed and
   * unconnected. Nothing once the Live View is over.
   */
  readonly reconnect: Effect.Effect<void>;
  /**
   * Connect afresh after the link source ended the Live View, when it has links again: a Browser Pane whose Owner tab was
   * gone and another is shown now. The Live View is `connecting` again, and ends again if the source says it is over.
   * Nothing once the scope is closed.
   */
  readonly resume: Effect.Effect<void>;
  /** Run `use` with the tab's connection; fails when it is not connected. */
  readonly withTab: <A>(
    use: (tab: TabHandle) => Effect.Effect<A, LiveViewError>,
  ) => Effect.Effect<A, LiveViewError>;
  /** Clear the viewport the Live View set, best effort: the page is going away (`pagehide`). */
  readonly clearViewport: () => void;
  /**
   * Run one of its effects for the DOM side (the screen's events and timers), inside the Live View's scope: it is
   * interrupted when the Live View closes, so nothing it started outlives the Pane. Rejects when it fails or is cut off.
   */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
}

/**
 * A Live View of the browser tab `source` mints links for, for as long as the scope is open, with `attach` (if any) run
 * on each connection of the tab. It connects at once. Closing the scope clears the viewport (best effort) and closes
 * its connections; whatever the links are for goes on.
 */
export const make = Effect.fnUntraced(function* (source: LinkSource, attach?: AttachTab) {
  const makeWebSocket = yield* Socket.WebSocketConstructor;
  const state = yield* SubscriptionRef.make(INITIAL_LIVE_VIEW_STATE);
  const lock = Semaphore.makeUnsafe(1);
  const run = yield* FiberSet.makeRuntime<never, void, never>();
  const runPromise = yield* FiberSet.makeRuntimePromise();
  const listeners = new Set<(frame: Frame) => void>();

  let current = INITIAL_LIVE_VIEW_STATE;
  let tab: CdpPage | null = null;
  let shown: CdpPage | null = null;
  let viewport: { readonly metrics: DeviceMetrics; readonly size: ScreencastSize } | null = null;
  let closing = false;
  let over = false;

  /** Windows whose connection closed, and until when (ms) they are left out of the host's list: `GONE_GRACE_MS`. */
  const gone = new Map<string, number>();

  /** Connections closed on purpose (a window no longer shown, a dead socket), whose close says nothing of the page. */
  const dropped = new WeakSet<CdpPage>();

  /** Whether a check on return is running: `visibilitychange` and `pageshow` both come back. */
  let checking = false;

  const drop = (page: CdpPage) => {
    dropped.add(page);
    page.close();
  };

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

    for (const page of open) drop(page);
  };

  const end = Effect.suspend(() => {
    over = true;
    closeAll();

    return update({ status: "ended" });
  });

  /** Fresh links, without the windows that closed in the last `GONE_GRACE_MS`; the Live View ends when the source is over. */
  const links = Effect.gen(function* () {
    const minted = yield* source.pipe(Effect.tapErrorTag("LiveViewOver", () => end));

    const now = yield* Clock.currentTimeMillis;

    for (const [targetId, until] of gone) if (until <= now) gone.delete(targetId);

    return {
      tab: minted.tab,
      windows: minted.windows.filter((window) => !gone.has(window.targetId)),
    };
  });

  /** The domains every page shown needs: its frames and window events, and scripts. */
  const enableDomains = (page: CdpPage) =>
    Effect.gen(function* () {
      yield* Effect.ignore(page.call("Page.enable", {}, Ignored));
      yield* Effect.ignore(page.call("Runtime.enable", {}, Ignored));
    });

  /** The viewport on `page`: the Pane's size, and touch emulation on a touch screen. */
  const applyViewport = (page: CdpPage) =>
    Effect.gen(function* () {
      if (viewport === null) return;

      const { metrics } = viewport.metrics;

      yield* Effect.ignore(page.call("Emulation.setDeviceMetricsOverride", metrics, Ignored));
      yield* Effect.ignore(
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

      yield* Effect.ignore(
        page.call("Page.startScreencast", { format: "jpeg", quality: 70, ...size }, Ignored),
      );
      // A page that is not in front sends no frames.
      yield* Effect.ignore(page.call("Page.bringToFront", {}, Ignored));
    });

  /** Hear a page's frames (the shown one's go to the listeners) and the windows it opens. */
  const listen = (page: CdpPage) => {
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

  /** `page`, the tab's connection, as `attach` sees it. */
  const tabHandle = (page: CdpPage): TabHandle => ({
    call: page.call,
    on: (method, schema, handler) => {
      page.on(method, schema, (params) => {
        run(handler(params));
      });
    },
    end,
  });

  /** Make `page` the page shown: the last one's screencast stops (and a window's connection closes). */
  const display = (page: CdpPage) =>
    Effect.gen(function* () {
      const previous = shown;

      if (previous !== null && previous !== page) {
        previous.send("Page.stopScreencast");

        if (previous !== tab) drop(previous);
      }

      shown = page;

      yield* enableDomains(page);
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

      // The Live View closed or ended while this connected.
      if (isOver()) {
        drop(page);

        return;
      }

      listen(page);
      run(
        page.closed.pipe(
          Effect.andThen(() =>
            isOver() || page === tab || dropped.has(page) || shown !== page
              ? Effect.void
              : windowLost(page.targetId),
          ),
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

  /** A page opened a window; however often pages say so, one look runs and one waits. */
  const windowOpened: Effect.Effect<void> = coalesced(refresh(true).pipe(Effect.ignore));

  /**
   * The window shown lost its connection: back to its opener, and the windows are read again. The host decides whether
   * it closed: it is left out for `GONE_GRACE_MS`, then read again, so one still listed comes back.
   */
  const windowLost = (targetId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      gone.set(targetId, now + GONE_GRACE_MS);

      if (current.strip !== null) yield* update({ strip: windowClosed(current.strip, targetId) });

      if (shown?.targetId === targetId) shown = null;

      yield* Effect.ignore(refresh(false));

      const recheck = Effect.sleep(Duration.millis(GONE_GRACE_MS)).pipe(
        Effect.andThen(Effect.ignore(refresh(false))),
      );

      run(recheck);
    });

  /** Connect afresh: new links, the tab's connection, what `attach` does with it, and the page shown. */
  const connect = lock.withPermits(1)(
    Effect.gen(function* () {
      if (isOver()) return;

      closeAll();

      const minted = yield* links;
      const page = yield* openPage(makeWebSocket, minted.tab.link, minted.tab.targetId);

      if (isOver()) {
        drop(page);

        return;
      }

      tab = page;
      listen(page);
      run(
        page.closed.pipe(
          Effect.andThen(() =>
            isOver() || tab !== page || dropped.has(page) ? Effect.void : reconnect,
          ),
        ),
      );

      yield* enableDomains(page);

      if (attach !== undefined) {
        yield* attach(tabHandle(page)).pipe(Effect.tapErrorTag("LiveViewOver", () => end));
      }

      // The source ended while this connected.
      if (isOver()) {
        drop(page);

        return;
      }

      const strip = stripOf(minted, current.strip ?? undefined);

      yield* update({
        status: "live",
        failure: null,
        strip,
      });
      yield* showTarget(strip.shown, minted);
    }),
  );

  /** Connect again until it works, the Live View is over, or `RECONNECT_ATTEMPTS` failed: then the Live View is lost. */
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

  /** Close the connections and connect afresh. */
  const switchTab: Effect.Effect<void> = lock
    .withPermits(1)(Effect.sync(closeAll))
    .pipe(Effect.andThen(reconnect));

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
      if (isOver() || checking) return;

      checking = true;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          checking = false;
        }),
      );

      if (current.status === "lost") {
        yield* reconnect;

        return;
      }

      if (current.status !== "live") return;

      const checks = yield* Effect.forEach(pages(), answers, { concurrency: "unbounded" });

      if (checks.length === 0 || checks.some((ok) => !ok)) {
        // Drop the dead sockets first, so their close does not start a reconnect of its own.
        closeAll();

        // A new connection is sized and shown as the first was.
        yield* reconnect;
      }
    }).pipe(Effect.scoped),
    retry: Effect.suspend(() => (current.status === "lost" ? reconnect : Effect.void)),
    reconnect: Effect.sync(() => {
      if (!isOver()) run(switchTab);
    }),
    resume: Effect.sync(() => {
      if (closing) return;

      over = false;
      run(switchTab);
    }),
    withTab: (use) =>
      Effect.suspend(() =>
        tab === null
          ? Effect.fail(LiveViewError.make({ message: "The Live View is not connected." }))
          : use(tabHandle(tab)),
      ),
    clearViewport,
    run: (effect) => runPromise(effect),
  };

  return liveView;
});
