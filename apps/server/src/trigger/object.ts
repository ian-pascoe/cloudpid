// What a `Trigger` object does (`docs/architecture/triggers.md` → The Trigger object and the Registry, ADR-0047): _how_
// a Trigger is reached and _when_ it fires. A Schedule coming due becomes a pending Fire, which the alarm drains through
// the Registry's `admitFire` and then the Session's `fire` (a Session trigger's admission answers `send`, and its Fire
// goes to the Session's `fireSession`), both keyed by the Fire's key, so a retried alarm never starts a second Session.
// At each touch the object reads its definition again (`triggerDefinition`) and retires (removed: its admitted Fires get
// a last try, a repeat of their `admitFire`, which a Session's deletion answers `removed`, so the object wipes itself
// then), drops its Fires not yet admitted and arms only for the admitted ones (paused), or re-arms (a changed Schedule):
// a lost message from a caller heals at its next touch. The alarm catches its own errors and re-arms, since the
// platform gives up after 6 retries. The ports keep the object testable: the real ones are RPC to the Registry and the
// Sessions (`Trigger.ts`). A webhook Trigger's object also holds its token and Signing secret (sealed, made at its
// first adopt), checks each delivery to its URL (`deliver`: token, signature, size, content type, then `match` and the
// bot-loop guard), counts what it refuses or filters per day without calling the Registry, and keeps an accepted
// delivery as a pending Fire (`docs/architecture/triggers.md` → Webhooks).
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
  type FireResult,
  type FireSource,
  type GitHubHookSource,
  githubHookOf,
  type GitHubHookStatus,
  matchesDelivery,
  matchFacts,
  MAX_DELIVERY_BODY_BYTES,
  MAX_KEPT_BODY_BYTES,
  nextFires,
  scheduledFireKey,
  scheduleOf,
  senderText,
  sessionWhenBusyOf,
  type SessionFireRequest,
  type SubmitResult,
  TriggerDefinition,
  type TriggerRotation,
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
  botGuard,
  contentKind,
  eventOf,
  keyedDelivery,
  senderLogin,
} from "./delivery.ts";
import { GitHubHookFailed, hookTriggers, orphanHooks, type RepoHooks } from "./github-hook.ts";
import {
  checkGitHubSignature,
  checkStandardSignature,
  sameBytes,
  standardSecretText,
} from "./signature.ts";
import {
  type DayCount,
  hasTriggerStore,
  type HookDelete,
  type KeptDelivery,
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
  /** A Session trigger's Fire into its own Session (`fireSession`). */
  readonly fireSession: (
    session: string,
    request: SessionFireRequest,
  ) => Effect.Effect<ApiResult<FireResult>, TriggerUnreachable>;
  /** What runs after a Fire's Session started in `environment`: the spare and Build upkeep. Never fails. */
  readonly afterStart: (environment: string) => Effect.Effect<void>;
  /** The vault the object's token and Signing secret are sealed with, bound to the object's own id. */
  readonly vault: Effect.Effect<KeptVault, TriggerUnreachable>;
  /**
   * The login of the GitHub App's own bot account, in lower case (the bot-loop guard drops its deliveries), or undefined
   * while GitHub cannot say. Never fails.
   */
  readonly botLogin: Effect.Effect<string | undefined>;
  /**
   * What a GitHub-managed hook needs (`triggers.md` → GitHub-managed hooks): the repos' hooks as the App, the stage's
   * origin its Trigger URLs start with (undefined where it has none, as under `alchemy dev`: no hook can reach it), and
   * the Registry's `knownTriggers`, which the orphan sweep asks.
   */
  readonly github: {
    readonly hooks: RepoHooks;
    readonly origin: string | undefined;
    readonly known: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, TriggerUnreachable>;
  };
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
  /** Where its GitHub-managed hook is, for a Trigger that has one; null for none. An older object omits it. */
  readonly github?: GitHubHookStatus | null;
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

/**
 * What `reveal` and `rotate` answer: the secrets, `none` for an object that holds no webhook Trigger, or `unreadable`
 * for one whose kept secrets no longer read (never replaced but by the owner's rotation).
 */
export type HookAnswer =
  | {
      readonly status: "ok";
      readonly secrets: HookSecrets;
      /** Where its GitHub-managed hook is after the call (a rotation updates it), for a Trigger that has one. */
      readonly github?: GitHubHookStatus | undefined;
    }
  | { readonly status: "none" }
  | { readonly status: "unreadable" };

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
  /**
   * The Trigger's token and Signing secret. A webhook Trigger whose object holds none yet (its creation did not finish)
   * makes them now.
   */
  readonly reveal: () => Effect.Effect<HookAnswer, TriggerUnreachable>;
  /**
   * Make a new token (`url`) or Signing secret (`secret`) at once: the old one stops working at that moment. Answers the
   * secrets as `reveal` does. Secrets that no longer read are replaced, both of them, whichever is asked.
   */
  readonly rotate: (what: TriggerRotation) => Effect.Effect<HookAnswer, TriggerUnreachable>;
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

/** How long a hook's delete at GitHub is tried before it is given up, with a warning. */
export const HOOK_DELETE_MS = 24 * 60 * 60_000;

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

/** A delivery's body as the checks read it: its bytes as UTF-8 text, parsed as its content type says (none when it doesn't parse). */
const readBody = (contentType: string | undefined, bytes: Uint8Array): Schema.Json | undefined =>
  bodyOf(contentKind(contentType) ?? "text", decoder.decode(bytes));

const encoder = new TextEncoder();

const decoder = new TextDecoder();

/** Decodes a kept body as it is sent and shown: UTF-8, a byte order mark kept (the file holds the body as received). */
const bodyDecoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** 256 random bits as 43 base64url characters: a Trigger URL's token, and a Signing secret. */
const randomSecret = (): string =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

/** Whether `a` and `b` are the same sealed token and Signing secret. */
const sameSecrets = (a: KeptSecrets | "unreadable" | undefined, b: KeptSecrets): boolean =>
  a !== undefined &&
  a !== "unreadable" &&
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
  github: null,
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
    const at = yield* now;
    const kept = existing();
    const hook = kept?.githubHook();

    // Its GitHub-managed hook goes first; a delete that fails is kept past the wipe, for the alarm to try again.
    if (kept !== undefined && hook?.hookId !== undefined) {
      kept.deleteLater({
        repo: hook.repo,
        hookId: hook.hookId,
        since: at,
        attempts: 0,
        nextTryAt: at,
      });
    }

    if (kept !== undefined) yield* deleteHooks(at);

    const left = kept?.hookDeletes() ?? [];

    for (const pending of kept?.pending() ?? []) {
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

    if (left.length === 0) return;

    for (const hookDelete of left) store().deleteLater(hookDelete);

    yield* Effect.promise(() => storage.setAlarm(Math.min(...Arr.map(left, (d) => d.nextTryAt))));
  });

  /**
   * The time the next Fire is due: the Schedule's next after the cursor, or a pending Fire's next try. A paused Trigger
   * has only its admitted Fires to complete.
   */
  const nextAt = (): number | undefined => {
    const definition = store().definition();
    const deletes = Arr.map(store().hookDeletes(), (hookDelete) => hookDelete.nextTryAt);

    if (definition === undefined) return deletes.length === 0 ? undefined : Math.min(...deletes);

    const pending = Arr.filter(
      store().pending(),
      (fire) => !definition.paused || fire.session !== undefined,
    );

    const times = [...Arr.map(pending, (fire) => fire.nextTryAt), ...deletes];
    const retry = store().githubHook()?.nextTryAt;
    const schedule = scheduleOf(definition);

    if (retry !== undefined) times.push(retry);
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
        const held = store().secrets();
        // Rotation is the one way to replace secrets that no longer read: it makes both.
        const kept = held === "unreadable" ? undefined : held;
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

  /** An object never synced (or wiped) reads its definition first, as a manual Fire does, so it can answer as the Trigger's. */
  const known = Effect.gen(function* () {
    if (existing() !== undefined) return;

    const definition = yield* ports.definition(id);

    if (definition !== null) yield* adopt(definition, yield* now);
  });

  /** What a GitHub-managed hook is set with now: the stage's origin, the token's keyed hash and the sealed secret. */
  const fingerprint = (secrets: KeptSecrets): string =>
    JSON.stringify([ports.github.origin ?? "", secrets.tokenHash, secrets.secret.ciphertext]);

  /** Where the GitHub-managed hook of `definition` is, or null for a Trigger that has none. */
  const hookStatus = (definition: TriggerDefinition | undefined): GitHubHookStatus | null => {
    const wanted = githubHookOf(definition);

    if (wanted === undefined) return null;

    const kept = existing()?.githubHook();

    if (kept === undefined || kept.repo !== wanted.repo)
      return { repo: wanted.repo, state: "pending" };

    if (kept.problem !== undefined) {
      return { repo: wanted.repo, state: "failed", problem: kept.problem };
    }

    const secrets = existing()?.secrets();

    const current =
      kept.hookId !== undefined &&
      secrets !== undefined &&
      secrets !== "unreadable" &&
      kept.synced === fingerprint(secrets);

    return { repo: wanted.repo, state: current ? "ready" : "pending" };
  };

  /** The span attributes of a hook call's failure: its code, and GitHub's status when it answered. */
  const failedHook = (error: GitHubHookFailed) =>
    Effect.annotateCurrentSpan(
      error.status === undefined
        ? { "trigger.outcome": error.code }
        : { "trigger.outcome": error.code, "http.status": error.status },
    );

  /**
   * Try each hook due to be deleted at GitHub by `at` once more: one deleted (or gone already) is forgotten, one that
   * fails waits for a later try, with backoff, until `HOOK_DELETE_MS` after its first, then is given up with a warning.
   */
  const deleteHooks = (at: number) =>
    Effect.gen(function* () {
      for (const hookDelete of store().hookDeletes()) {
        if (hookDelete.nextTryAt > at) continue;

        const deleted = yield* Effect.result(
          ports.github.hooks.delete(hookDelete.repo, hookDelete.hookId),
        );

        if (Result.isSuccess(deleted)) {
          store().hookDeleted(hookDelete.repo, hookDelete.hookId);

          continue;
        }

        const annotated = Effect.annotateLogs({
          "trigger.id": id,
          "github.repo": hookDelete.repo,
          "github.hook": hookDelete.hookId,
        });

        if (at - hookDelete.since >= HOOK_DELETE_MS) {
          store().hookDeleted(hookDelete.repo, hookDelete.hookId);
          yield* Effect.logWarning(
            "A Trigger gave up deleting its GitHub hook after a day: delete it in the repo's settings",
            deleted.failure.message,
          ).pipe(annotated);

          continue;
        }

        const next: HookDelete = {
          ...hookDelete,
          attempts: hookDelete.attempts + 1,
          nextTryAt: at + backoff(hookDelete.attempts),
        };

        store().deleteLater(next);
        yield* Effect.logInfo(
          "A Trigger's GitHub hook could not be deleted yet",
          deleted.failure.message,
        ).pipe(annotated);
      }
    });

  /**
   * The orphan sweep before a hook is made on `repo`: its hooks that send to this stage's `/hooks/<id>/` for a Trigger
   * the Registry doesn't know (`knownTriggers`), or for this one (a hook it made and lost), are deleted. Without the
   * Registry's answer no other Trigger's hook is deleted.
   */
  const sweep = (repo: string, origin: string): Effect.Effect<void, GitHubHookFailed> =>
    Effect.gen(function* () {
      const listed = yield* ports.github.hooks.list(repo);
      const others = Arr.filter(hookTriggers(listed, origin), (trigger) => trigger !== id);

      const known = yield* ports.github
        .known(others)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              "The orphan sweep could not ask the Registry which Triggers it knows",
              error.message,
            ).pipe(Effect.as(others)),
          ),
        );

      let deleted = 0;

      for (const orphan of orphanHooks(listed, { origin, own: id, known: new Set(known) })) {
        const gone = yield* Effect.result(ports.github.hooks.delete(repo, orphan.id));

        if (Result.isSuccess(gone)) deleted++;
        else
          yield* Effect.logInfo("An orphan GitHub hook could not be deleted", gone.failure.message);
      }

      yield* Effect.annotateCurrentSpan({
        "trigger.outcome": "ok",
        "trigger.hooks_deleted": deleted,
      });
    }).pipe(
      Effect.tapError(failedHook),
      Effect.withSpan("trigger.github_hook", {
        attributes: { "trigger.id": id, "trigger.github_hook.op": "sweep" },
      }),
    );

  /**
   * Point the hook at `wanted`'s repo at the Trigger URL and Signing secret `secrets` hold: update hook `hookId`, or,
   * for none (or one GitHub no longer has), sweep the repo's orphans and make one. Answers the hook's id.
   */
  const placeHook = (
    wanted: GitHubHookSource,
    hookId: number | undefined,
    secrets: KeptSecrets,
  ): Effect.Effect<number, GitHubHookFailed | TriggerUnreachable> =>
    Effect.gen(function* () {
      const { origin } = ports.github;

      if (origin === undefined) {
        return yield* GitHubHookFailed.make({
          code: "no_origin",
          message:
            "This stage has no public origin (it runs under alchemy dev), so GitHub can't reach its Trigger URLs: no hook is made",
        });
      }

      const vault = yield* vaulted(ports.vault);
      const token = yield* vaulted(vault.open(tokenBinding, secrets.token));
      const secret = yield* vaulted(vault.open(secretBinding, secrets.secret));
      const config = { url: `${origin}/hooks/${id}/${token}`, secret, events: wanted.events };

      if (hookId !== undefined) {
        const updated = yield* ports.github.hooks.update(wanted.repo, hookId, config);

        if (updated === "updated") return hookId;
      }

      yield* sweep(wanted.repo, origin);

      return yield* ports.github.hooks.create(wanted.repo, config);
    });

  /**
   * Bring the GitHub-managed hook in line with `definition` at `at`: made once the Trigger has its secrets, updated
   * when its URL or Signing secret was replaced, and one of another repo (or of none) deleted. A failure is kept, with
   * the next try after a backoff that doubles to an hour; `force` tries at once (a sync after a change, a rotation).
   */
  const reconcile = (definition: TriggerDefinition, at: number, force: boolean) =>
    Effect.gen(function* () {
      const wanted = githubHookOf(definition);
      let kept = store().githubHook();

      // A hook of another repo goes: a Trigger's source is fixed, so only a definition read wrong ever moves it.
      if (kept !== undefined && kept.repo !== wanted?.repo) {
        if (kept.hookId !== undefined) {
          store().deleteLater({
            repo: kept.repo,
            hookId: kept.hookId,
            since: at,
            attempts: 0,
            nextTryAt: at,
          });
        }

        store().dropGitHubHook();
        kept = undefined;
      }

      const secrets = store().secrets();

      if (wanted === undefined || secrets === undefined || secrets === "unreadable") return;

      const synced = fingerprint(secrets);

      if (kept?.hookId !== undefined && kept.synced === synced && kept.problem === undefined)
        return;

      if (!force && kept?.nextTryAt !== undefined && kept.nextTryAt > at) return;

      const placed = yield* Effect.result(placeHook(wanted, kept?.hookId, secrets));

      if (Result.isSuccess(placed)) {
        store().keepGitHubHook({
          repo: wanted.repo,
          hookId: placed.success,
          synced,
          problem: undefined,
          attempts: 0,
          nextTryAt: undefined,
        });

        return;
      }

      const { failure } = placed;
      const attempts = kept?.attempts ?? 0;

      store().keepGitHubHook({
        repo: wanted.repo,
        hookId: kept?.hookId,
        synced: kept?.synced,
        problem: {
          code: Schema.is(GitHubHookFailed)(failure) ? failure.code : "unreachable",
          message: failure.message,
        },
        attempts: attempts + 1,
        nextTryAt: at + backoff(attempts),
      });
      yield* Effect.logWarning(
        "A Trigger's GitHub hook could not be made or updated",
        failure.message,
      ).pipe(Effect.annotateLogs({ "trigger.id": id, "github.repo": wanted.repo }));
    });

  /**
   * The token and Signing secret as the owner reads them. A webhook Trigger that holds none (its creation did not
   * finish) makes them first; one whose kept secrets no longer read answers `unreadable`, and keeps them.
   */
  const revealed = (): Effect.Effect<HookAnswer, TriggerUnreachable> =>
    Effect.gen(function* () {
      yield* known;

      const webhook = webhookOf(existing()?.definition());

      if (webhook === undefined) return { status: "none" } as const;

      if (store().secrets() === undefined) yield* renew({ token: true, secret: true });

      const kept = store().secrets();

      if (kept === undefined || kept === "unreadable") return { status: "unreadable" } as const;

      const vault = yield* ports.vault;
      const token = yield* vault.open(tokenBinding, kept.token);
      const secret = yield* vault.open(secretBinding, kept.secret);

      return {
        status: "ok",
        secrets: {
          token,
          secret: webhook.format === "standard" ? standardSecretText(secret) : secret,
        },
        github: hookStatus(existing()?.definition()) ?? undefined,
      } as const;
    }).pipe(vaulted);

  /**
   * Act on `definition`, as read from the Registry at `at`: none retires the object (`retire`); a paused one is kept,
   * its pending Fires not yet admitted recorded `skipped: paused` and dropped, and its alarm armed only for the admitted
   * ones (it never catches up on resume); an active one is kept with its cursor, which a new or changed Schedule (or a
   * resume) starts at `at`, and the alarm is armed for its next Fire. Answers whether the object still holds a Trigger.
   */
  const adopt = (
    definition: TriggerDefinition | null,
    at: number,
    force = false,
  ): Effect.Effect<boolean> =>
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
      yield* reconcile(definition, at, force);
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
      github: hookStatus(kept.definition()),
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

  /** What the delivery gave a Fire, as the Session's `fire` takes it: its payload with the body decoded, when one was kept. */
  const payloadOf = (delivery: KeptDelivery): FirePayload =>
    delivery.body === undefined
      ? delivery.payload
      : { ...delivery.payload, body: bodyDecoder.decode(delivery.body) };

  /**
   * Whether a kept delivery passes the `match` of `definition`: its body as it was kept, or, for one that was not, the
   * facts its earlier `match` read of it (a path it did not keep never matches).
   */
  const passes = (definition: TriggerDefinition, delivery: KeptDelivery): boolean => {
    const webhook = webhookOf(definition);

    if (webhook === undefined) return true;

    const body =
      delivery.body === undefined
        ? delivery.facts
        : readBody(delivery.payload.contentType, delivery.body);

    return matchesDelivery(webhook.match, { event: delivery.payload.event, body });
  };

  /**
   * A pending delivery that no longer passes the `match` of the definition it was admitted against (changed since it was
   * accepted): counted `filtered` for the day and dropped, as if it had been filtered when it arrived. One that waits for
   * its Workspace with later Fires merged into it is recorded `failed` instead, with its merged count (as `settle` does
   * for a waiting Fire lost for good), so those Fires are not lost without a record.
   */
  const unmatched = (pending: PendingFire, at: number) =>
    Effect.gen(function* () {
      store().count("filtered", at);

      if ((pending.waiting?.merged ?? 0) > 0) {
        yield* settle(
          pending,
          { type: "failed", reason: "it no longer matches the trigger's filter" },
          at,
        );
      } else {
        store().drop(pending.key);
        yield* Effect.annotateCurrentSpan("trigger.outcome", "filtered");
      }
    }).pipe(
      Effect.andThen(
        Effect.logInfo("A pending delivery no longer matches its Trigger").pipe(
          Effect.annotateLogs({ "trigger.id": id, "trigger.fire": pending.key }),
        ),
      ),
    );

  /** The header of `pending`'s Fire of `definition` at `at`. */
  const headerOf = (
    definition: TriggerDefinition,
    pending: PendingFire,
    at: number,
  ): FireRequest["header"] => {
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
    if (pending.source.type === "manual" && pending.delivery !== undefined) header.again = true;

    return header;
  };

  /** The Session's `fire` for `pending` of `definition` at `at`. */
  const requestOf = (
    definition: TriggerDefinition,
    pending: PendingFire,
    at: number,
  ): FireRequest => {
    const request: Types.Mutable<FireRequest> = {
      trigger: { id: definition.id, name: definition.name },
      requestId: pending.key,
      message: definition.message,
      header: headerOf(definition, pending, at),
    };

    if (pending.delivery !== undefined) request.payload = payloadOf(pending.delivery);

    if (definition.model !== undefined) request.model = definition.model;

    if (definition.thinking !== undefined) request.thinking = definition.thinking;

    return request;
  };

  /** The Session's `fireSession` for `pending` of Session trigger `definition` at `at`. */
  const sessionRequestOf = (
    definition: TriggerDefinition,
    pending: PendingFire,
    at: number,
  ): SessionFireRequest => ({
    trigger: { id: definition.id, name: definition.name },
    requestId: pending.key,
    message: definition.message,
    header: headerOf(definition, pending, at),
    whenBusy: sessionWhenBusyOf(definition.whenBusy),
  });

  /** What a Fire that started a new Session settles as, from the Session's answer `sent`. */
  const startedOutcome = (session: string, sent: ApiResult<SubmitResult>): FireOutcome =>
    sent.ok ? { type: "started", session } : { type: "failed", reason: sent.error.message };

  /** What a Session trigger's Fire settles as, from the Session's answer `sent`. */
  const sentOutcome = (sent: ApiResult<FireResult>): FireOutcome => {
    if (sent.ok) {
      return "skipped" in sent.value
        ? { type: "skipped", reason: sent.value.skipped }
        : { type: "sent", delivery: sent.value.delivery };
    }

    const { code, message } = sent.error;

    // Its Session is archived or importing: nothing needs resuming afterwards.
    if (code === "session_archived") return { type: "skipped", reason: "archived" };

    if (code === "session_importing") return { type: "skipped", reason: "importing" };

    return { type: "failed", reason: message };
  };

  /**
   * Send an admitted Fire (`send`, a call to its Session) and settle it as `outcomeOf` says of the Session's answer: a
   * Fire that can't reach the Session, or is told to try again, waits for a later try.
   */
  const sendFire = <A>(
    pending: PendingFire,
    at: number,
    send: Effect.Effect<ApiResult<A>, TriggerUnreachable>,
    outcomeOf: (sent: ApiResult<A>) => FireOutcome,
  ) =>
    Effect.gen(function* () {
      const sent = yield* Effect.result(send);

      if (Result.isFailure(sent)) return yield* later(pending, at, sent.failure.message);

      if (!sent.success.ok && sent.success.error.retryable) {
        return yield* later(pending, at, sent.success.error.message);
      }

      yield* settle(pending, outcomeOf(sent.success), at);
    });

  /**
   * Drain one pending Fire at `at`: let it through (`admitFire`, adopting a `stale` answer's definition and asking again),
   * then send it to its Session (`fire`). A Fire that can't reach either waits for a later try. One already admitted
   * goes on while its Trigger is paused (the Registry answers it its Session again). Answers whether the object still
   * holds a Trigger.
   */
  const drain = (pending: PendingFire, at: number, retryCount: number): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      // The revision whose `match` a delivery passed: it is admitted at that, never at a later one it was not checked against.
      let matched = pending.delivery?.revision;

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
          revision: matched ?? definition.revision,
          requestId: pending.key,
          sessionTriggers: true,
        };

        if (pending.source.type === "schedule") admission.scheduledAt = pending.source.scheduledAt;

        if (pending.delivery?.payload.event !== undefined) {
          admission.event = pending.delivery.payload.event;
        }

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

            // The delivery was checked against the older `match`: the one now current decides.
            if (matched !== undefined && pending.delivery !== undefined) {
              const next = store().definition();

              if (next !== undefined && !passes(next, pending.delivery)) {
                yield* unmatched(pending, at);

                return true;
              }

              matched = next?.revision ?? current.value.revision;
              store().matched(pending.key, matched);
            }

            continue;
          }

          case "removed":
            // The Fires already admitted get their last try, unless this is one of them, retiring already. That try is
            // a repeat of `admitFire`, which a Session's deletion answers `removed` (its `trigger_sends` went with its
            // Triggers): the object then only wipes.
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

            yield* sendFire(
              pending,
              at,
              ports.fire(answer.session, requestOf(definition, pending, at)),
              (sent) => startedOutcome(answer.session, sent),
            );

            return true;
          }

          case "send": {
            // A Session trigger's own Session: nothing was made, so there is no upkeep.
            store().admitted(pending.key, answer.session);

            yield* sendFire(
              pending,
              at,
              ports.fireSession(answer.session, sessionRequestOf(definition, pending, at)),
              sentOutcome,
            );

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

      // The hooks still to delete at GitHub, a removed Trigger's among them, whatever its definition says now.
      if (existing() !== undefined) yield* deleteHooks(at);

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
      if (existing()?.holds(key, at) === true) return { status: "queued", key } as const;

      const definition = yield* ports.definition(id);

      if (!(yield* adopt(definition, at)) || definition === null) {
        return { status: "removed" } as const;
      }

      if (definition.paused) return { status: "paused" } as const;

      return { status: "ready", key, at } as const;
    });

  /** Keep a manual Fire that is `ready` (with the delivery Fire again sends) and wake the alarm for it. */
  const enqueueManual = (
    ready: { readonly key: string; readonly at: number },
    delivery?: KeptDelivery,
  ) =>
    Effect.gen(function* () {
      store().enqueue(ready.key, { type: "manual" }, ready.at, delivery);
      yield* Effect.promise(() => storage.setAlarm(ready.at));

      return { status: "queued", key: ready.key } as const;
    });

  /** What `examine` found of a delivery, to be kept by `deliver`. */
  type Verdict =
    | {
        readonly type: "refused";
        readonly status: 401 | 404 | 413 | 415;
        readonly outcome: DeliveryOutcome;
      }
    | {
        readonly type: "filtered";
        readonly outcome: "filtered" | "bot_unverified";
        readonly event: string | undefined;
      }
    | { readonly type: "ping" }
    | { readonly type: "unavailable" }
    | {
        readonly type: "accepted";
        readonly key: string;
        readonly source: FireSource;
        readonly delivery: KeptDelivery;
      };

  const refused = (status: 401 | 404 | 413 | 415, outcome: DeliveryOutcome): Verdict => ({
    type: "refused",
    status,
    outcome,
  });

  /**
   * Check `delivery` against what the object keeps, in order: the token (by its keyed hash, in constant time), the size,
   * the signature, GitHub's ping, the content type, the bot-loop guard and `match` (of the definition at `revision`,
   * which the accepted delivery keeps). Reads and writes nothing of the object's.
   */
  const examine = (
    webhook: NonNullable<ReturnType<typeof webhookOf>>,
    revision: number,
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

        const parsed = readBody(headers.contentType, body);
        const event = eventOf(webhook.format, headers, parsed);
        const login = senderLogin(parsed);

        // A bot's login ends `[bot]`: only then is GitHub asked for the App's own.
        const guard =
          webhook.format === "github" && login?.toLowerCase().endsWith("[bot]") === true
            ? botGuard(login, yield* ports.botLogin)
            : "pass";

        if (guard === "own") return { type: "filtered", outcome: "filtered", event } as const;

        if (guard === "unverified") {
          yield* Effect.logWarning("A bot's delivery was dropped: the App's own bot is not known");

          return { type: "filtered", outcome: "bot_unverified", event } as const;
        }

        if (!matchesDelivery(webhook.match, { event, body: parsed })) {
          return { type: "filtered", outcome: "filtered", event } as const;
        }

        const sent =
          webhook.format === "github"
            ? (headers.delivery ?? newManualId())
            : (headers.webhookId ?? newManualId());

        const delivered = keyedDelivery(sent);
        const action = actionOf(parsed);

        // The body is kept as the bytes received; a larger one is not, and keeps what its `match` read of it instead.
        const bodyKept = delivery.size <= MAX_KEPT_BODY_BYTES;

        const payload: Types.Mutable<FirePayload> = {
          format: webhook.format,
          delivery: delivered,
          size: delivery.size,
        };

        if (event !== undefined) payload.event = event;

        if (action !== undefined) payload.action = action;

        if (headers.contentType !== undefined) payload.contentType = headers.contentType;

        const kept: Types.Mutable<KeptDelivery> = { payload, revision };

        if (bodyKept) kept.body = body;
        else kept.facts = matchFacts(webhook.match ?? {}, parsed);

        const source: Types.Mutable<Extract<FireSource, { type: "webhook" }>> = {
          type: "webhook",
          delivery: delivered,
        };

        if (event !== undefined) source.event = event;

        return { type: "accepted", key: `${id}:${delivered}`, source, delivery: kept } as const;
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

      // Secrets that no longer read: the URL answers as a wrong token does (and is counted), and is said in the logs.
      if (secrets === "unreadable") {
        kept.count("not_found", at);
        yield* Effect.logError(
          "A webhook Trigger's secrets no longer read; its owner must make new ones",
        );
        yield* spanned(NOT_FOUND, undefined);

        return NOT_FOUND;
      }

      yield* Effect.annotateCurrentSpan("trigger.format", webhook.format);

      const revision = kept.definition()?.revision ?? 0;

      const verdict = yield* Effect.result(examine(webhook, revision, secrets, delivery, at)).pipe(
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
            current.count(verdict.outcome, at);

            return { status: 200, outcome: verdict.outcome };
          case "accepted": {
            current.delivered(at, false);

            // A repeat of a delivery (the sender's retry) is answered as the first was, and makes no second Fire.
            if (current.holds(verdict.key, at)) return { status: 200, outcome: "accepted" };

            current.keepLast(verdict.delivery.payload, verdict.delivery.body);

            if (definition.paused) {
              current.record({
                key: verdict.key,
                at,
                source: verdict.source,
                outcome: { type: "skipped", reason: "paused" },
              });
            } else {
              current.enqueue(verdict.key, verdict.source, at, verdict.delivery);
            }

            return { status: 200, outcome: "accepted" };
          }
        }
      })();

      if (verdict.type === "accepted" && !definition.paused && answer.status === 200) {
        // Answered once the Fire is stored; the alarm admits it and starts its Session.
        yield* Effect.promise(() => storage.setAlarm(at));
      }

      yield* spanned(
        answer,
        verdict.type === "accepted" ? verdict.delivery.payload.event : undefined,
      );

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

        // A sync follows a change: a GitHub hook that failed is tried again at once.
        yield* adopt(definition, yield* now, true);

        return definition === null ? NO_STATE : state();
      }).pipe(serially),

    remove: () => serially(Effect.flatMap(now, retire)),

    fireNow: (input) =>
      Effect.gen(function* () {
        const ready = yield* manual(input);

        return ready.status === "ready" ? yield* enqueueManual(ready) : ready;
      }).pipe(serially),

    fireAgain: (input) =>
      Effect.gen(function* () {
        const ready = yield* manual(input);

        if (ready.status !== "ready") return ready;

        const last = store().last();

        // The last delivery as it was kept, with no revision or facts: no `match` is checked of it again.
        return last === undefined
          ? ({ status: "none" } as const)
          : yield* enqueueManual(ready, { payload: last.payload, body: last.body });
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
        yield* known;

        if (webhookOf(existing()?.definition()) === undefined) return { status: "none" } as const;

        yield* renew({ token: what === "url", secret: what === "secret" });

        // Its GitHub-managed hook takes the new URL or Signing secret in the same call.
        const definition = existing()?.definition();

        if (definition !== undefined) yield* reconcile(definition, yield* now, true);

        yield* arm;

        return yield* revealed();
      }).pipe(serially),

    fireLog: (input) => Effect.sync(() => existing()?.fires(input?.limit) ?? []),

    state: () => Effect.sync(state),

    alarm,
  };
};
