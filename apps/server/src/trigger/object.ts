// What a `Trigger` object does (`docs/architecture/triggers.md` → The Trigger object and the Registry, ADR-0047): _how_
// a Trigger is reached and _when_ it fires. A Schedule coming due becomes a pending Fire, which the alarm drains through
// the Registry's `admitFire` and then the Session's `fire`, both keyed by the Fire's key, so a retried alarm never starts
// a second Session. At each touch the object reads its definition again (`triggerDefinition`) and retires (removed:
// its admitted Fires get a last try, then it wipes itself), drops its Fires not yet admitted and arms only for the
// admitted ones (paused), or re-arms (a changed Schedule): a lost message from a caller heals at its next touch. The
// alarm catches its own errors and re-arms, since the platform gives up after 6 retries. The ports keep the object
// testable: the real ones are RPC to the Registry and the Sessions (`Trigger.ts`).
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- the object's methods, over a Promise-based alarm.
import {
  type ApiResult,
  dueFires,
  type FireOutcome,
  type FireRecord,
  type FireRequest,
  type FireSource,
  nextFires,
  scheduledFireKey,
  scheduleOf,
  type SubmitResult,
  TriggerDefinition,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Types from "effect/Types";
import type { FireAdmission, FireAdmitted } from "../registry/triggers.ts";
import { hasTriggerStore, openTriggerStore, type PendingFire, type TriggerStore } from "./store.ts";

/** The Registry or a Session could not be reached: the Fire is tried again later. */
export class TriggerUnreachable extends Schema.TaggedError<
  TriggerUnreachable,
  { readonly brand: unique symbol }
>()("TriggerUnreachable", { message: Schema.String }) {}

/** What the object reaches: the Registry (definitions, `admitFire`, the owner's Notification) and the Sessions. */
export type TriggerPorts = {
  readonly definition: (
    trigger: string,
  ) => Effect.Effect<TriggerDefinition | null, TriggerUnreachable>;
  readonly admit: (fire: FireAdmission) => Effect.Effect<FireAdmitted, TriggerUnreachable>;
  /** Tell the owner a Fire failed. Never fails. */
  readonly failed: (trigger: string, reason: string) => Effect.Effect<void>;
  readonly fire: (
    session: string,
    request: FireRequest,
  ) => Effect.Effect<ApiResult<SubmitResult>, TriggerUnreachable>;
  /** What runs after a Fire's Session started in `environment`: the spare and Build upkeep. Never fails. */
  readonly afterStart: (environment: string) => Effect.Effect<void>;
};

/** The object's alarm and storage, as the platform gives them (`ctx.storage`). */
export type TriggerStorage = Parameters<typeof openTriggerStore>[0] & {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  deleteAll(): Promise<void>;
};

/** What the object says of itself: its definition as last read, its next Fire, its last one and how many wait. */
export type TriggerState = {
  readonly definition: TriggerDefinition | null;
  readonly nextFireAt: number | null;
  readonly lastFire: FireRecord | null;
  readonly pending: number;
};

/** What the owner's Fire now answers: the Fire's key once it waits, or why there is none. */
export type FireNowAnswer =
  | { readonly status: "queued"; readonly key: string }
  | { readonly status: "removed" }
  | { readonly status: "paused" };

/** The object's RPC methods and its alarm. */
export type TriggerHandlers = {
  /**
   * Read the definition again and act on it: retire (removed), keep only the admitted Fires (paused) or re-arm. What
   * callers call after a change.
   */
  readonly sync: () => Effect.Effect<TriggerState, TriggerUnreachable>;
  /** Its Trigger is gone: complete its admitted Fires, as far as they can be now, then delete its alarm and storage. */
  readonly remove: () => Effect.Effect<void>;
  /**
   * The owner's Fire now: a Fire recorded `manual`, drained by the alarm at once. A caller's `key` makes it one Fire
   * however often it is asked (`<trigger>:manual:<key>`): a key pending or in the fire log answers it again.
   */
  readonly fireNow: (input?: {
    readonly key?: string | undefined;
  }) => Effect.Effect<FireNowAnswer, TriggerUnreachable>;
  /** The fire log, newest first. */
  readonly fireLog: (input?: {
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<FireRecord>>;
  readonly state: () => Effect.Effect<TriggerState>;
  /** The alarm: what came due becomes pending, and the pending Fires are drained. Never fails. */
  readonly alarm: (info?: { readonly retryCount?: number }) => Effect.Effect<void>;
};

/** How long after a failed alarm or an unreachable call the object tries again, at first. */
export const RETRY_MS = 60_000;

/** The longest wait between tries of a pending Fire. */
const MAX_RETRY_MS = 60 * 60_000;

/** How many times a pending Fire is tried before it is recorded `failed` (some 7 hours of tries). */
export const MAX_FIRE_ATTEMPTS = 12;

/** How many times a Fire is admitted again after a `stale` answer before it waits for the next try. */
const MAX_STALE_REFRESHES = 3;

/** A manual Fire's own part of its key: random, unlike a scheduled Fire's, since each one is its own Fire. */
// @effect-diagnostics-next-line cryptoRandomUUID:off -- a key, not a secret; the Registry's IDs use the same source.
const newManualId = (): string => crypto.randomUUID();

const backoff = (attempts: number): number => Math.min(RETRY_MS * 2 ** attempts, MAX_RETRY_MS);

const sameSchedule = (a: TriggerDefinition | undefined, b: TriggerDefinition): boolean => {
  const before = scheduleOf(a);
  const after = scheduleOf(b);

  return (
    before !== undefined &&
    after !== undefined &&
    before.cron === after.cron &&
    before.zone === after.zone
  );
};

const decodeDefinition = Schema.decodeUnknownOption(TriggerDefinition);

const NO_STATE: TriggerState = { definition: null, nextFireAt: null, lastFire: null, pending: 0 };

/** The outcome a span and its readers name: `started`, `skipped:<why>` or `failed`. */
const outcomeName = (outcome: FireOutcome): string =>
  outcome.type === "skipped" ? `skipped:${outcome.reason}` : outcome.type;

/**
 * The handlers of Trigger `id` (`trigger:<id>`) over its `storage` and `ports`. `now` is the object's clock (a test's,
 * else `Clock`). A call, an alarm and a sync run one at a time.
 */
export const triggerHandlers = (options: {
  readonly id: string;
  readonly storage: TriggerStorage;
  readonly ports: TriggerPorts;
  readonly now?: Effect.Effect<number>;
}): TriggerHandlers => {
  const { id, storage, ports } = options;
  const now = options.now ?? Clock.currentTimeMillis;
  const serially = Semaphore.withPermit(Semaphore.makeUnsafe(1));

  // Opened at the first use, and again after a wipe, so a Trigger that comes back (a reverted removal) has its tables.
  let opened: TriggerStore | undefined;

  // Set while the object retires (`retire`): a `removed` answer to one of its admitted Fires then only wipes.
  let retiring = false;

  const store = (): TriggerStore => {
    opened ??= openTriggerStore(storage);

    return opened;
  };

  /** The store, when the object has one: a read of an object never synced, or wiped, makes no tables. */
  const existing = (): TriggerStore | undefined =>
    opened ?? (hasTriggerStore(storage) ? store() : undefined);

  /**
   * Delete the object's alarm and storage. Its pending Fires go with its fire log, so each is logged as it goes
   * (`failed: removed`); one already admitted was completed first, as far as it could be (`retire`).
   */
  const wipe = Effect.gen(function* () {
    for (const pending of existing()?.pending() ?? []) {
      yield* Effect.logWarning("A removed Trigger dropped a pending Fire").pipe(
        Effect.annotateLogs({
          "trigger.id": id,
          "trigger.fire": pending.key,
          outcome: "failed: removed",
        }),
      );
    }

    yield* Effect.promise(async () => {
      await storage.deleteAlarm();
      await storage.deleteAll();
      opened = undefined;
    });
  });

  /**
   * The time the next Fire is due: the Schedule's next after the cursor, or a pending Fire's next try. A paused Trigger
   * has only its admitted Fires to complete.
   */
  const nextAt = (): number | undefined => {
    const definition = store().definition();

    if (definition === undefined) return undefined;

    const pending = Arr.filter(
      store().pending(),
      (fire) => !definition.paused || fire.session !== undefined,
    );

    const times = Arr.map(pending, (fire) => fire.nextTryAt);
    const schedule = scheduleOf(definition);
    const cursor = store().cursor();

    if (!definition.paused && schedule !== undefined && cursor !== undefined) {
      times.push(...nextFires(schedule, cursor, 1));
    }

    return times.length === 0 ? undefined : Math.min(...times);
  };

  const arm = Effect.promise(async () => {
    const at = nextAt();

    await (at === undefined ? storage.deleteAlarm() : storage.setAlarm(at));
  });

  /**
   * Act on `definition`, as read from the Registry at `at`: none retires the object (`retire`); a paused one is kept,
   * its pending Fires not yet admitted recorded `skipped: paused` and dropped, and its alarm armed only for the admitted
   * ones (it never catches up on resume); an active one is kept with its cursor, which a new or changed Schedule (or a
   * resume) starts at `at`, and the alarm is armed for its next Fire. Answers whether the object still holds a Trigger.
   */
  const adopt = (definition: TriggerDefinition | null, at: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (definition === null) {
        yield* retire(at);

        return false;
      }

      const before = store().definition();

      if (definition.paused) {
        for (const pending of store().pending()) {
          if (pending.session === undefined) {
            store().record({
              key: pending.key,
              at,
              source: pending.source,
              outcome: { type: "skipped", reason: "paused" },
            });
          }
        }

        store().keep(definition, undefined);
      } else {
        const cursor = store().cursor();

        const kept =
          cursor !== undefined && before?.paused === false && sameSchedule(before, definition);

        store().keep(definition, kept ? cursor : at);
      }

      yield* arm;

      return true;
    });

  const state = (): TriggerState => {
    const kept = existing();

    if (kept === undefined) return NO_STATE;

    return {
      definition: kept.definition() ?? null,
      nextFireAt: nextAt() ?? null,
      lastFire: kept.fires(1)[0] ?? null,
      pending: kept.pending().length,
    };
  };

  /** Record what came of pending Fire `pending` at `at`; a failure is pushed to the owner. */
  const settle = (pending: PendingFire, outcome: FireOutcome, at: number) =>
    Effect.gen(function* () {
      store().record({ key: pending.key, at, source: pending.source, outcome });
      yield* Effect.annotateCurrentSpan("trigger.outcome", outcomeName(outcome));

      if (outcome.type === "failed") yield* ports.failed(id, outcome.reason);
    });

  /** Try `pending` again later, or record it `failed` once it was tried `MAX_FIRE_ATTEMPTS` times. */
  const later = (pending: PendingFire, at: number, reason: string) =>
    pending.attempts + 1 >= MAX_FIRE_ATTEMPTS
      ? settle(pending, { type: "failed", reason }, at)
      : Effect.sync(() => store().retry(pending.key, at + backoff(pending.attempts))).pipe(
          Effect.andThen(Effect.annotateCurrentSpan("trigger.outcome", "retry")),
        );

  /** The Session's `fire` for `pending` of `definition` at `at`. */
  const requestOf = (
    definition: TriggerDefinition,
    pending: PendingFire,
    at: number,
  ): FireRequest => {
    const header: Types.Mutable<FireRequest["header"]> = {
      name: definition.name,
      zone: scheduleOf(definition)?.zone ?? "UTC",
      firedAt: at,
    };

    if (pending.source.type === "schedule") header.scheduledAt = pending.source.scheduledAt;

    const request: Types.Mutable<FireRequest> = {
      trigger: { id: definition.id, name: definition.name },
      requestId: pending.key,
      message: definition.message,
      header,
    };

    if (definition.model !== undefined) request.model = definition.model;

    if (definition.thinking !== undefined) request.thinking = definition.thinking;

    return request;
  };

  /**
   * Drain one pending Fire at `at`: let it through (`admitFire`, adopting a `stale` answer's definition and asking again),
   * then send it to its Session (`fire`). A Fire that can't reach either waits for a later try. One already admitted
   * goes on while its Trigger is paused (the Registry answers it its Session again). Answers whether the object still
   * holds a Trigger.
   */
  const drain = (pending: PendingFire, at: number, retryCount: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      for (let refresh = 0; refresh < MAX_STALE_REFRESHES; refresh++) {
        const definition = store().definition();

        if (definition === undefined) return true;

        if (definition.paused && pending.session === undefined) return true;

        const admission: Types.Mutable<FireAdmission> = {
          trigger: id,
          revision: definition.revision,
          requestId: pending.key,
        };

        if (pending.source.type === "schedule") admission.scheduledAt = pending.source.scheduledAt;

        const admitted = yield* Effect.result(ports.admit(admission));

        if (Result.isFailure(admitted)) {
          yield* later(pending, at, admitted.failure.message);

          return true;
        }

        const answer = admitted.success;

        switch (answer.status) {
          case "stale": {
            // The answer crossed RPC: a definition this version can't read waits for a later try.
            const current = decodeDefinition(answer.definition);

            if (Option.isNone(current)) {
              yield* later(pending, at, "its definition could not be read");

              return true;
            }

            if (!(yield* adopt(current.value, at))) return false;

            continue;
          }

          case "removed":
            // The Fires already admitted get their last try, unless this is one of them, retiring already.
            yield* retiring ? wipe : retire(at);

            return false;
          case "paused":
            return yield* adopt({ ...definition, paused: true }, at);
          case "skipped":
            yield* settle(pending, { type: "skipped", reason: answer.reason }, at);

            return true;
          case "started": {
            store().admitted(pending.key, answer.session);

            // The Fire took the Environment's spare or made a Workspace: the next spare is made ahead, whatever the
            // Session answers (a Fire let through before took nothing new).
            if (answer.repeated !== true) yield* ports.afterStart(answer.environment);

            const sent = yield* Effect.result(
              ports.fire(answer.session, requestOf(definition, pending, at)),
            );

            if (Result.isFailure(sent)) {
              yield* later(pending, at, sent.failure.message);

              return true;
            }

            if (!sent.success.ok) {
              yield* sent.success.error.retryable
                ? later(pending, at, sent.success.error.message)
                : settle(pending, { type: "failed", reason: sent.success.error.message }, at);

              return true;
            }

            yield* settle(pending, { type: "started", session: answer.session }, at);

            return true;
          }

          case "failed":
            yield* settle(pending, { type: "failed", reason: answer.reason }, at);

            return true;
          default:
            yield* settle(
              pending,
              { type: "failed", reason: "an answer this version doesn't know" },
              at,
            );

            return true;
        }
      }

      yield* later(pending, at, "its definition kept changing");

      return true;
    }).pipe(
      Effect.withSpan("trigger.fire", {
        attributes: {
          "trigger.id": id,
          "trigger.kind": store().definition()?.kind ?? "unknown",
          "trigger.source": pending.source.type,
          "trigger.lag_ms":
            pending.source.type === "schedule" ? at - pending.source.scheduledAt : 0,
          "trigger.retry_count": retryCount,
          "trigger.attempts": pending.attempts,
        },
      }),
    );

  /** What came due of the Schedule by `at` becomes one pending Fire (the latest), the rest recorded `missed`. */
  const takeDue = (at: number): void => {
    const definition = store().definition();
    const schedule = scheduleOf(definition);
    const cursor = store().cursor();

    if (
      definition === undefined ||
      definition.paused ||
      schedule === undefined ||
      cursor === undefined
    ) {
      return;
    }

    const due = dueFires(schedule, { after: cursor, now: at });

    for (const missed of due.missed) {
      store().record({
        key: scheduledFireKey(id, missed),
        at,
        source: { type: "schedule", scheduledAt: missed },
        outcome: { type: "skipped", reason: "missed" },
      });
    }

    if (due.fire === undefined) return;

    const source: FireSource = { type: "schedule", scheduledAt: due.fire };

    store().enqueue(scheduledFireKey(id, due.fire), source, at);
    store().keep(definition, due.fire);
  };

  /**
   * The Trigger is gone: its admitted Fires are completed first, as far as their Sessions can be reached now (the
   * Registry answers each its Session again), so none is left registered and empty; then the object is wiped.
   */
  const retire = (at: number): Effect.Effect<void> =>
    Effect.gen(function* () {
      retiring = true;

      for (const pending of existing()?.pending() ?? []) {
        if (pending.session === undefined) continue;

        if (!(yield* drain(pending, at, 0))) return;
      }

      yield* wipe;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          retiring = false;
        }),
      ),
    );

  const alarm = (info?: { readonly retryCount?: number }) =>
    Effect.gen(function* () {
      const at = yield* now;
      const read = yield* Effect.result(ports.definition(id));

      if (Result.isFailure(read)) {
        yield* Effect.logWarning("A Trigger could not read its definition", read.failure.message);
        yield* Effect.promise(() => storage.setAlarm(at + RETRY_MS));

        return;
      }

      if (!(yield* adopt(read.success, at))) return;

      takeDue(at);

      for (const pending of store().pending()) {
        if (pending.nextTryAt > at) continue;

        if (!(yield* drain(pending, at, info?.retryCount ?? 0))) return;
      }

      yield* arm;
    }).pipe(
      // The alarm catches its own errors and re-arms: the platform gives up after 6 retries.
      Effect.catchCause((cause) =>
        Effect.logError("A Trigger's alarm failed", cause).pipe(
          Effect.andThen(now),
          Effect.flatMap((at) => Effect.promise(() => storage.setAlarm(at + RETRY_MS))),
          Effect.ignoreCause,
        ),
      ),
      Effect.withSpan("trigger.alarm", { attributes: { "trigger.id": id } }),
      serially,
    );

  return {
    sync: () =>
      Effect.gen(function* () {
        const definition = yield* ports.definition(id);

        yield* adopt(definition, yield* now);

        return definition === null ? NO_STATE : state();
      }).pipe(serially),

    remove: () => serially(Effect.flatMap(now, retire)),

    fireNow: (input) =>
      Effect.gen(function* () {
        const at = yield* now;
        const key = `${id}:manual:${input?.key ?? newManualId()}`;

        // Asked again: the Fire is already pending or settled.
        if (existing()?.holds(key) === true) return { status: "queued", key } as const;

        const definition = yield* ports.definition(id);

        if (!(yield* adopt(definition, at)) || definition === null) {
          return { status: "removed" } as const;
        }

        if (definition.paused) return { status: "paused" } as const;

        store().enqueue(key, { type: "manual" }, at);
        yield* Effect.promise(() => storage.setAlarm(at));

        return { status: "queued", key } as const;
      }).pipe(serially),

    fireLog: (input) => Effect.sync(() => existing()?.fires(input?.limit) ?? []),

    state: () => Effect.sync(state),

    alarm,
  };
};
