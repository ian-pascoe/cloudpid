// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off preferSchemaOverJson:off
// The Session's Secrets (`docs/spec.md` → Secrets): values the owner enters in a masked form on the client, kept
// encrypted in the Session DO's storage for their lifetime, and the redaction of every value held in this instance.
//
// An ask is durable: it is stored until the owner answers or its call is cancelled, and the answer is stored with the
// Secrets it provided, so a call that an eviction cut off finds the answer when it reruns, and an owner who answers
// while no call waits still has the answer kept.
//
// The Secrets kept for the Session's Environment (or for every Environment) are held beside them, in memory only: they
// are asked for (`SecretsOptions.kept`) when first needed and again once `KEPT_REFRESH_MS` has passed, so a change on
// the Environments page applies soon. An asked Secret of the same name wins, and a kept one cannot be forgotten here.
//
// The owner may also choose, in the form, to keep what they enter for the Session's Environment or for every
// Environment (`SecretsOptions.keep`, which saves through the Registry as the Environments page's form does). A Secret
// so kept is not entered for 15 minutes: it is a kept one, which the next ask of the Registry brings back, and it is
// redacted from the moment it is answered. The answer stored for a rerun holds the scope, never a value.
import { SecretKeep } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { KEPT_REFRESH_MS, KEPT_RETRY_MS, type KeptScope, type KeptSecret } from "./kept.ts";
import { type RedactionStream, Redactions } from "./redaction.ts";
import { secretEnvName } from "./references.ts";
import type { SealedSecret, SecretVault, SecretVaultError } from "./vault.ts";

/** How long a Secret is held, counted from when the owner enters it. */
export const SECRET_LIFETIME_MS = 15 * 60_000;

/** The Durable Object's synchronous key-value storage, as the store uses it. */
export type SecretStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** A request for the owner to enter Secrets, waiting for an answer from a client. */
export const SecretAsk = Schema.Struct({
  /** Unique within the Session: the asking call's task. */
  id: Schema.String,
  /** The conversation whose call asks. */
  conversationId: Schema.Finite,
  names: Schema.Array(Schema.String),
  /** Why the agent needs them, shown to the owner. */
  reason: Schema.optionalKey(Schema.String),
  /** Where the agent suggests keeping them: the form starts with that choice, and the owner's choice is final. */
  keep: Schema.optionalKey(SecretKeep),
});

export type SecretAsk = typeof SecretAsk.Type;

/** What became of one name an ask requested. */
export type AskOutcome =
  | {
      readonly name: string;
      readonly status: "provided";
      readonly expiresAt: number;
      /** Why the Secret was held for the Session only although the owner chose to keep it. */
      readonly notKept?: string;
    }
  /** Kept as the owner chose: it does not expire. */
  | {
      readonly name: string;
      readonly status: "kept";
      readonly scope: KeptScope;
      /** Set when the Environment keeps its own Secret of the name, which wins over one kept for every Environment. */
      readonly shadowed?: true;
    }
  | { readonly name: string; readonly status: "skipped" | "cancelled" };

/** The Secrets the owner chose to keep in an answer: what the Session hands to the Registry to keep. */
export type KeepRequest = {
  readonly ask: SecretAsk;
  readonly scope: KeptScope;
  /** Only the names the owner gave a value for. */
  readonly secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>;
};

/** How keeping one Secret went: kept, or why not (a message that never holds the value). */
export type KeepResult =
  | { readonly name: string; readonly kept: true; readonly shadowed?: boolean }
  | { readonly name: string; readonly kept: false; readonly problem: string };

/** A Secret this Session holds, without its value: one the owner entered, until it expires, or one kept for it. */
export type HeldSecret =
  | { readonly name: string; readonly expiresAt: number; readonly kept?: undefined }
  | { readonly name: string; readonly kept: KeptScope; readonly expiresAt?: undefined };

/** What `forget` did with a name: whether an entered Secret was forgotten, and where a kept one of that name is kept. */
export type ForgetOutcome = {
  readonly name: string;
  readonly forgotten: boolean;
  /** Set when a kept Secret has the name: it stays held, as only the Environments page removes it. */
  readonly kept?: KeptScope;
};

/** An ask could not be answered or completed. */
export class SecretsError extends Schema.TaggedError<
  SecretsError,
  { readonly brand: unique symbol }
>()("SecretsError", { message: Schema.String }) {}

export type SecretsService = {
  /** The Secrets held now, by name: an entered one over a kept one of the same name. */
  readonly held: Effect.Effect<ReadonlyArray<HeldSecret>>;
  /** The value held under `name`: entered (unless its lifetime has passed) or else kept. */
  readonly resolve: (name: string) => Effect.Effect<string | undefined>;
  /** Every held Secret as the environment variable commands get it under. */
  readonly environment: Effect.Effect<Readonly<Record<string, string>>>;
  /** Forget the entered Secrets `names` now; says of each whether it was held, and whether a kept one has the name. */
  readonly forget: (names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ForgetOutcome>>;
  /**
   * Ask for the kept Secrets if they are due, so `redact` and `stream` cover them: run before a tool whose output they
   * redact. `held`, `resolve`, `environment`, `forget` and `scrub` do it themselves.
   */
  readonly refresh: Effect.Effect<void>;
  /** Delete the ciphertext of every Secret whose lifetime has passed. */
  readonly sweep: Effect.Effect<void>;
  /** When the next held Secret expires, if any is held. */
  readonly nextExpiry: Effect.Effect<number | undefined>;
  /**
   * Ask the owner for `ask.names` and wait for the answer. Asking again with the same `id` waits for the same ask, or
   * returns its answer when it came while no call waited. Cancelling the wait withdraws the ask.
   */
  readonly ask: (ask: SecretAsk) => Effect.Effect<ReadonlyArray<AskOutcome>, SecretsError>;
  /** The asks waiting for the owner, oldest first. */
  readonly pending: Effect.Effect<ReadonlyArray<SecretAsk>>;
  /**
   * Withdraw every ask no call in this instance waits for, and drop the answers no call took. Run only while no work is
   * live: then no call can still come back for them (one an eviction cut off has rerun by then), so they were
   * abandoned, such as a call aborted while the object was evicted.
   */
  readonly dropAbandoned: Effect.Effect<void>;
  /**
   * The owner's answer to ask `id`: a value per name (an empty or missing one skips the name), or `null` when the owner
   * cancelled. Fails when no such ask waits, or the answer names a Secret the ask did not request.
   */
  readonly answer: (
    id: string,
    values: Readonly<Record<string, string>> | null,
    keep?: SecretKeep,
  ) => Effect.Effect<void, SecretsError>;
  /** `value` with every value held in this instance replaced by its Secret Reference. */
  readonly redact: <A>(value: A) => A;
  /** Whether `redact` can change anything: whether this instance held any value. */
  readonly redacting: () => boolean;
  /** A stream of output redacted as it arrives. */
  readonly stream: () => RedactionStream;
  /**
   * A provider request's messages with held values redacted. Each message is redacted the way it was the first time it
   * was sent, so a value held later never rewrites it and the provider's cached prompt prefix stays valid; a message
   * that was redacted keeps its redacted form in storage, so it stays redacted after an eviction and after the value
   * expires.
   */
  readonly scrub: <M>(messages: ReadonlyArray<M>) => Effect.Effect<ReadonlyArray<M>, SecretsError>;
};

/** The Session's Secrets (`docs/spec.md` → Effect boundary lists it among the Session DO's services). */
export class Secrets extends Context.Service<Secrets, SecretsService>()(
  "@cloudpid/extensions/secrets/store/Secrets",
) {}

const SECRETS_KEY = "secrets";
const ASKS_KEY = "secret-asks";
const ANSWERS_KEY = "secret-answers";

/** Set once any message was scrubbed, so a Session that never held a Secret skips the work. */
const SCRUBBED_KEY = "secret-scrubbed";

const scrubbedKey = (digest: string) => `secret-scrubbed:${digest}`;

const encoder = new TextEncoder();

/**
 * The index of a message in the scrubbed forms: an unkeyed SHA-256 of its JSON, so the index survives a change of the
 * deployment's key. A keyed digest would hide nothing, as the message sits in the same object's transcript.
 */
const messageDigest = <M>(message: M): Effect.Effect<string, SecretsError> =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`cloudpid scrubbed message v1\n${JSON.stringify(message)}`),
      ),
    catch: (cause) => SecretsError.make({ message: `Cannot digest a message: ${String(cause)}` }),
  }).pipe(Effect.map((digest) => btoa(String.fromCharCode(...new Uint8Array(digest)))));

/** The scope the owner's choice keeps in; none for the Session only. */
const keptScopeOf = (choice: SecretKeep | undefined): KeptScope | undefined => {
  switch (choice) {
    case "environment":
      return "environment";
    case "all":
      return "every";
    default:
      return undefined;
  }
};

type Sealed = Readonly<Record<string, SealedSecret>>;

type Answers = Readonly<Record<string, ReadonlyArray<AskOutcome>>>;

export type SecretsOptions = {
  readonly storage: SecretStorage;
  readonly vault: SecretVault;
  /** Tell the clients which asks are waiting; called whenever that changes. */
  readonly announce: (asks: ReadonlyArray<SecretAsk>) => Effect.Effect<void>;
  /**
   * Called once for each new ask, after `announce`: not for one a rerun finds already waiting. It runs in the
   * background, so the ask neither waits for it nor is held up by it; it must not fail.
   */
  readonly asked?: (ask: SecretAsk) => Effect.Effect<void>;
  /**
   * The Secrets kept for the Session's Environment and for every Environment, with their values: asked for when first
   * needed and once `KEPT_REFRESH_MS` has passed since. A failure keeps what was held, and asks again after
   * `KEPT_RETRY_MS`. Without it, none are held.
   */
  readonly kept?: Effect.Effect<ReadonlyArray<KeptSecret>, unknown> | undefined;
  /**
   * Keep Secrets the owner chose to keep in an answer, for the Session's Environment or for every Environment, and say
   * of each how it went. It runs once the values are sealed, before anything is stored, and must not fail. Needs
   * `kept`: without either, the Secrets are held for the Session only, and the answer says so.
   */
  readonly keep?: ((request: KeepRequest) => Effect.Effect<ReadonlyArray<KeepResult>>) | undefined;
};

const fromVault = Effect.mapError((error: SecretVaultError) =>
  SecretsError.make({ message: error.message }),
);

/** The Secrets of a Session over its storage; opens every Secret still held, so build it once per instance. */
const makeSecrets = ({
  storage,
  vault,
  announce,
  asked,
  kept,
  keep,
}: SecretsOptions): Effect.Effect<SecretsService, SecretsError> =>
  Effect.gen(function* () {
    const redactions = new Redactions();
    /** Opened values, by name. */
    const values = new Map<string, { readonly value: string; readonly expiresAt: number }>();
    /** The kept Secrets, by name, as last handed; in memory only. */
    let keptSecrets = new Map<string, KeptSecret>();
    /** When the kept Secrets are next asked for; 0 until they first are. */
    let keptDueAt = 0;
    const keptLock = yield* Semaphore.make(1);
    /** Calls waiting for an answer, by ask. */
    const waiters = new Map<string, Deferred.Deferred<void>>();
    /** How each message was first sent by this instance, by digest; `null` when it was sent unchanged. */
    const sent = new Map<string, unknown>();

    const sealed = (): Sealed => storage.get<Sealed>(SECRETS_KEY) ?? {};
    const asks = (): ReadonlyArray<SecretAsk> => storage.get<SecretAsk[]>(ASKS_KEY) ?? [];
    const answers = (): Answers => storage.get<Answers>(ANSWERS_KEY) ?? {};

    const now = Clock.currentTimeMillis;

    const putAsks = (next: ReadonlyArray<SecretAsk>) =>
      Effect.suspend(() => {
        storage.put(ASKS_KEY, next);

        return announce(next);
      });

    const deleteSealed = (names: ReadonlyArray<string>) => {
      const kept = Object.fromEntries(
        Object.entries(sealed()).filter(([name]) => !names.includes(name)),
      );

      storage.put(SECRETS_KEY, kept);
    };

    // Open the Secrets an earlier instance stored; those past their lifetime are deleted unopened, and those that no
    // longer open (the deployment's key changed) are deleted, so the Session asks for them again instead of failing.
    const start = yield* now;

    const expired: string[] = [];

    for (const record of Object.values(sealed())) {
      if (record.expiresAt <= start) {
        expired.push(record.name);
        continue;
      }

      const value = yield* vault.open(record).pipe(Effect.orElseSucceed(() => undefined));

      if (value === undefined) {
        expired.push(record.name);
        continue;
      }

      values.set(record.name, { value, expiresAt: record.expiresAt });
      redactions.hold(record.name, value);
    }

    if (expired.length > 0) deleteSealed(expired);

    const live = Effect.map(now, (time) =>
      Arr.filter([...values], ([, secret]) => secret.expiresAt > time),
    );

    /** Ask for the kept Secrets again if they are due; one caller at a time, so a burst of calls asks once. */
    const refreshKept: Effect.Effect<ReadonlyMap<string, KeptSecret>> =
      kept === undefined
        ? Effect.sync(() => keptSecrets)
        : Semaphore.withPermit(
            keptLock,
            Effect.gen(function* () {
              const time = yield* now;

              if (time < keptDueAt) return keptSecrets;

              const loaded = yield* Effect.result(kept);

              if (Result.isFailure(loaded)) {
                keptDueAt = time + KEPT_RETRY_MS;
                yield* Effect.logWarning(
                  "The Secrets kept for the Environment could not be read; those held are kept",
                  loaded.failure,
                );

                return keptSecrets;
              }

              keptSecrets = new Map(loaded.success.map((secret) => [secret.name, secret]));
              keptDueAt = time + KEPT_REFRESH_MS;

              for (const secret of loaded.success) redactions.hold(secret.name, secret.value);

              return keptSecrets;
            }),
          );

    /** The stored answer to ask `id`, taken out of storage. */
    const takeAnswer = (id: string): ReadonlyArray<AskOutcome> | undefined => {
      const all = answers();
      const outcomes = all[id];

      if (outcomes === undefined) return undefined;

      storage.put(
        ANSWERS_KEY,
        Object.fromEntries(Object.entries(all).filter(([key]) => key !== id)),
      );

      return outcomes;
    };

    const withdraw = (id: string) =>
      Effect.suspend(() => {
        waiters.delete(id);

        const remaining = asks().filter((ask) => ask.id !== id);

        return remaining.length === asks().length ? Effect.void : putAsks(remaining);
      });

    const ask = (request: SecretAsk) =>
      Effect.gen(function* () {
        const ready = takeAnswer(request.id);

        if (ready !== undefined) return ready;

        const waiter = waiters.get(request.id) ?? (yield* Deferred.make<void>());

        waiters.set(request.id, waiter);

        if (!asks().some((pending) => pending.id === request.id)) {
          yield* putAsks([...asks(), request]);

          // In the background: the owner's notification may take seconds, and the ask must not wait on it, nor
          // outlive an abort that lands meanwhile (the wait below withdraws it).
          if (asked !== undefined) yield* Effect.forkDetach(asked(request));
        }

        yield* Deferred.await(waiter).pipe(Effect.onInterrupt(() => withdraw(request.id)));
        waiters.delete(request.id);

        const outcomes = takeAnswer(request.id);

        if (outcomes === undefined) {
          return yield* SecretsError.make({ message: `Secret request ${request.id} was lost` });
        }

        return outcomes;
      });

    /** Keep what the owner chose to keep, and say of each name how it went; a hook that fails keeps nothing. */
    const keepChosen = (request: SecretAsk, scope: KeptScope, secrets: KeepRequest["secrets"]) =>
      Effect.gen(function* () {
        const problem = (message: string): ReadonlyArray<KeepResult> =>
          secrets.map(({ name }) => ({ name, kept: false, problem: message }));

        if (keep === undefined || kept === undefined) {
          return problem("This Session cannot keep Secrets");
        }

        const results = yield* Effect.result(keep({ ask: request, scope, secrets }));

        if (Result.isFailure(results)) {
          yield* Effect.logWarning(
            `Keeping the Secrets ${Arr.join(
              Arr.map(secrets, ({ name }) => name),
              ", ",
            )} failed; they are held for the Session only`,
          );

          return problem("Keeping them failed; try again");
        }

        return results.success;
      });

    const answer = (
      id: string,
      given: Readonly<Record<string, string>> | null,
      choice: SecretKeep | undefined,
    ) =>
      Effect.gen(function* () {
        const request = asks().find((pending) => pending.id === id);

        if (request === undefined) {
          return yield* SecretsError.make({
            message: `No Secret request ${id} is waiting: it was answered, or its call ended`,
          });
        }

        const unasked =
          given === null ? [] : Object.keys(given).filter((name) => !request.names.includes(name));

        if (unasked.length > 0) {
          return yield* SecretsError.make({
            message: `Secret request ${id} did not ask for ${unasked.join(", ")}`,
          });
        }

        const time = yield* now;
        const expiresAt = time + SECRET_LIFETIME_MS;
        const outcomes: AskOutcome[] = [];
        const opened: Array<{ readonly name: string; readonly value: string }> = [];
        const records: Record<string, SealedSecret> = {};

        for (const name of request.names) {
          const value = given?.[name];

          if (given === null) outcomes.push({ name, status: "cancelled" });
          else if (value === undefined || value === "") outcomes.push({ name, status: "skipped" });
          else {
            // Sealed before anything is written, so a failure leaves the ask waiting and nothing held.
            records[name] = yield* fromVault(vault.seal(name, value, expiresAt));
            opened.push({ name, value });
            outcomes.push({ name, status: "provided", expiresAt });
          }
        }

        const scope = keptScopeOf(choice);

        const keeping =
          scope === undefined || opened.length === 0
            ? []
            : yield* keepChosen(request, scope, opened);

        const keptNames = new Set<string>();

        for (const [index, outcome] of outcomes.entries()) {
          if (outcome.status !== "provided" || scope === undefined) continue;

          const result = keeping.find((candidate) => candidate.name === outcome.name);

          if (result?.kept === true) {
            keptNames.add(outcome.name);
            outcomes[index] =
              result.shadowed === true
                ? { name: outcome.name, status: "kept", scope, shadowed: true }
                : { name: outcome.name, status: "kept", scope };
          } else {
            outcomes[index] = {
              ...outcome,
              notKept: result?.kept === false ? result.problem : "The Secret was not kept",
            };
          }
        }

        // A kept Secret is not entered: it would win over the kept one for 15 minutes, and then lapse.
        const entered = Object.fromEntries(
          Object.entries(records).filter(([name]) => !keptNames.has(name)),
        );

        for (const name of keptNames) values.delete(name);

        storage.put(SECRETS_KEY, {
          ...Object.fromEntries(Object.entries(sealed()).filter(([name]) => !keptNames.has(name))),
          ...entered,
        });
        storage.put(ANSWERS_KEY, { ...answers(), [id]: outcomes });

        for (const { name, value } of opened) {
          if (!keptNames.has(name)) values.set(name, { value, expiresAt });

          redactions.hold(name, value);
        }

        // The Registry has the kept Secrets now: ask for them again at the next use.
        if (keptNames.size > 0) keptDueAt = 0;

        yield* putAsks(asks().filter((pending) => pending.id !== id));

        const waiter = waiters.get(id);

        if (waiter !== undefined) yield* Deferred.succeed(waiter, undefined);
      });

    const scrub = <M>(messages: ReadonlyArray<M>) =>
      Effect.gen(function* () {
        // A Run's first request asks for the kept Secrets, so a value that reached the conversation is scrubbed.
        yield* refreshKept;

        if (redactions.generation === 0 && storage.get<boolean>(SCRUBBED_KEY) !== true) {
          return messages;
        }

        const generation = redactions.generation;
        let changed = false;
        const scrubbed: M[] = [];

        for (const message of messages) {
          const digest = yield* messageDigest(message);
          let first = sent.get(digest);

          if (first === undefined) {
            const stored = storage.get<M>(scrubbedKey(digest));
            const redacted = stored ?? redactions.redact(message, generation);

            if (stored === undefined && redacted !== message) {
              storage.put(scrubbedKey(digest), redacted);
              storage.put(SCRUBBED_KEY, true);
            }

            first = redacted === message ? null : redacted;
            sent.set(digest, first);
          }

          if (first === null) scrubbed.push(message);
          else {
            changed = true;
            // SAFETY: `first` is this message's own redacted form, which has the message's type.
            scrubbed.push(first as M);
          }
        }

        return changed ? scrubbed : messages;
      });

    return {
      held: Effect.zipWith(live, refreshKept, (secrets, keptByName) => {
        const entered = new Set(secrets.map(([name]) => name));

        const all: HeldSecret[] = [
          ...secrets.map(([name, secret]) => ({ name, expiresAt: secret.expiresAt })),
          ...Arr.filter([...keptByName.values()], (secret) => !entered.has(secret.name)).map(
            (secret) => ({ name: secret.name, kept: secret.scope }),
          ),
        ];

        return all.toSorted((a, b) => a.name.localeCompare(b.name));
      }),
      resolve: (name) =>
        Effect.zipWith(now, refreshKept, (time, keptByName) => {
          const secret = values.get(name);

          return secret !== undefined && secret.expiresAt > time
            ? secret.value
            : keptByName.get(name)?.value;
        }),
      environment: Effect.zipWith(live, refreshKept, (secrets, keptByName) =>
        Object.fromEntries([
          ...[...keptByName.values()].map((secret) => [secretEnvName(secret.name), secret.value]),
          ...secrets.map(([name, secret]) => [secretEnvName(name), secret.value]),
        ]),
      ),
      forget: (names) =>
        Effect.zipWith(live, refreshKept, (secrets, keptByName) => {
          const held = new Set(secrets.map(([name]) => name));

          for (const name of names) values.delete(name);
          deleteSealed(names);

          return names.map((name): ForgetOutcome => {
            const scope = keptByName.get(name)?.scope;

            return scope === undefined
              ? { name, forgotten: held.has(name) }
              : { name, forgotten: held.has(name), kept: scope };
          });
        }),
      refresh: Effect.asVoid(refreshKept),
      sweep: Effect.map(now, (time) => {
        const expired = Object.values(sealed())
          .filter((record) => record.expiresAt <= time)
          .map((record) => record.name);

        for (const name of expired) values.delete(name);

        if (expired.length > 0) deleteSealed(expired);
      }),
      nextExpiry: Effect.map(live, (secrets) => {
        const times = secrets.map(([, secret]) => secret.expiresAt);

        return times.length === 0 ? undefined : Math.min(...times);
      }),
      ask,
      pending: Effect.sync(asks),
      dropAbandoned: Effect.suspend(() => {
        if (Object.keys(answers()).length > 0) storage.put(ANSWERS_KEY, {});

        const waited = asks().filter((pending) => waiters.has(pending.id));

        return waited.length === asks().length ? Effect.void : putAsks(waited);
      }),
      answer,
      redact: (value) => redactions.redact(value),
      redacting: () => redactions.generation > 0,
      stream: () => redactions.stream(),
      scrub,
    } satisfies SecretsService;
  });

/** The Session's `Secrets` over its storage and vault; opens every Secret still held, so build it once per instance. */
export const secretsLayer = (options: SecretsOptions): Layer.Layer<Secrets, SecretsError> =>
  Layer.effect(Secrets, makeSecrets(options));
