// Reading an App's HTML for the host (`docs/architecture/mcp-apps.md` → Declaring and reading Apps): the read of a `ui://`
// resource, its keeping, and what bounds the work. Pure checks are in `app-html.ts`, the storage in `app-store.ts`, and
// the requests that start a read in `request.ts`.
//
// - **One flight** per (`conn`, URI): the reads that several calls start for a page, and a mount's `ui/html { uri }`, share
//   one read. It runs on its own fiber, so it outlives the call that started it, and its answer is read from the
//   flight's `done`.
// - **One decode at a time** in the host: the engine's answer, its JSON, the HTML and its bytes are alive together, so
//   when the engine answers with a stream, a host-wide slot of 1 holds the step from reading the stream to the page's
//   keeping (`mcp-connections.md` → The engine, Large results). The engine round itself takes no slot, so a server that
//   is slow to answer delays no other's read; a read that waits for the slot longer than `APP_SLOT_WAIT_MS` gives up
//   (the engine lets a stream go unread for `MCP_STREAM_HOLD_MS`), and an answer inline takes none.
// - **A failed read is remembered:** a (`conn`, URI) whose read failed is not read again by a call until the inventory
//   `version` moves or a minute (`APP_READ_BACKOFF_MS`) has passed, and at most `MAX_REMEMBERED` are kept. A mount's own
//   read is never held back, and a read that was cancelled is no failure of the server.
// - **A cancelled read is the starter's:** a call's abort cancels the read it started while the call runs
//   (`startCallRead`'s watcher), and a mount's the one it started. A flight cancelled that a mount had joined ends
//   `cancelled`, and the mount reads once more rather than fail for another caller's abort; once the call has
//   answered the caller's stubs are gone, and the read goes on to the core's page timeout.
// @effect-diagnostics missingPipeableSignature:off missedPipeableOpportunity:off -- the reads' methods, not combinators.
import {
  HostFailed,
  MCP_APP_READ_BYTES,
  MCP_STREAM_HOLD_MS,
  ProtocolViolation,
  type McpEngineRequest,
  type McpEngineValue,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  TimedOut,
} from "@cloudpid/mcp/types";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import type { McpAppUiMeta } from "@cloudpid/mcp/types";
import { isJsonObject } from "@cloudpid/mcp/types";
import type { PriorRows } from "./store.ts";
import { appContentOf, jsonOf, listedUiMetaOf, pageOf } from "./app-html.ts";
import { type AppPage } from "./app-store.ts";
import { type McpDiscoveryServices, attemptOrHalt, isHalted } from "./discovery.ts";
import {
  abortOf,
  callContextOf,
  callFailed,
  type EngineAnswered,
  type Reached,
  type Resolved,
  sendToEngine,
} from "./engine-round.ts";
import { McpHostStore } from "./store.ts";
import { type EngineCallKind } from "./limits.ts";
import { MINUTE_MS } from "./time.ts";

/** A call does not read a page again for a (`conn`, URI) whose read failed, for this long unless the inventory moves. */
export const APP_READ_BACKOFF_MS = MINUTE_MS;

/** At most this many failures are remembered: the ones past their backoff go first, then the oldest. */
export const MAX_REMEMBERED = 256;

/**
 * A read that has its answer waits this long for the host's decode slot, half of what the engine lets its stream go
 * unread (`MCP_STREAM_HOLD_MS`), so it gives up with the stream still to cancel.
 */
export const APP_SLOT_WAIT_MS = MCP_STREAM_HOLD_MS / 2;

/** The `resources/list` that a page without `_meta.ui` is completed from is waited for this long. */
export const APP_LIST_TIMEOUT_MS = 10_000;

/** What a read of an App's page came to. */
export type AppOutcome =
  /** The page is kept under `hash`. */
  | { readonly kind: "kept"; readonly hash: string }
  /** The page was read and the storage refused it: the mount that asked may show it, and no one may claim it is kept. */
  | { readonly kind: "unkept"; readonly page: AppPage }
  | { readonly kind: "failed"; readonly answer: McpHostRequestResult }
  /** The read was cancelled by its starter's abort: no failure of the server's, and no answer for those who joined it. */
  | { readonly kind: "cancelled" };

/** One read in flight: its outcome once it ends, and a way to cancel it. */
type Flight = {
  readonly done: Deferred.Deferred<AppOutcome>;
  readonly cancel: Deferred.Deferred<void>;
};

type FailureHeld = { readonly version: string; readonly until: number };

export type McpAppReadsService = {
  readonly flights: Map<string, Flight>;
  readonly failures: Map<string, FailureHeld>;
  readonly slot: Semaphore.Semaphore;
};

/** The host's App reads: those in flight, the failures remembered and the slot a decode holds. Internal to the host. */
export class McpAppReads extends Context.Service<McpAppReads, McpAppReadsService>()(
  "@cloudpid/server/mcp/app-reads/McpAppReads",
) {
  static readonly layer = Layer.effect(
    McpAppReads,
    Effect.gen(function* () {
      return { flights: new Map(), failures: new Map(), slot: yield* Semaphore.make(1) };
    }),
  );
}

/**
 * What a read is of: the server, the `ui://` resource, the inventory `version` it is read for, the caller's context, and
 * the engine queue its requests wait in (a call's read is `background`, a mount's a `call`).
 */
export type AppRead = {
  readonly resolved: Resolved;
  readonly reached: Reached;
  readonly uri: string;
  readonly version: string;
  readonly ctx: McpHostRequestContext;
  readonly priority: EngineCallKind;
};

/** The services a read runs over. */
export type AppReadServices = McpDiscoveryServices | McpAppReads;

const keyOf = (read: AppRead) => `${read.resolved.view.server.conn}\0${read.uri}`;

/**
 * Whether a read may go beside a call: the connection is established already, so the two never `initialize` at once.
 * That is a Modern server (no `initialize`) and a Legacy one with a session; a Legacy server with none, over HTTP or
 * stdio, is read after the call, when the call has made its session.
 */
export const readsAlongside = (prior: PriorRows) =>
  (isJsonObject(prior.era) && prior.era["era"] === "modern") || prior.session !== undefined;

/** The value of `answered`, a `resources/read` or `resources/list` answer, or the failure of an engine that answered otherwise. */
const valueOf = (answered: EngineAnswered): Result.Result<McpEngineValue, McpHostRequestResult> =>
  answered.result.kind === "complete"
    ? Result.succeed(answered.result.result)
    : Result.fail(
        callFailed(
          ProtocolViolation.make({
            message: `The engine answered a read with ${answered.result.kind}`,
          }),
        ),
      );

/** `value`, unread, let go of: a stream is cancelled so the engine drops its bytes. */
const letGo = (value: McpEngineValue) =>
  value.kind === "stream"
    ? Effect.tryPromise(() => value.body.cancel()).pipe(Effect.ignore)
    : Effect.void;

/**
 * `work`, which decodes `value`, under the host's slot when `value` is a stream that is read (one over what a page may
 * weigh is cancelled by the decode, and takes none). A wait past `APP_SLOT_WAIT_MS` cancels the stream and is `TimedOut`.
 */
export const decoding = <A, R>(
  slot: Semaphore.Semaphore,
  value: McpEngineValue,
  work: Effect.Effect<Result.Result<A, McpHostRequestResult>, never, R>,
): Effect.Effect<Result.Result<A, McpHostRequestResult>, never, R> => {
  if (value.kind === "inline" || value.bytes > MCP_APP_READ_BYTES) return work;

  let held = false;

  // Still waiting for the slot when it is past: the stream is let go, and the read is a failure.
  const timeout = Effect.sleep(APP_SLOT_WAIT_MS).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        held
          ? Effect.never
          : letGo(value).pipe(
              Effect.as(
                Result.fail(
                  callFailed(
                    TimedOut.make({
                      message: "The App's HTML waited too long for its turn to be read",
                    }),
                  ),
                ),
              ),
            ),
      ),
    ),
  );

  return slot
    .withPermit(
      Effect.suspend(() => {
        held = true;

        return work;
      }),
    )
    .pipe(
      Effect.raceFirst(timeout),
      // A read cancelled while it waits leaves the engine its stream to drop.
      Effect.onInterrupt(() => letGo(value)),
    );
};

/**
 * The read of `read`'s page, and its keeping: the engine's answer, its content and `_meta.ui`, the page they make. The
 * engine round takes no slot; the step that decodes a streamed answer does.
 */
const readApp = (
  read: AppRead,
  hooks: McpHostRequestHooks,
  slot: Semaphore.Semaphore,
): Effect.Effect<
  Result.Result<Extract<AppOutcome, { readonly kind: "kept" | "unkept" }>, McpHostRequestResult>,
  never,
  McpDiscoveryServices
> =>
  Effect.gen(function* () {
    const { resolved, reached, uri, ctx, priority } = read;
    const callCtx = callContextOf(ctx);
    const store = yield* McpHostStore;

    const send = (request: McpEngineRequest) =>
      sendToEngine({ resolved, reached, request, hooks, mayHaveRun: false, priority });

    const answer = yield* send({ op: "resources/read", uri, ctx: callCtx });

    if (Result.isFailure(answer)) return Result.fail(answer.failure);

    const value = valueOf(answer.success);

    if (Result.isFailure(value)) return Result.fail(value.failure);

    const decode = Effect.gen(function* () {
      const content = yield* jsonOf(value.success).pipe(
        Effect.flatMap(appContentOf),
        Effect.result,
      );

      if (Result.isFailure(content)) return Result.fail(callFailed(content.failure));

      // The draft's fallback, read side only: a page whose content says nothing of `_meta.ui` takes the listing
      // entry's. The listing is bounded, and an answer that is a stream is no listing.
      const listed = Option.isSome(content.success.meta)
        ? Option.none<McpAppUiMeta>()
        : yield* send({ op: "resources/list", ctx: callCtx }).pipe(
            Effect.flatMap((listing) => {
              if (Result.isFailure(listing)) return Effect.succeedNone;

              const value = valueOf(listing.success);

              if (Result.isFailure(value)) return Effect.succeedNone;

              // An answer that is a stream is let go unread.
              return value.success.kind === "stream"
                ? letGo(value.success).pipe(Effect.as(Option.none<McpAppUiMeta>()))
                : jsonOf(value.success).pipe(
                    Effect.map((json) => listedUiMetaOf(json, uri)),
                    Effect.orElseSucceed(() => Option.none<McpAppUiMeta>()),
                  );
            }),
            Effect.timeoutOption(APP_LIST_TIMEOUT_MS),
            Effect.map(Option.flatten),
          );

      const meta = Option.getOrElse(
        Option.orElse(content.success.meta, () => listed),
        (): McpAppUiMeta => ({}),
      );

      const page = yield* pageOf(content.success.html, meta).pipe(Effect.result);

      if (Result.isFailure(page)) return Result.fail(callFailed(page.failure));

      const now = yield* Clock.currentTimeMillis;

      const kept = yield* attemptOrHalt(() =>
        store.putApp(resolved.view.server.conn, uri, read.version, page.success, now),
      );

      return Result.succeed(
        kept === undefined
          ? ({ kind: "unkept", page: page.success } as const)
          : ({ kind: "kept", hash: kept } as const),
      );
    });

    return yield* decoding(slot, value.success, decode);
  });

/** Remember `held` for `key`, within `MAX_REMEMBERED`: the ones past their backoff go first, then the oldest. */
export const remember = (
  failures: Map<string, FailureHeld>,
  key: string,
  held: FailureHeld,
  now: number,
) => {
  // Deleted first, so the key takes the newest place in the map's order.
  failures.delete(key);

  if (failures.size >= MAX_REMEMBERED) {
    for (const [each, past] of failures) {
      if (past.until <= now) failures.delete(each);
    }
  }

  for (const each of failures.keys()) {
    if (failures.size < MAX_REMEMBERED) break;

    failures.delete(each);
  }

  failures.set(key, held);
};

/** One flight, from the engine's request to the page's keeping, ending in `flight.done` whatever happens. */
const fly = (
  reads: McpAppReadsService,
  flight: Flight,
  read: AppRead,
): Effect.Effect<void, never, AppReadServices> =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const hooks: McpHostRequestHooks = { untilAborted: () => run(Deferred.await(flight.cancel)) };
    const key = keyOf(read);

    // The flight is forgotten before its outcome is told, so a read that starts on hearing it finds none in flight.
    const finish = (outcome: AppOutcome) =>
      Effect.suspend(() => {
        if (reads.flights.get(key) === flight) reads.flights.delete(key);

        return Deferred.succeed(flight.done, outcome);
      });

    const page = yield* readApp(read, hooks, reads.slot).pipe(
      Effect.raceFirst(Deferred.await(flight.cancel).pipe(Effect.as("cancelled" as const))),
    );

    if (page === "cancelled") return yield* finish({ kind: "cancelled" });

    if (Result.isFailure(page)) {
      // Remembered, so a server whose App is broken costs the calls that follow nothing.
      const now = yield* Clock.currentTimeMillis;

      remember(
        reads.failures,
        key,
        { version: read.version, until: now + APP_READ_BACKOFF_MS },
        now,
      );

      return yield* finish({ kind: "failed", answer: page.failure });
    }

    reads.failures.delete(key);

    return yield* finish(page.success);
  }).pipe(
    // A read that dies of a defect still ends its flight, with a failure that is no server's.
    Effect.catchCause(() =>
      Effect.suspend(() => {
        if (reads.flights.get(keyOf(read)) === flight) reads.flights.delete(keyOf(read));

        return Deferred.succeed(flight.done, {
          kind: "failed",
          answer: HostFailed.make({ message: "The MCP host could not read an App's HTML" }),
        });
      }),
    ),
    Effect.asVoid,
    // A backstop: an ended flight is never left in the map.
    Effect.ensuring(
      Effect.sync(() => {
        if (reads.flights.get(keyOf(read)) === flight) reads.flights.delete(keyOf(read));
      }),
    ),
  );

/** A read in flight for the caller, and how to stop watching the caller's abort once it no longer lives. */
export type StartedRead = {
  readonly flight: Flight;
  /** Stop cancelling the read when the caller's stubs die: call it when the caller's invocation ends. */
  readonly stopWatching: Effect.Effect<void>;
  /** Cancel the read, and stop watching, if the caller started it; a read the caller joined is left to its starter. */
  readonly cancel: Effect.Effect<void>;
};

/**
 * The read of `read`'s page: the one in flight if there is one, else a new one, which `hooks`' abort cancels until
 * `stopWatching` (with no `hooks`, nothing does).
 */
const begin = (
  reads: McpAppReadsService,
  read: AppRead,
  hooks: McpHostRequestHooks | undefined,
): Effect.Effect<StartedRead, never, AppReadServices> =>
  Effect.gen(function* () {
    const key = keyOf(read);
    const running = reads.flights.get(key);

    if (running !== undefined) {
      return { flight: running, stopWatching: Effect.void, cancel: Effect.void };
    }

    const flight: Flight = { done: Deferred.makeUnsafe(), cancel: Deferred.makeUnsafe() };

    reads.flights.set(key, flight);
    yield* Effect.forkDetach(fly(reads, flight, read));

    const cancel = Effect.asVoid(Deferred.succeed(flight.cancel, undefined));

    if (hooks?.untilAborted === undefined) return { flight, stopWatching: Effect.void, cancel };

    const watcher = yield* Effect.forkDetach(abortOf(hooks).pipe(Effect.andThen(cancel)));
    const stopWatching = Effect.asVoid(Fiber.interrupt(watcher));

    return { flight, stopWatching, cancel: Effect.andThen(stopWatching, cancel) };
  });

/** A mount's read of `read`'s page: the one in flight, else a new one, never held back by a failed one. */
export const startMountRead = (
  read: AppRead,
  hooks: McpHostRequestHooks,
): Effect.Effect<StartedRead, never, AppReadServices> =>
  Effect.gen(function* () {
    return yield* begin(yield* McpAppReads, read, hooks);
  });

/**
 * A call's read of `read`'s page: the one in flight if there is one, else a new one, none when the page's last read
 * failed for this inventory `version` less than a minute ago. The caller's abort cancels a read it started, until
 * `stopWatching`; with no `hooks`, nothing does. None once a storage operation has failed (background work stopped).
 */
export const startCallRead = (
  read: AppRead,
  hooks: McpHostRequestHooks | undefined,
): Effect.Effect<Option.Option<StartedRead>, never, AppReadServices> =>
  Effect.gen(function* () {
    // A storage operation failed: this instance was replaced, and a read it started could not keep its page.
    if (yield* isHalted) return Option.none();

    const reads = yield* McpAppReads;
    const key = keyOf(read);
    const held = reads.failures.get(key);

    if (
      !reads.flights.has(key) &&
      held?.version === read.version &&
      held.until > (yield* Clock.currentTimeMillis)
    ) {
      return Option.none();
    }

    return Option.some(yield* begin(reads, read, hooks));
  });

/** The outcome of `flight` if it has ended. */
export const appReadSoFar = (flight: Flight): Effect.Effect<Option.Option<AppOutcome>> =>
  Deferred.isDone(flight.done).pipe(
    Effect.flatMap((done) =>
      done ? Effect.asSome(Deferred.await(flight.done)) : Effect.succeedNone,
    ),
  );

/** The outcome of `flight`, waited for; `"left"` when the caller's abort ends the wait first, which ends no read. */
export const awaitAppRead = (
  flight: Flight,
  hooks: McpHostRequestHooks,
): Effect.Effect<AppOutcome | "left"> =>
  Deferred.await(flight.done).pipe(Effect.raceFirst(Effect.as(abortOf(hooks), "left" as const)));
