// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off preferSchemaOverJson:off
// The Session's Secrets (`docs/spec.md` → Secrets): values the owner enters in a masked form on the client, kept
// encrypted in the Session DO's storage for their lifetime, and the redaction of every value held in this instance.
//
// An ask is durable: it is stored until the owner answers or its call is cancelled, and the answer is stored with the
// Secrets it provided, so a call that an eviction cut off finds the answer when it reruns, and an owner who answers
// while no call waits still has the answer kept.
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
});

export type SecretAsk = typeof SecretAsk.Type;

/** What became of one name an ask requested. */
export type AskOutcome =
  | { readonly name: string; readonly status: "provided"; readonly expiresAt: number }
  | { readonly name: string; readonly status: "skipped" | "cancelled" };

/** A Secret this Session holds, without its value. */
export type HeldSecret = { readonly name: string; readonly expiresAt: number };

/** An ask could not be answered or completed. */
export class SecretsError extends Schema.TaggedError<
  SecretsError,
  { readonly brand: unique symbol }
>()("SecretsError", { message: Schema.String }) {}

export type SecretsService = {
  /** The Secrets held now, by name. */
  readonly held: Effect.Effect<ReadonlyArray<HeldSecret>>;
  /** The value held under `name`, unless its lifetime has passed. */
  readonly resolve: (name: string) => Effect.Effect<string | undefined>;
  /** Every held Secret as the environment variable commands get it under. */
  readonly environment: Effect.Effect<Readonly<Record<string, string>>>;
  /** Forget `names` now; says of each whether it was held. */
  readonly forget: (
    names: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly forgotten: boolean }>>;
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
  ) => Effect.Effect<void, SecretsError>;
  /** `value` with every value held in this instance replaced by its Secret Reference. */
  readonly redact: <A>(value: A) => A;
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

type Sealed = Readonly<Record<string, SealedSecret>>;

type Answers = Readonly<Record<string, ReadonlyArray<AskOutcome>>>;

export type SecretsOptions = {
  readonly storage: SecretStorage;
  readonly vault: SecretVault;
  /** Tell the clients which asks are waiting; called whenever that changes. */
  readonly announce: (asks: ReadonlyArray<SecretAsk>) => Effect.Effect<void>;
};

const fromVault = Effect.mapError((error: SecretVaultError) =>
  SecretsError.make({ message: error.message }),
);

/** The Secrets of a Session over its storage; opens every Secret still held, so build it once per instance. */
const makeSecrets = ({
  storage,
  vault,
  announce,
}: SecretsOptions): Effect.Effect<SecretsService, SecretsError> =>
  Effect.gen(function* () {
    const redactions = new Redactions();
    /** Opened values, by name. */
    const values = new Map<string, { readonly value: string; readonly expiresAt: number }>();
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
        }

        yield* Deferred.await(waiter).pipe(Effect.onInterrupt(() => withdraw(request.id)));
        waiters.delete(request.id);

        const outcomes = takeAnswer(request.id);

        if (outcomes === undefined) {
          return yield* SecretsError.make({ message: `Secret request ${request.id} was lost` });
        }

        return outcomes;
      });

    const answer = (id: string, given: Readonly<Record<string, string>> | null) =>
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

        storage.put(SECRETS_KEY, { ...sealed(), ...records });
        storage.put(ANSWERS_KEY, { ...answers(), [id]: outcomes });

        for (const { name, value } of opened) {
          values.set(name, { value, expiresAt });
          redactions.hold(name, value);
        }

        yield* putAsks(asks().filter((pending) => pending.id !== id));

        const waiter = waiters.get(id);

        if (waiter !== undefined) yield* Deferred.succeed(waiter, undefined);
      });

    const scrub = <M>(messages: ReadonlyArray<M>) =>
      Effect.gen(function* () {
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
      held: Effect.map(live, (secrets) =>
        secrets
          .toSorted(([a], [b]) => a.localeCompare(b))
          .map(([name, secret]) => ({ name, expiresAt: secret.expiresAt })),
      ),
      resolve: (name) =>
        Effect.map(now, (time) => {
          const secret = values.get(name);

          return secret !== undefined && secret.expiresAt > time ? secret.value : undefined;
        }),
      environment: Effect.map(live, (secrets) =>
        Object.fromEntries(secrets.map(([name, secret]) => [secretEnvName(name), secret.value])),
      ),
      forget: (names) =>
        Effect.map(live, (secrets) => {
          const held = new Set(secrets.map(([name]) => name));

          for (const name of names) values.delete(name);
          deleteSealed(names);

          return names.map((name) => ({ name, forgotten: held.has(name) }));
        }),
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
      stream: () => redactions.stream(),
      scrub,
    } satisfies SecretsService;
  });

/** The Session's `Secrets` over its storage and vault; opens every Secret still held, so build it once per instance. */
export const secretsLayer = (options: SecretsOptions): Layer.Layer<Secrets, SecretsError> =>
  Layer.effect(Secrets, makeSecrets(options));
