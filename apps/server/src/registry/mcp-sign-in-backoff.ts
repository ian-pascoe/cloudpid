// What a token fetch the Registry makes for itself shares between a refresh (`mcp-sign-in-refresh.ts`) and a client grant
// (`mcp-sign-in-client-grant.ts`) (`docs/architecture/mcp-sign-in.md` → Refresh and step-up, Client Credentials):
//
// - **Single-flight per sign-in:** a caller that arrives while a fetch is in flight waits for it and shares its answer. A
//   fetch once sent is never cancelled (its region is uninterruptible).
// - **One retry** of a transient failure, after a second.
// - **A backoff** after a fetch that failed twice: 10 s that doubles up to 5 min and resets on success. It is held in
//   memory: an evicted Registry tries again at the next ask.
// - **The owner-facing reason** a failed request leaves, from the OAuth error code and the status, never a token.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off
import type { McpAccessTokenAnswer } from "@cloudpid/mcp/types";
import { SealedValue } from "@cloudpid/extensions/secrets/core";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { told } from "./mcp-sign-in-registry.ts";

/** The pause before the one retry of a transient failure. */
export const RETRY_MS = 1_000;

/** The first backoff after a fetch that failed twice; it doubles, up to {@link MAX_BACKOFF_MS}. */
export const BACKOFF_MS = 10_000;

export const MAX_BACKOFF_MS = 5 * 60_000;

/** The delay of the backoff after the `failures`th failed fetch (1-based). */
export const backoffMs = (failures: number): number =>
  Math.min(BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);

/** The backoffs of the sign-ins in this Registry's memory, by key hash. */
export type Backoffs = {
  /** The hold on `hash`: how many fetches failed in a row, when the next may go, and why the last did not. */
  readonly held: (
    hash: string,
  ) =>
    | { readonly failures: number; readonly retryAt: number; readonly reason?: string }
    | undefined;
  /** Counts one more failed fetch at `now`, holding the next back by the backoff; `reason` is what the last one said. */
  readonly failed: (hash: string, now: number, reason?: string) => void;
  /** A hold of the first backoff that counts no failure: a request that could not be made, and was not tried. */
  readonly hold: (hash: string, now: number, reason?: string) => void;
  /** A fetch that worked, or a sign-in that is gone: no hold. */
  readonly clear: (hash: string) => void;
};

export const inMemoryBackoffs = (): Backoffs => {
  const holds = new Map<
    string,
    { readonly failures: number; readonly retryAt: number; readonly reason?: string }
  >();

  return {
    held: (hash) => holds.get(hash),
    failed: (hash, now, reason) => {
      const failures = (holds.get(hash)?.failures ?? 0) + 1;
      const retryAt = now + backoffMs(failures);

      holds.set(hash, reason === undefined ? { failures, retryAt } : { failures, retryAt, reason });
    },
    hold: (hash, now, reason) => {
      const failures = holds.get(hash)?.failures ?? 0;
      const retryAt = now + BACKOFF_MS;

      holds.set(hash, reason === undefined ? { failures, retryAt } : { failures, retryAt, reason });
    },
    clear: (hash) => {
      holds.delete(hash);
    },
  };
};

/**
 * `run` once at a time for each sign-in: callers that arrive while it runs wait for it and share its answer. The run
 * is uninterruptible once started, and an exit from it is shared as it is.
 */
export const singleFlight = <Request extends { readonly key: { readonly hash: string } }>(
  run: (request: Request, now: number) => Effect.Effect<McpAccessTokenAnswer>,
): ((request: Request, now: number) => Effect.Effect<McpAccessTokenAnswer>) => {
  const flights = new Map<string, Deferred.Deferred<McpAccessTokenAnswer>>();

  return (request, now) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const { hash } = request.key;
        const flight = flights.get(hash);

        if (flight !== undefined) return yield* restore(Deferred.await(flight));

        const own = Deferred.makeUnsafe<McpAccessTokenAnswer>();

        flights.set(hash, own);

        const exit = yield* Effect.exit(run(request, now));

        flights.delete(hash);
        yield* Deferred.done(own, exit);

        return yield* exit;
      }),
    );
};

/** `send`, and once more after `retryMs` when the first answer is not one `settled` says is final. */
export const retryOnce = <Outcome>(
  send: Effect.Effect<Outcome>,
  settled: (outcome: Outcome) => boolean,
  retryMs: number,
): Effect.Effect<Outcome> =>
  Effect.gen(function* () {
    const first = yield* send;

    if (settled(first)) return first;

    yield* Effect.sleep(Duration.millis(retryMs));

    return yield* send;
  });

/** Names how a fetch came to an end on the current span. */
export const outcomeOf = (outcome: string) =>
  Effect.annotateCurrentSpan({ "mcp.outcome": outcome });

/** Whether two sealed values are the same one, or both absent. */
export const sameSealed = Schema.toEquivalence(Schema.NullOr(SealedValue));

/**
 * The reason a request that was refused (an OAuth error code, the server's description and the HTTP status) or failed
 * leaves on a row, for the owner: no token is in it.
 */
export const reasonOf = (
  outcome:
    | {
        readonly kind: "refused";
        readonly code: string;
        readonly message: string;
        readonly status: number | undefined;
      }
    | { readonly kind: "failed"; readonly message: string },
): string => {
  if (outcome.kind === "failed") return told(outcome.message);

  if (outcome.code === "server_error" && outcome.status !== undefined) {
    return `The authorization server answered HTTP ${outcome.status}`;
  }

  return outcome.message === outcome.code
    ? outcome.code
    : told(`${outcome.code} (${outcome.message})`);
};
