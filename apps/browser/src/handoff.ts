// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off globalDate:off tryCatchInEffectGen:off schemaSync:off preferTypedSchemaDecoder:off globalConsole:off
// The browser host's side of a Browser Handoff (`docs/spec.md` → Browser): Browser Run's structured handoff. The host
// attaches to the conversation's tab over its own CDP connection, mints a Live View link (`Cloudflare.getLiveView`),
// sends `Cloudflare.handoff` with the agent's instructions, and then hears the owner finish (or the handoff time out) as
// the `Cloudflare.handoffComplete` event on that same connection, which is how Browser Run's puppeteer and playwright
// ports use it. The Session asks in short rounds (`wait`), so a Session that was evicted meanwhile asks again and finds
// the same handoff. The record is kept in the object's storage, so the host's own restart does not lose it: the next
// round reconnects, and `Cloudflare.getHandoffState` says whether the handoff is still on.
//
// Nothing here logs or returns the Live View link except `start`'s result, which goes to the Session DO that asked.
import type {
  HandoffStarted,
  HandoffStartInput,
  HandoffStatus,
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
const LiveView = Schema.Struct({ devtoolsFrontendUrl: Schema.String });
const Started = Schema.Struct({ handoffId: Schema.String });
const State = Schema.Struct({ active: Schema.Boolean });

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
};

type Completion = { readonly success: boolean; readonly reason?: string | undefined };

/** A handoff as the object keeps it. */
type Record = {
  readonly requestId: string;
  readonly browserSessionId: string;
  readonly targetId: string;
  readonly handoffId: string;
  readonly url: string;
  readonly startedAt: number;
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

const KEY = (requestId: string) => `handoff:${requestId}`;

/** Browser Run takes a Live View deadline from one minute to one hour. */
const MIN_LIVE_VIEW_MS = 60_000;
const MAX_LIVE_VIEW_MS = 3_600_000;

/** How long to wait for the end event after `getHandoffState` said the handoff is over. */
const EVENT_GRACE_MS = 1_500;

/** How long a cleanup command to Browser Run may take. */
const CLEANUP_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Send `method` and read the fields `reply` names of its answer: an answer without them fails. */
const ask = async <A>(
  live: Pick<Live, "transport" | "cdpSessionId">,
  method: string,
  params: CdpParams,
  reply: Schema.Decoder<A>,
): Promise<A> =>
  Schema.decodeUnknownSync(reply)(await live.transport.send(method, params, live.cdpSessionId), {
    onExcessProperty: "ignore",
  });

export class HandoffHost {
  readonly #records: HandoffRecords;
  readonly #browser: HandoffBrowser;
  readonly #now: () => number;
  readonly #graceMs: number;
  readonly #live = new Map<string, Live>();
  /** Wakes the rounds waiting on a handoff when it ends. */
  readonly #ended = new Map<string, Set<() => void>>();

  constructor(options: {
    readonly records: HandoffRecords;
    readonly browser: HandoffBrowser;
    readonly now?: () => number;
    /** How long to wait for the end event once Browser Run says the handoff is over. Defaults to 1.5 seconds. */
    readonly graceMs?: number;
  }) {
    this.#records = options.records;
    this.#browser = options.browser;
    this.#now = options.now ?? Date.now;
    this.#graceMs = options.graceMs ?? EVENT_GRACE_MS;
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

    for (const wake of this.#ended.get(requestId) ?? []) wake();
  }

  /** Attach to `targetId` over a new connection and listen for the end of handoff `requestId`. */
  async #attach(requestId: string, browserSessionId: string, targetId: string): Promise<Live> {
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

        // One connection hears one handoff, but a stale event of an earlier one on the tab is not this one's end.
        if (
          record === undefined ||
          Option.isNone(complete) ||
          (complete.value.handoffId !== undefined && complete.value.handoffId !== record.handoffId)
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
   * the handoff already started.
   */
  async start(input: HandoffStartInput): Promise<HandoffStarted> {
    const existing = this.#record(input.requestId);

    if (existing !== undefined) return { url: existing.url, startedAt: existing.startedAt };

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
      const expiresInMs = Math.min(Math.max(input.timeoutMs, MIN_LIVE_VIEW_MS), MAX_LIVE_VIEW_MS);

      // `tab` is the one mode that supports handoff.
      const { devtoolsFrontendUrl: url } = await ask(
        live,
        "Cloudflare.getLiveView",
        { mode: "tab", expiresInMs },
        LiveView,
      );

      // The record exists before the command, so the end event of a handoff that completes at once is not dropped.
      const startedAt = this.#now();

      this.#save({
        requestId: input.requestId,
        browserSessionId: tab.browserSessionId,
        targetId: tab.targetId,
        handoffId: "",
        url,
        startedAt,
      });

      const { handoffId } = await ask(
        live,
        "Cloudflare.handoff",
        { instructions: input.instructions, timeout: input.timeoutMs },
        Started,
      );

      const record = this.#record(input.requestId);

      if (record !== undefined) this.#save({ ...record, handoffId });

      return { url, startedAt };
    } catch (error) {
      this.#forget(input.requestId);
      throw error;
    }
  }

  #forget(requestId: string): void {
    this.#live.get(requestId)?.transport.close();
    this.#live.delete(requestId);
    this.#ended.delete(requestId);
    this.#records.delete(KEY(requestId));
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

  /** Wait up to `maxMs` for the handoff to end, and say where it stands. */
  async wait(requestId: string, maxMs: number): Promise<HandoffStatus> {
    const record = this.#record(requestId);

    if (record === undefined || record.outcome !== undefined) return this.#status(record);

    let live: Live;

    try {
      live = await this.#connection(record);
    } catch (error) {
      // Browser Run no longer has the tab or the browser: the handoff cannot go on.
      console.warn(`A Browser Handoff's connection could not be reopened: ${String(error)}`);
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
   * Finish handoff `requestId`: when the owner has not, end it in Browser Run, so the Live View stops asking; then
   * forget it and drop its connection.
   */
  async end(requestId: string): Promise<void> {
    const record = this.#record(requestId);
    const live = this.#live.get(requestId);

    if (
      record !== undefined &&
      record.outcome === undefined &&
      live !== undefined &&
      !live.closed
    ) {
      await Promise.race([
        live.transport
          .send(
            "Cloudflare.handoffComplete",
            { success: false, reason: "The agent stopped waiting" },
            live.cdpSessionId,
          )
          .catch(() => undefined),
        sleep(CLEANUP_MS),
      ]);
    }

    this.#forget(requestId);
  }
}
