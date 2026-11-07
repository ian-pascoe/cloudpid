// What a `Trigger` object does (`docs/architecture/triggers.md` → The Trigger object and the Registry, ADR-0047): _how_
// a Trigger is reached and _when_ it fires. A Schedule coming due becomes a pending Fire, which the alarm drains through
// the Registry's `admitFire` and then the Session's `fire`, both keyed by the Fire's key, so a retried alarm never starts
// a second Session. At each touch the object reads its definition again (`triggerDefinition`) and retires (removed:
// its admitted Fires get a last try, then it wipes itself), drops its Fires not yet admitted and arms only for the
// admitted ones (paused), or re-arms (a changed Schedule): a lost message from a caller heals at its next touch. The
// alarm catches its own errors and re-arms, since the platform gives up after 6 retries. The ports keep the object
// testable: the real ones are RPC to the Registry and the Sessions (`Trigger.ts`). A webhook Trigger's object also
// holds its token and Signing secret (sealed, made at its first adopt), checks each delivery to its URL (`deliver`:
// token, signature, size, content type, then `match` and the bot-loop guard), counts what it refuses or filters per day
// without calling the Registry, and keeps an accepted delivery as a pending Fire (`docs/architecture/triggers.md` →
// Webhooks).
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- the object's methods, over a Promise-based alarm.
import type { KeptVault } from "@cloudpid/extensions/secrets/core";
import {
  type ApiResult,
  type DeliveryOutcome,
  dueFires,
  type FireOutcome,
  type FirePayload,
  type FireRecord,
  type FireRequest,
  type FireSource,
  matchesDelivery,
  MAX_DELIVERY_BODY_BYTES,
  MAX_KEPT_BODY_BYTES,
  nextFires,
  scheduledFireKey,
  scheduleOf,
  senderText,
  type SubmitResult,
  TriggerDefinition,
  webhookOf,
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
import {
  actionOf,
  bodyOf,
  contentKind,
  eventOf,
  isBotSender,
  keyedDelivery,
  senderLogin,
} from "./delivery.ts";
import {
  checkGitHubSignature,
  checkStandardSignature,
  sameBytes,
  standardSecretText,
} from "./signature.ts";
import {
  type DayCount,
  hasTriggerStore,
  type KeptSecrets,
  openTriggerStore,
  type PendingFire,
  type TriggerStore,
} from "./store.ts";

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
  /** The vault the object's token and Signing secret are sealed with, bound to the object's own id. */
  readonly vault: Effect.Effect<KeptVault, TriggerUnreachable>;
  /**
   * The login of the GitHub App's own bot account, in lower case (the bot-loop guard drops its deliveries), or undefined
   * while GitHub cannot say. Never fails.
   */
  readonly botLogin: Effect.Effect<string | undefined>;
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
  /**
   * The Fire waiting for its Workspace to be idle (`wait`), when there is one: when it was queued and how many later
   * Fires were merged into it.
   */
  readonly waiting?: { readonly since: number; readonly merged: number } | null;
};

/** What the owner's Fire now answers: the Fire's key once it waits, or why there is none. */
export type FireNowAnswer =
  | { readonly status: "queued"; readonly key: string }
  | { readonly status: "removed" }
  | { readonly status: "paused" };

/** What the owner's Fire again answers: as Fire now's, or `none` while no delivery was accepted yet. */
export type FireAgainAnswer = FireNowAnswer | { readonly status: "none" };

/** The headers of a delivery the object reads, as the main Worker read them (lower case names, absent when not sent). */
export type DeliveryHeaders = {
  readonly contentType?: string | undefined;
  /** `X-Hub-Signature-256` (`github`). */
  readonly signature?: string | undefined;
  /** `X-GitHub-Event` (`github`). */
  readonly event?: string | undefined;
  /** `X-GitHub-Delivery` (`github`). */
  readonly delivery?: string | undefined;
  /** `webhook-id`, `webhook-timestamp` and `webhook-signature` (`standard`). */
  readonly webhookId?: string | undefined;
  readonly webhookTimestamp?: string | undefined;
  readonly webhookSignature?: string | undefined;
};

/**
 * A delivery to the Trigger URL, as the main Worker hands it over: the URL's `token`, the headers the checks read, and
 * the body as received (`size` bytes). A body over `MAX_DELIVERY_BODY_BYTES` is not read: `body` is empty and `size`
 * says how large it was, so the object answers it once the token is right (it cannot check its signature).
 */
export type Delivery = {
  readonly token: string;
  readonly headers: DeliveryHeaders;
  readonly body: Uint8Array<ArrayBuffer>;
  readonly size: number;
};

/**
 * What a delivery is answered: the HTTP status and how it came out. `unavailable` (503) is the object's own trouble (its
 * vault could not be opened), which no delivery's fault caused.
 */
export type DeliveryAnswer = {
  readonly status: 200 | 401 | 404 | 413 | 415 | 503;
  readonly outcome: DeliveryOutcome | "unavailable";
};

/** A webhook Trigger's token and Signing secret, as the owner reads them (a `standard` secret as `whsec_<base64>`). */
export type HookSecrets = { readonly token: string; readonly secret: string };

/** What the object says of the deliveries it took: the last 30 days' counts, the last delivery's time, GitHub's ping's. */
export type DeliveryStats = {
  readonly counts: ReadonlyArray<DayCount>;
  readonly lastDeliveryAt: number | null;
  readonly pingAt: number | null;
};

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
  /**
   * The owner's Fire again: the last accepted delivery sent once more, a Fire recorded `manual` (`<trigger>:manual:<key>`
   * as `fireNow`'s, one Fire per `key`), or `none` while no delivery was accepted.
   */
  readonly fireAgain: (input?: {
    readonly key?: string | undefined;
  }) => Effect.Effect<FireAgainAnswer, TriggerUnreachable>;
  /**
   * Check a delivery to the Trigger URL and keep it as a pending Fire when it passes, answering once it is stored. It
   * never calls the Registry, so what anyone can send costs the Registry nothing. An object with no webhook Trigger
   * answers 404 and writes nothing.
   */
  readonly deliver: (delivery: Delivery) => Effect.Effect<DeliveryAnswer>;
  /** The deliveries the object took: the counts of the last 30 days, the last delivery's time and GitHub's ping's. */
  readonly deliveries: () => Effect.Effect<DeliveryStats>;
  /** The Trigger's token and Signing secret, or null for an object with none (not a webhook Trigger, not yet synced). */
  readonly reveal: () => Effect.Effect<HookSecrets | null, TriggerUnreachable>;
  /**
   * Make a new token (`url`) or Signing secret (`secret`) at once: the old one stops working at that moment. Answers the
   * secrets as `reveal` does, null for an object with none.
   */
  readonly rotate: (
    what: "url" | "secret",
  ) => Effect.Effect<HookSecrets | null, TriggerUnreachable>;
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

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/** 256 random bits as 43 base64url characters: a Trigger URL's token, and a Signing secret. */
const randomSecret = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

/** Whether `a` and `b` are the same sealed token and Signing secret. */
const sameSecrets = (a: KeptSecrets | undefined, b: KeptSecrets): boolean =>
  a !== undefined &&
  a.tokenHash === b.tokenHash &&
  a.token.ciphertext === b.token.ciphertext &&
  a.secret.ciphertext === b.secret.ciphertext;

/** Whether two texts are the same, taking as long whatever they hold when their lengths are equal. */
const sameText = (a: string, b: string): boolean => sameBytes(encoder.encode(a), encoder.encode(b));

const NO_STATE: TriggerState = {
  definition: null,
  nextFireAt: null,
  lastFire: null,
  pending: 0,
  waiting: null,
};

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

  const tokenBinding = { owner: id, name: "token" } as const;

  const secretBinding = { owner: id, name: "secret" } as const;

  /** A vault's failure as the object's: a call that is tried again, or answered `unavailable`. */
  const vaulted = <A, E extends { readonly message: string }>(
    effect: Effect.Effect<A, E | TriggerUnreachable>,
  ): Effect.Effect<A, TriggerUnreachable> =>
    Effect.mapError(effect, (error) =>
      Schema.is(TriggerUnreachable)(error)
        ? error
        : TriggerUnreachable.make({ message: `The vault failed: ${error.message}` }),
    );

  /**
   * Make the object's token and Signing secret anew, as far as `renew` says (`url` the token, `secret` the secret, both
   * the first time), sealed with the vault bound to this object, and keep them in place of the old, so the old stop
   * working at once.
   */
  const renew = (renewed: { readonly token: boolean; readonly secret: boolean }) =>
    vaulted(
      Effect.gen(function* () {
        const vault = yield* ports.vault;
        const kept = store().secrets();
        const text = randomSecret();

        const token =
          renewed.token || kept === undefined
            ? { sealed: yield* vault.seal(tokenBinding, text), hash: yield* vault.digest(text) }
            : { sealed: kept.token, hash: kept.tokenHash };

        const secret =
          renewed.secret || kept === undefined
            ? yield* vault.seal(secretBinding, randomSecret())
            : kept.secret;

        store().keepSecrets({ token: token.sealed, secret, tokenHash: token.hash });
      }),
    );

  /** A webhook Trigger's object holds its token and Signing secret from its first adopt on; a failure waits for the next. */
  const ensureSecrets = (definition: TriggerDefinition) =>
    webhookOf(definition) === undefined || store().secrets() !== undefined
      ? Effect.void
      : renew({ token: true, secret: true }).pipe(
          Effect.catch((error) =>
            Effect.logError("A webhook Trigger could not make its secrets", error.message),
          ),
        );

  /** The token and Signing secret as the owner reads them, or null for an object that has none. */
  const revealed = (): Effect.Effect<HookSecrets | null, TriggerUnreachable> =>
    Effect.gen(function* () {
      const kept = existing()?.secrets();
      const webhook = webhookOf(existing()?.definition());

      if (kept === undefined || webhook === undefined) return null;

      const vault = yield* ports.vault;
      const token = yield* vault.open(tokenBinding, kept.token);
      const secret = yield* vault.open(secretBinding, kept.secret);

      return { token, secret: webhook.format === "standard" ? standardSecretText(secret) : secret };
    }).pipe(vaulted);

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

      yield* ensureSecrets(definition);
      yield* arm;

      return true;
    });

  const state = (): TriggerState => {
    const kept = existing();

    if (kept === undefined) return NO_STATE;

    const pending = kept.pending();

    // As `drain` merges into it: the one not yet let through.
    const waiting = Arr.findFirst(
      pending,
      (fire) => fire.waiting !== undefined && fire.session === undefined,
    );

    return {
      definition: kept.definition() ?? null,
      nextFireAt: nextAt() ?? null,
      lastFire: kept.fires(1)[0] ?? null,
      pending: pending.length,
      waiting: Option.match(waiting, {
        onNone: () => null,
        onSome: (fire) => ({ since: fire.queuedAt, merged: fire.waiting?.merged ?? 0 }),
      }),
    };
  };

  /** Record what came of pending Fire `pending` at `at`; a failure is pushed to the owner. */
  const settle = (pending: PendingFire, outcomeOf: FireOutcome, at: number) =>
    Effect.gen(function* () {
      // The later Fires merged into a Fire that fails or is skipped for good are lost with it: the fire log says how many.
      const merged = pending.waiting?.merged ?? 0;
      let outcome = outcomeOf;

      if (merged > 0 && outcomeOf.type === "failed") {
        outcome = { ...outcomeOf, reason: `${outcomeOf.reason}, ${String(merged)} merged` };
      } else if (merged > 0 && outcomeOf.type === "skipped") {
        outcome = { ...outcomeOf, merged };
      }

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

    if (pending.waiting !== undefined && pending.waiting.merged > 0) {
      header.coalesced = pending.waiting.merged;
    }

    // A manual Fire that carries a payload is the owner's Fire again: the last delivery, sent once more.
    if (pending.source.type === "manual" && pending.payload !== undefined) header.again = true;

    const request: Types.Mutable<FireRequest> = {
      trigger: { id: definition.id, name: definition.name },
      requestId: pending.key,
      message: definition.message,
      header,
    };

    if (pending.payload !== undefined) request.payload = pending.payload;

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

        // A Workspace trigger holds at most one waiting Fire: a later one is merged into it, whether or not the
        // Workspace is idle by now, so the Fires start in the order they came.
        if (definition.whenBusy === "wait" && pending.session === undefined) {
          const waiting = Arr.findFirst(
            store().pending(),
            (other) =>
              other.key !== pending.key &&
              other.waiting !== undefined &&
              other.session === undefined,
          );

          if (pending.waiting === undefined && Option.isSome(waiting)) {
            store().coalesce(waiting.value.key);
            yield* settle(pending, { type: "skipped", reason: "coalesced" }, at);

            return true;
          }
        }

        const admission: Types.Mutable<FireAdmission> = {
          trigger: id,
          revision: definition.revision,
          requestId: pending.key,
        };

        if (pending.source.type === "schedule") admission.scheduledAt = pending.source.scheduledAt;

        if (pending.payload?.event !== undefined) admission.event = pending.payload.event;

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
          case "busy":
            // A Workspace trigger's Fire waits for its Workspace to be idle: tried again a minute later.
            store().wait(pending.key, at + RETRY_MS);
            yield* Effect.annotateCurrentSpan("trigger.outcome", "waiting");

            return true;
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

  /**
   * What a manual Fire (Fire now, Fire again) needs first: its key, which a caller's `key` makes one Fire however often
   * it is asked (a key pending or in the fire log answers `queued` again), and the definition read again, which may
   * answer `removed` or `paused` instead. `ready` says the Fire may be kept now, at `at`.
   */
  const manual = (input?: {
    readonly key?: string | undefined;
  }): Effect.Effect<
    FireNowAnswer | { readonly status: "ready"; readonly key: string; readonly at: number },
    TriggerUnreachable
  > =>
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

      return { status: "ready", key, at } as const;
    });

  /** What `examine` found of a delivery, to be kept by `deliver`. */
  type Verdict =
    | {
        readonly type: "refused";
        readonly status: 401 | 404 | 413 | 415;
        readonly outcome: DeliveryOutcome;
      }
    | { readonly type: "filtered"; readonly event: string | undefined }
    | { readonly type: "ping" }
    | { readonly type: "unavailable" }
    | {
        readonly type: "accepted";
        readonly key: string;
        readonly source: FireSource;
        readonly payload: FirePayload;
      };

  const refused = (status: 401 | 404 | 413 | 415, outcome: DeliveryOutcome): Verdict => ({
    type: "refused",
    status,
    outcome,
  });

  /**
   * Check `delivery` against what the object keeps, in order: the token (by its keyed hash, in constant time), the size,
   * the signature, GitHub's ping, the content type, the bot-loop guard and `match`. Reads and writes nothing of the
   * object's.
   */
  const examine = (
    webhook: NonNullable<ReturnType<typeof webhookOf>>,
    secrets: KeptSecrets,
    delivery: Delivery,
    at: number,
  ): Effect.Effect<Verdict, TriggerUnreachable> =>
    vaulted(
      Effect.gen(function* () {
        const vault = yield* ports.vault;
        const { headers, body } = delivery;

        if (!sameText(yield* vault.digest(delivery.token), secrets.tokenHash)) {
          return refused(404, "not_found");
        }

        if (delivery.size > MAX_DELIVERY_BODY_BYTES) return refused(413, "too_large");

        const secret = yield* vault.open(secretBinding, secrets.secret);

        const signature = yield* Effect.promise(() =>
          webhook.format === "github"
            ? checkGitHubSignature({ secret, body, signature: headers.signature ?? null })
            : checkStandardSignature({
                secret,
                body,
                id: headers.webhookId ?? null,
                timestamp: headers.webhookTimestamp ?? null,
                signature: headers.webhookSignature ?? null,
                now: at,
              }),
        );

        if (signature !== "valid") return refused(401, "unauthorized");

        if (webhook.format === "github" && headers.event === "ping") {
          return { type: "ping" } as const;
        }

        const kind = contentKind(headers.contentType);

        if (kind === undefined) return refused(415, "unsupported");

        const text = decoder.decode(body);
        const parsed = bodyOf(kind, text);
        const event = eventOf(webhook.format, headers, parsed);
        const login = senderLogin(parsed);

        // A bot's login ends `[bot]`: only then is GitHub asked for the App's own.
        if (
          webhook.format === "github" &&
          login?.toLowerCase().endsWith("[bot]") === true &&
          isBotSender(login, yield* ports.botLogin)
        ) {
          return { type: "filtered", event } as const;
        }

        if (!matchesDelivery(webhook.match, { event, body: parsed })) {
          return { type: "filtered", event } as const;
        }

        const sent =
          webhook.format === "github"
            ? (headers.delivery ?? newManualId())
            : (headers.webhookId ?? newManualId());

        const delivered = keyedDelivery(sent);
        const action = actionOf(parsed);

        // The body is kept as the text it decodes to, which a body of invalid bytes makes longer than it came.
        const kept =
          delivery.size <= MAX_KEPT_BODY_BYTES &&
          encoder.encode(text).length <= MAX_KEPT_BODY_BYTES;

        const payload: Types.Mutable<FirePayload> = {
          format: webhook.format,
          delivery: delivered,
          size: delivery.size,
        };

        if (event !== undefined) payload.event = event;

        if (action !== undefined) payload.action = action;

        if (headers.contentType !== undefined) payload.contentType = headers.contentType;

        if (kept) payload.body = text;

        const source: Types.Mutable<Extract<FireSource, { type: "webhook" }>> = {
          type: "webhook",
          delivery: delivered,
        };

        if (event !== undefined) source.event = event;

        return { type: "accepted", key: `${id}:${delivered}`, source, payload } as const;
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning("A delivery could not be checked", error.message).pipe(
          Effect.as({ type: "unavailable" } as const satisfies Verdict),
        ),
      ),
    );

  const NOT_FOUND: DeliveryAnswer = { status: 404, outcome: "not_found" };

  /** The span attributes of a delivery's answer: its outcome, and the event's name, made plain. */
  const spanned = (answer: DeliveryAnswer, event: string | undefined) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("trigger.outcome", answer.outcome);

      if (event !== undefined)
        yield* Effect.annotateCurrentSpan("trigger.event", senderText(event));
    });

  const deliver = (delivery: Delivery): Effect.Effect<DeliveryAnswer> =>
    Effect.gen(function* () {
      const at = yield* now;
      const kept = existing();
      const webhook = webhookOf(kept?.definition());
      const secrets = kept?.secrets();

      // No webhook Trigger here, whatever the id: nothing is written.
      if (kept === undefined || webhook === undefined || secrets === undefined) {
        yield* spanned(NOT_FOUND, undefined);

        return NOT_FOUND;
      }

      yield* Effect.annotateCurrentSpan("trigger.format", webhook.format);

      const verdict = yield* Effect.result(examine(webhook, secrets, delivery, at)).pipe(
        Effect.map((result) =>
          Result.isSuccess(result) ? result.success : ({ type: "unavailable" } as const),
        ),
      );

      // The checks took time: a rotation, a removal or a wipe since changes what they were made against.
      const current = existing();
      const same = sameSecrets(current?.secrets(), secrets);
      const definition = current?.definition();

      if (current === undefined || definition === undefined || !same) {
        yield* spanned(NOT_FOUND, undefined);

        return NOT_FOUND;
      }

      const answer = ((): DeliveryAnswer => {
        switch (verdict.type) {
          case "refused":
            current.count(verdict.outcome, at);

            return { status: verdict.status, outcome: verdict.outcome };
          case "unavailable":
            return { status: 503, outcome: "unavailable" };
          case "ping":
            current.delivered(at, true);

            return { status: 200, outcome: "ping" };
          case "filtered":
            current.delivered(at, false);
            current.count("filtered", at);

            return { status: 200, outcome: "filtered" };
          case "accepted": {
            current.delivered(at, false);

            // A repeat of a delivery (the sender's retry) is answered as the first was, and makes no second Fire.
            if (current.holds(verdict.key)) return { status: 200, outcome: "accepted" };

            current.keepLast(verdict.payload);

            if (definition.paused) {
              current.record({
                key: verdict.key,
                at,
                source: verdict.source,
                outcome: { type: "skipped", reason: "paused" },
              });
            } else {
              current.enqueue(verdict.key, verdict.source, at, verdict.payload);
            }

            return { status: 200, outcome: "accepted" };
          }
        }
      })();

      if (verdict.type === "accepted" && !definition.paused && answer.status === 200) {
        // Answered once the Fire is stored; the alarm admits it and starts its Session.
        yield* Effect.promise(() => storage.setAlarm(at));
      }

      yield* spanned(answer, verdict.type === "accepted" ? verdict.payload.event : undefined);

      return answer;
    }).pipe(
      Effect.withSpan("trigger.delivery", {
        attributes: { "trigger.id": id, "trigger.bytes": delivery.size },
      }),
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
        const ready = yield* manual(input);

        if (ready.status !== "ready") return ready;

        store().enqueue(ready.key, { type: "manual" }, ready.at);
        yield* Effect.promise(() => storage.setAlarm(ready.at));

        return { status: "queued", key: ready.key } as const;
      }).pipe(serially),

    fireAgain: (input) =>
      Effect.gen(function* () {
        const ready = yield* manual(input);

        if (ready.status !== "ready") return ready;

        const last = store().last();

        if (last === undefined) return { status: "none" } as const;

        store().enqueue(ready.key, { type: "manual" }, ready.at, last);
        yield* Effect.promise(() => storage.setAlarm(ready.at));

        return { status: "queued", key: ready.key } as const;
      }).pipe(serially),

    deliver,

    deliveries: () =>
      Effect.gen(function* () {
        const at = yield* now;
        const kept = existing();

        if (kept === undefined) return { counts: [], lastDeliveryAt: null, pingAt: null };

        const hook = kept.hook();

        return {
          counts: kept.counts(at),
          lastDeliveryAt: hook.lastDeliveryAt ?? null,
          pingAt: hook.pingAt ?? null,
        };
      }),

    reveal: () => revealed().pipe(serially),

    rotate: (what) =>
      Effect.gen(function* () {
        if (existing()?.secrets() === undefined) return null;

        yield* renew({ token: what === "url", secret: what === "secret" });

        return yield* revealed();
      }).pipe(serially),

    fireLog: (input) => Effect.sync(() => existing()?.fires(input?.limit) ?? []),

    state: () => Effect.sync(state),

    alarm,
  };
};
