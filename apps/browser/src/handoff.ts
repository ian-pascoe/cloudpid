// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off tryCatchInEffectGen:off schemaSync:off preferTypedSchemaDecoder:off globalConsole:off extendsNativeError:off
// The browser host's side of a Browser Handoff (`docs/spec.md` → Browser): Browser Run's structured handoff. The host
// attaches to the conversation's tab over its own CDP connection, notes the tab's viewport, sends `Cloudflare.handoff`
// with the agent's instructions, and then hears the owner finish (or the handoff time out) as the
// `Cloudflare.handoffComplete` event on that same connection, which is how Browser Run's puppeteer and playwright ports
// use it. The Session asks in short rounds (`wait`), so a Session that was evicted meanwhile asks again and finds the
// same handoff. The record is kept in the object's storage, so the host's own restart does not lose it: the next round
// reconnects, and `Cloudflare.getHandoffState` says whether the handoff is still on.
//
// Live View links (ADR-0013) are minted only when the owner's Live View asks (`liveView`), for 60 s, Browser Run's
// minimum, and go back to the Session for the client that asked: nothing here keeps or logs one. Each names its page
// (`targetId`): without one, Browser Run picks the newest page of the browser, not the handed-over tab.
//
// The owner's Live View sets the tab's size (`Emulation.setDeviceMetricsOverride`, one override shared by every
// connection), and closing that connection does not undo it. So whenever a handoff ends, however it ended, the host sets
// the size the tab had at the start explicitly and checks it took (a clear from another connection was unreliable in
// the spike, #152).
//
// A record that outlives its handoff's deadline (the Session never came back to end it) is pruned, by the object's alarm
// if nothing else does (`prune`). A request that was ended leaves a short-lived tombstone, so a start that arrives late
// does not open a handoff nobody will end.
import {
  HANDOFF_OVER,
  type HandoffEnded,
  type HandoffStarted,
  type HandoffStartInput,
  type HandoffStatus,
  type LiveViewLinks,
  type LiveViewWindow,
} from "@cloudpid/extensions/browser/contract";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What a CDP command takes: JSON. */
export type CdpParams = { readonly [key: string]: Schema.Json };

/** A CDP event, as the connection hands it over. */
export type CdpEvent = {
  readonly method: string;
  readonly params?: Schema.Json | undefined;
  readonly sessionId?: string | undefined;
};

/** The replies this module reads: the fields it needs of what Browser Run answers. */
const Attached = Schema.Struct({ sessionId: Schema.String });
const LiveView = Schema.Struct({ webSocketDebuggerUrl: Schema.String });
const Started = Schema.Struct({ handoffId: Schema.String });
const State = Schema.Struct({ active: Schema.Boolean });

const Targets = Schema.Struct({
  targetInfos: Schema.Array(
    Schema.Struct({
      targetId: Schema.String,
      type: Schema.String,
      title: Schema.String,
      url: Schema.String,
      openerId: Schema.optionalKey(Schema.String),
    }),
  ),
});

/** A tab's size as its page reads it. */
const Viewport = Schema.Struct({
  width: Schema.Finite,
  height: Schema.Finite,
  deviceScaleFactor: Schema.Finite,
});

type Viewport = typeof Viewport.Type;

const Evaluated = Schema.Struct({ result: Schema.Struct({ value: Viewport }) });

/** Reads the tab's size in its page, as `Viewport`. */
const VIEWPORT_EXPRESSION =
  "({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })";

/** A Browser Run tab's size when nothing has set one (the spike, #152): what the tab is given back if it was not read. */
const DEFAULT_VIEWPORT: Viewport = { width: 780, height: 493, deviceScaleFactor: 1 };

/** The `Cloudflare.handoffComplete` event: how the handoff ended. */
const Complete = Schema.Struct({
  handoffId: Schema.optionalKey(Schema.String),
  success: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
});

/** One CDP connection to a Browser Run session. */
export type CdpTransport = {
  /** Send a command, in the CDP session `sessionId` when given; resolves with its result, rejects on an error or a timeout. */
  send(method: string, params?: CdpParams, sessionId?: string): Promise<Schema.Json>;
  /** Called for every event; one listener. */
  onEvent(listener: (event: CdpEvent) => void): void;
  /** Called once when the connection ends. */
  onClose(listener: () => void): void;
  close(): void;
};

/** What the host's browser provides a handoff. */
export type HandoffBrowser = {
  /**
   * The conversation's tab: the Browser Run session and the tab the conversation last worked in, or undefined when it
   * has none.
   */
  readonly tabOf: (
    conversationId: number,
  ) => Promise<{ readonly browserSessionId: string; readonly targetId: string } | undefined>;
  /** A new CDP connection to Browser Run session `browserSessionId`. */
  readonly connect: (browserSessionId: string) => Promise<CdpTransport>;
};

/** The object's synchronous key-value storage, as the handoffs use it. */
export type HandoffRecords = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list<T>(options: { readonly prefix: string }): Iterable<[string, T]>;
};

/** Browser Run no longer has the browser or the tab of a handoff: it cannot go on. */
export class BrowserGoneError extends Error {
  override readonly name = "BrowserGoneError";
}

type Completion = { readonly success: boolean; readonly reason?: string | undefined };

/** A handoff as the object keeps it. */
type Record = {
  readonly requestId: string;
  readonly browserSessionId: string;
  readonly targetId: string;
  readonly handoffId: string;
  readonly startedAt: number;
  /** The tab's size before the handoff, which the agent gets back when it ends. Absent in records from before it was kept. */
  readonly viewport?: Viewport | undefined;
  /** The viewport was given back. */
  readonly restored?: boolean | undefined;
  /** When the handoff times out, epoch milliseconds: the record is of no use past it. */
  readonly deadline: number;
  /** How the owner finished, once they have; `ended` when Browser Run lost the handoff without saying. */
  readonly outcome?: Completion | "ended" | undefined;
};

/** A handoff's connection in this instance. */
type Live = {
  readonly transport: CdpTransport;
  /** The CDP session attached to the tab, which the handoff's commands and events go through. */
  readonly cdpSessionId: string;
  closed: boolean;
};

const PREFIX = "handoff:";
const KEY = (requestId: string) => `${PREFIX}${requestId}`;

/** A request that was ended, so that a start arriving after it is refused. The value is when it ended. */
const ENDED_PREFIX = "handoff-ended:";
const ENDED_KEY = (requestId: string) => `${ENDED_PREFIX}${requestId}`;

/** How long past its deadline a record is kept: the Session's calls stop asking a grace period after it. */
const RETAIN_MS = 5 * 60_000;

/** How long a tombstone is kept: longer than a start can stay in flight or be retried. */
const TOMBSTONE_MS = 60 * 60_000;

/** How long a Live View link may start a connection: Browser Run's minimum. */
const LIVE_VIEW_MS = 60_000;

/** How many times the agent's viewport is set before the host gives up and says so. */
const RESTORE_TRIES = 2;

/** How long to wait for the end event after `getHandoffState` said the handoff is over. */
const EVENT_GRACE_MS = 1_500;

/** How long a cleanup command to Browser Run may take. */
const CLEANUP_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Send `method` and read the fields `reply` names of its answer: an answer without them fails. It goes in the tab's
 * session, or to the browser itself when `cdpSessionId` is undefined.
 */
const ask = async <A>(
  live: { readonly transport: CdpTransport; readonly cdpSessionId: string | undefined },
  method: string,
  params: CdpParams,
  reply: Schema.Decoder<A>,
): Promise<A> =>
  Schema.decodeUnknownSync(reply)(await live.transport.send(method, params, live.cdpSessionId), {
    onExcessProperty: "ignore",
  });

/** The tab's size as its page reads it. */
const readViewport = (live: Live): Promise<Viewport> =>
  ask(
    live,
    "Runtime.evaluate",
    { expression: VIEWPORT_EXPRESSION, returnByValue: true },
    Evaluated,
  ).then((evaluated) => evaluated.result.value);

/**
 * The pages tab `tabId` opened, directly or through a page it opened, from Browser Run's targets on the browser: pop-ups
 * and new tabs, `noopener` ones included, all name their opener (`openerId`, the spike, #152). A page with no opener (a
 * tab the agent made with `Target.createTarget`, another conversation's) is not one of them.
 */
const windowsOf = async (live: Live, tabId: string) => {
  const { targetInfos } = await ask(
    { transport: live.transport, cdpSessionId: undefined },
    "Target.getTargets",
    {},
    Targets,
  );

  const pages = targetInfos.filter((target) => target.type === "page");
  const found: Array<(typeof pages)[number] & { readonly openerId: string }> = [];
  const openers = [tabId];

  // Breadth first, so a window comes after the one that opened it; a page is taken once, whatever its opener says.
  for (let next = openers.shift(); next !== undefined; next = openers.shift()) {
    for (const target of pages) {
      if (
        target.openerId === next &&
        target.targetId !== tabId &&
        !found.some((window) => window.targetId === target.targetId)
      ) {
        found.push({ ...target, openerId: next });
        openers.push(target.targetId);
      }
    }
  }

  return found;
};

/** What the model may know of a window: its origin, never its URL (an OAuth redirect carries a code). */
const originOf = (url: string): string => {
  try {
    const parsed = new URL(url);

    if (parsed.origin !== "null") return parsed.origin;

    return parsed.href === "about:blank" ? "about:blank" : parsed.protocol;
  } catch {
    return "(unknown)";
  }
};

export class HandoffHost {
  readonly #records: HandoffRecords;
  readonly #browser: HandoffBrowser;
  readonly #now: () => number;
  readonly #graceMs: number;
  readonly #schedule: (at: number) => void;
  readonly #live = new Map<string, Live>();
  /** Starts in flight, so that a second start of the same request joins the first. */
  readonly #starting = new Map<string, Promise<HandoffStarted>>();
  /** Wakes the rounds waiting on a handoff when it ends. */
  readonly #ended = new Map<string, Set<() => void>>();
  /** Giving a handoff's tab its viewport back, in flight or done in this instance. */
  readonly #restoring = new Map<string, Promise<void>>();

  constructor(options: {
    readonly records: HandoffRecords;
    readonly browser: HandoffBrowser;
    readonly now?: () => number;
    /** How long to wait for the end event once Browser Run says the handoff is over. Defaults to 1.5 seconds. */
    readonly graceMs?: number;
    /** Ask to be woken (`prune`) at `at`, epoch milliseconds, so that records expire even when nothing else comes. */
    readonly schedule?: (at: number) => void;
  }) {
    this.#records = options.records;
    this.#browser = options.browser;
    this.#now = options.now ?? Date.now;
    this.#graceMs = options.graceMs ?? EVENT_GRACE_MS;
    this.#schedule = options.schedule ?? (() => undefined);
  }

  #record(requestId: string): Record | undefined {
    return this.#records.get<Record>(KEY(requestId));
  }

  #save(record: Record): void {
    this.#records.put(KEY(record.requestId), record);
  }

  /** Note how `requestId`'s handoff ended, and wake the rounds waiting on it. */
  #settle(requestId: string, outcome: Completion | "ended"): void {
    const record = this.#record(requestId);

    if (record === undefined || record.outcome !== undefined) return;

    this.#save({ ...record, outcome });

    // The rounds waiting on it wait for the viewport too, so the agent's next step finds its own size.
    void this.#restored(requestId);

    for (const wake of this.#ended.get(requestId) ?? []) wake();
  }

  /**
   * Give handoff `requestId`'s tab the size it had before the handoff, once: set it explicitly, then check the page's
   * width, and set it again if it did not take. Never fails; a failure is logged, and the next call tries again.
   */
  #restored(requestId: string): Promise<void> {
    const inFlight = this.#restoring.get(requestId);

    if (inFlight !== undefined) return inFlight;

    const record = this.#record(requestId);

    if (record?.viewport === undefined || record.restored === true) return Promise.resolve();

    const { viewport } = record;

    const restoring = (async () => {
      const live = await this.#connection(record);

      for (let attempt = 1; attempt <= RESTORE_TRIES; attempt++) {
        await live.transport.send(
          "Emulation.setDeviceMetricsOverride",
          { ...viewport, mobile: false },
          live.cdpSessionId,
        );

        const now = await readViewport(live);

        if (now.width === viewport.width && now.height === viewport.height) {
          const current = this.#record(requestId);

          if (current !== undefined) this.#save({ ...current, restored: true });

          return;
        }
      }

      throw new Error(`the tab kept another size than ${viewport.width}×${viewport.height}`);
    })().catch((error: Error) => {
      this.#restoring.delete(requestId);
      console.warn(`Giving the agent its viewport back failed: ${String(error)}`);
    });

    this.#restoring.set(requestId, restoring);

    return restoring;
  }

  /** Attach to `targetId` over a new connection and listen for the end of handoff `requestId`. */
  async #attach(requestId: string, browserSessionId: string, targetId: string): Promise<Live> {
    this.#live.get(requestId)?.transport.close();
    this.#live.delete(requestId);

    const transport = await this.#browser.connect(browserSessionId);

    try {
      const attached = Schema.decodeUnknownSync(Attached)(
        await transport.send("Target.attachToTarget", { targetId, flatten: true }),
        { onExcessProperty: "ignore" },
      );

      const live: Live = { transport, cdpSessionId: attached.sessionId, closed: false };

      transport.onEvent((event) => {
        if (event.method !== "Cloudflare.handoffComplete") return;

        const record = this.#record(requestId);
        const complete = Schema.decodeUnknownOption(Complete)(event.params);

        // One connection hears one handoff, but a stale event of an earlier one on the tab is not this one's end. The
        // record has no handoff id until Browser Run answers the command, and an event that comes first is this one's.
        if (
          record === undefined ||
          Option.isNone(complete) ||
          (complete.value.handoffId !== undefined &&
            record.handoffId !== "" &&
            complete.value.handoffId !== record.handoffId)
        ) {
          return;
        }

        this.#settle(requestId, {
          success: complete.value.success,
          reason: complete.value.reason,
        });
      });
      transport.onClose(() => {
        live.closed = true;
      });
      this.#live.set(requestId, live);

      return live;
    } catch (error) {
      transport.close();

      // Browser Run says the tab is not there: the handoff cannot go on, which is more than a failed attempt.
      if (error instanceof Error && /no target|not found/i.test(error.message)) {
        throw new BrowserGoneError(error.message, { cause: error });
      }

      throw error;
    }
  }

  /** The connection of `requestId`'s handoff, opened anew when this instance has none or it ended. */
  async #connection(record: Record): Promise<Live> {
    const existing = this.#live.get(record.requestId);

    if (existing !== undefined && !existing.closed) return existing;

    this.#live.delete(record.requestId);

    return this.#attach(record.requestId, record.browserSessionId, record.targetId);
  }

  /**
   * Hand conversation `input.conversationId`'s tab to the owner. Starting again under the same `requestId` answers with
   * the handoff already started, or joins the start in flight; a request that was ended is refused.
   */
  async start(input: HandoffStartInput): Promise<HandoffStarted> {
    this.prune();

    const existing = this.#record(input.requestId);

    if (existing !== undefined) return this.#started(existing);

    const inFlight = this.#starting.get(input.requestId);

    if (inFlight !== undefined) return inFlight;

    if (this.#records.get<number>(ENDED_KEY(input.requestId)) !== undefined) {
      throw new Error("This handoff was already ended");
    }

    const starting = this.#begin(input);

    this.#starting.set(input.requestId, starting);

    try {
      return await starting;
    } finally {
      this.#starting.delete(input.requestId);
    }
  }

  async #begin(input: HandoffStartInput): Promise<HandoffStarted> {
    const tab = await this.#browser.tabOf(input.conversationId);

    if (tab === undefined) {
      throw new Error(
        "This conversation has no open tab to hand over: open the page with the browser tool first",
      );
    }

    let live: Live;

    try {
      live = await this.#attach(input.requestId, tab.browserSessionId, tab.targetId);
    } catch (error) {
      throw new Error(`The conversation's tab is not available: ${String(error)}`, {
        cause: error,
      });
    }

    try {
      // The size the agent gets back when the handoff ends: the owner's Live View sets its own.
      const viewport = await readViewport(live).catch((error: Error) => {
        console.warn(`The tab's viewport could not be read: ${String(error)}`);

        return DEFAULT_VIEWPORT;
      });

      // The record exists before the command, so the end event of a handoff that completes at once is not dropped.
      const startedAt = this.#now();
      const deadline = startedAt + input.timeoutMs;

      this.#save({
        requestId: input.requestId,
        browserSessionId: tab.browserSessionId,
        targetId: tab.targetId,
        handoffId: "",
        startedAt,
        deadline,
        viewport,
      });
      this.#schedule(deadline + RETAIN_MS);

      const { handoffId } = await ask(
        live,
        "Cloudflare.handoff",
        { instructions: input.instructions, timeout: input.timeoutMs },
        Started,
      );

      const record = this.#record(input.requestId);

      if (record !== undefined) this.#save({ ...record, handoffId });

      // The owner may have finished before the answer came.
      return this.#started(this.#record(input.requestId) ?? { startedAt });
    } catch (error) {
      this.#forget(input.requestId);
      throw error;
    }
  }

  /** What a start answers for `record`: when it began, and whether it is over already. */
  #started(record: Pick<Record, "startedAt" | "outcome">): HandoffStarted {
    return record.outcome === undefined
      ? { startedAt: record.startedAt }
      : { startedAt: record.startedAt, over: true };
  }

  #forget(requestId: string): void {
    this.#live.get(requestId)?.transport.close();
    this.#live.delete(requestId);
    this.#ended.delete(requestId);
    this.#restoring.delete(requestId);
    this.#records.delete(KEY(requestId));
  }

  /**
   * Fresh Live View links to handoff `requestId`'s tab and to every window it opened that is still open, for the owner's
   * Live View: each good for 60 s and named by its target. Fails with `HANDOFF_OVER` once the handoff has ended.
   */
  async liveView(requestId: string): Promise<LiveViewLinks> {
    this.prune();

    const record = this.#record(requestId);

    if (record === undefined || record.outcome !== undefined) throw new Error(HANDOFF_OVER);

    const live = await this.#connection(record);

    const mint = async (targetId: string, cdpSessionId: string | undefined) =>
      (
        await ask(
          { transport: live.transport, cdpSessionId },
          "Cloudflare.getLiveView",
          { mode: "tab", expiresInMs: LIVE_VIEW_MS, targetId },
          LiveView,
        )
      ).webSocketDebuggerUrl;

    const [tab, found] = await Promise.all([
      // The tab's in its own session, as the handoff's other commands; the windows' on the browser.
      mint(record.targetId, live.cdpSessionId),
      windowsOf(live, record.targetId),
    ]);

    const windows = await Promise.all(
      found.map(async ({ targetId, openerId, title }): Promise<LiveViewWindow> => ({
        targetId,
        openerId,
        title,
        link: await mint(targetId, undefined),
      })),
    );

    return { tab: { targetId: record.targetId, link: tab }, windows };
  }

  /**
   * Drop the records of handoffs past their deadline and the tombstones past theirs, and say when the next one is due,
   * for the object's alarm. The Session ends its handoffs itself; this is for when it could not.
   */
  prune(): number | undefined {
    const now = this.#now();
    let next: number | undefined;

    const due = (at: number) => {
      next = next === undefined ? at : Math.min(next, at);
    };

    for (const [, record] of Array.from(this.#records.list<Record>({ prefix: PREFIX }))) {
      const expires = record.deadline + RETAIN_MS;

      if (now >= expires && !this.#starting.has(record.requestId)) this.#forget(record.requestId);
      else due(expires);
    }

    for (const [key, endedAt] of Array.from(this.#records.list<number>({ prefix: ENDED_PREFIX }))) {
      const expires = endedAt + TOMBSTONE_MS;

      if (now >= expires) this.#records.delete(key);
      else due(expires);
    }

    return next;
  }

  /** Where handoff `requestId` stands, from its record. */
  #status(record: Record | undefined): HandoffStatus {
    if (record === undefined) return { state: "unknown" };

    const { outcome } = record;

    if (outcome === undefined) return { state: "waiting" };

    if (outcome === "ended") return { state: "ended" };

    return outcome.reason === undefined || outcome.reason === ""
      ? { state: "complete", success: outcome.success }
      : { state: "complete", success: outcome.success, reason: outcome.reason };
  }

  /**
   * Wait up to `maxMs` for the handoff to end, and say where it stands. A handoff that ended is answered once the agent
   * has its viewport back.
   */
  async wait(requestId: string, maxMs: number): Promise<HandoffStatus> {
    const status = await this.#round(requestId, maxMs);

    if (status.state === "complete" || status.state === "ended") await this.#restored(requestId);

    return status;
  }

  async #round(requestId: string, maxMs: number): Promise<HandoffStatus> {
    this.prune();

    const record = this.#record(requestId);

    if (record === undefined || record.outcome !== undefined) return this.#status(record);

    let live: Live;

    try {
      live = await this.#connection(record);
    } catch (error) {
      // Only Browser Run saying the tab or the browser is gone ends the handoff. Any other failure (a network error, a
      // timeout) may pass, so it is rethrown for the Session to ask again.
      if (!(error instanceof BrowserGoneError)) throw error;

      console.warn(`A Browser Handoff's browser is gone: ${String(error)}`);
      this.#settle(requestId, "ended");

      return this.#status(this.#record(requestId));
    }

    // A restarted host has no listener for the event of a handoff that is still on, and its connection is new: ask.
    const asked = await this.#state(requestId, live);

    if (asked === "over") return this.#status(this.#record(requestId));

    await new Promise<void>((resolve) => {
      const wakes = this.#ended.get(requestId) ?? new Set();

      const wake = () => {
        clearTimeout(timer);
        wakes.delete(wake);
        resolve();
      };

      const timer = setTimeout(wake, maxMs);

      wakes.add(wake);
      this.#ended.set(requestId, wakes);
    });

    if (this.#record(requestId)?.outcome !== undefined)
      return this.#status(this.#record(requestId));

    // The round was quiet: the poll also tells the browser it is in use, and catches a handoff whose end event was missed.
    const after = this.#live.get(requestId);

    if (after !== undefined && !after.closed) await this.#state(requestId, after);

    return this.#status(this.#record(requestId));
  }

  /**
   * Ask Browser Run whether the handoff is still on. When it is not and no end event came, wait a moment for it, and
   * otherwise settle the handoff as ended without a reason.
   */
  async #state(requestId: string, live: Live): Promise<"on" | "over"> {
    let active = true;

    try {
      active = (await ask(live, "Cloudflare.getHandoffState", {}, State)).active;
    } catch (error) {
      console.warn(`A Browser Handoff's state could not be read: ${String(error)}`);
    }

    if (active) return "on";

    const deadline = Date.now() + this.#graceMs;

    while (this.#record(requestId)?.outcome === undefined && Date.now() < deadline) {
      await sleep(100);
    }

    this.#settle(requestId, "ended");

    return "over";
  }

  /**
   * Finish handoff `requestId`: when the owner has not, end it in Browser Run, so the Live View stops asking, over a new
   * connection if this instance has none (the host restarted since); give the agent its viewport back; say which of the
   * tab's windows are still open; then forget it and drop its connection. A start of the request that comes later is
   * refused.
   */
  async end(requestId: string): Promise<HandoffEnded> {
    // The tombstone first, so that no start slips in while the one in flight is awaited.
    const endedAt = this.#now();

    this.#records.put(ENDED_KEY(requestId), endedAt);
    this.#schedule(endedAt + TOMBSTONE_MS);

    await this.#starting.get(requestId)?.catch(() => undefined);

    const record = this.#record(requestId);
    let windows: ReadonlyArray<string> = [];

    if (record !== undefined) {
      await Promise.race([
        this.#connection(record)
          .then(async (live) => {
            // Too late: the cleanup gave up and the handoff is forgotten.
            if (this.#record(requestId) === undefined) {
              live.transport.close();

              return;
            }

            if (record.outcome === undefined) {
              await live.transport
                .send(
                  "Cloudflare.handoffComplete",
                  { success: false, reason: "The agent stopped waiting" },
                  live.cdpSessionId,
                )
                .catch(() => undefined);
            }

            await this.#restored(requestId);
            windows = (await windowsOf(live, record.targetId)).map(({ url }) => originOf(url));
          })
          .catch((error: Error) => {
            console.warn(`Cleaning up a Browser Handoff failed: ${String(error)}`);
          }),
        sleep(CLEANUP_MS),
      ]);
    }

    this.#forget(requestId);

    return { windows };
  }
}
