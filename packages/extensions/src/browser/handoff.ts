// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off
// A Browser Handoff (`docs/spec.md` → Browser, ADR-0007): the agent gives the owner live control of its browser for a
// step it cannot do, and waits. It follows the Secret request's design (`../secrets/store.ts`): the request is stored
// until its call ends, shown to every client and pushed to the owner, withdrawn when the call is aborted, and found
// again by a call an eviction cut off, which waits on the same handoff.
//
// The Live View link is a bearer credential for the owner alone. It lives here, in the Session DO's key-value storage
// (so a client that connects later is shown it), and is sent to clients and in the push; it never enters the tool's
// arguments, result, or details, so it never reaches the transcript or a model request.
//
// The handoff itself lives in the browser host, which holds Browser Run's CDP connection and hears the owner finish in
// Live View (`Cloudflare.handoffComplete`). The call asks it in short rounds, so nothing here depends on one long call
// outliving an eviction, and each round also keeps the browser in use.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { OwnerNotifications } from "../notify.ts";
import { HANDOFF_TIMEOUT_MS } from "./contract.ts";
import { type BrowserError, type BrowserHostService } from "./host.ts";
import { BrowserSession, type BrowserSessionService } from "./session.ts";

/** How long one round of waiting on the host lasts at most. */
export const HANDOFF_POLL_MS = 25_000;

/** How long past its deadline a call may still hear the end of a handoff, for a host that answers just late. */
const DEADLINE_GRACE_MS = 15_000;

/** A handoff that ends this close to its deadline timed out: Browser Run's own timer starts a moment before ours. */
const TIMEOUT_SLACK_MS = 10_000;

/** Host calls that may fail one after another before the wait gives up. */
const MAX_HOST_FAILURES = 3;

/** How long a cleanup call to the host may take: it runs as the call ends. */
const CLEANUP_TIMEOUT = "5 seconds";

/** The Durable Object's synchronous key-value storage, as the store uses it. */
export type BrowserHandoffStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** A Browser Handoff waiting for the owner, with the link to do it in. */
export const BrowserHandoffRequest = Schema.Struct({
  /** Unique within the Session: the asking call's task. */
  id: Schema.String,
  /** The conversation whose tab is handed over. */
  conversationId: Schema.Finite,
  /** What the agent needs done, shown to the owner. */
  instructions: Schema.String,
  /** The Live View link. */
  url: Schema.String,
  /** When the handoff times out, epoch milliseconds. */
  deadline: Schema.Finite,
});

export type BrowserHandoffRequest = typeof BrowserHandoffRequest.Type;

/** How a handoff ended, as the tool tells the model; never the link. */
export type BrowserHandoffOutcome =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly reason?: string }
  | { readonly status: "timeout" }
  | { readonly status: "ended" };

export type BrowserHandoffsService = {
  /** The handoffs waiting for the owner, oldest first: those past their deadline (and grace) are not shown. */
  readonly pending: Effect.Effect<ReadonlyArray<BrowserHandoffRequest>>;
  /**
   * Hand `input.conversationId`'s tab to the owner and wait until they finish, report failure, or the handoff times
   * out. Asking again with the same `id` (a rerun after an eviction) waits for the same handoff. Cancelling the wait
   * ends the handoff and withdraws the request.
   */
  readonly request: (input: {
    readonly id: string;
    readonly conversationId: number;
    readonly instructions: string;
  }) => Effect.Effect<BrowserHandoffOutcome, BrowserError>;
  /**
   * End every handoff no call in this instance waits for. Run only while no work is live: then no call can still come
   * back for them (one an eviction cut off has rerun by then), so they were abandoned.
   */
  readonly dropAbandoned: Effect.Effect<void>;
};

/** The Session's Browser Handoffs. */
export class BrowserHandoffs extends Context.Service<BrowserHandoffs, BrowserHandoffsService>()(
  "@cloudpid/extensions/browser/handoff/BrowserHandoffs",
) {}

const PENDING_KEY = "browser-handoffs";

export type BrowserHandoffsOptions = {
  readonly host: BrowserHostService;
  readonly storage: BrowserHandoffStorage;
  /** Tell the clients which handoffs wait; called whenever that changes. */
  readonly announce: (requests: ReadonlyArray<BrowserHandoffRequest>) => Effect.Effect<void>;
  /** How long a handoff waits for the owner. Defaults to `HANDOFF_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** How long one round of waiting on the host lasts at most. Defaults to `HANDOFF_POLL_MS`. */
  readonly pollMs?: number;
  /** How long past its deadline a call may still hear a handoff end. Defaults to 15 seconds. */
  readonly graceMs?: number;
};

/** The words of a push that asks the owner to take over. */
const pushBody = (instructions: string): string => `Needs you in the browser: ${instructions}`;

/** `text` without the Live View link, so that nothing the model reads can carry it. */
const withoutLink = (text: string, url: string): string => text.split(url).join("[Live View link]");

export const makeBrowserHandoffs = (
  {
    host,
    storage,
    announce,
    timeoutMs = HANDOFF_TIMEOUT_MS,
    pollMs = HANDOFF_POLL_MS,
    graceMs = DEADLINE_GRACE_MS,
  }: BrowserHandoffsOptions,
  session: Pick<BrowserSessionService, "touch">,
  notifications: (typeof OwnerNotifications)["Service"],
): BrowserHandoffsService => {
  /** Calls in this instance waiting on a handoff, by request. */
  const waiting = new Set<string>();

  const stored = (): ReadonlyArray<BrowserHandoffRequest> =>
    storage.get<BrowserHandoffRequest[]>(PENDING_KEY) ?? [];

  const put = (requests: ReadonlyArray<BrowserHandoffRequest>) =>
    Effect.suspend(() => {
      storage.put(PENDING_KEY, requests);

      return announce(requests);
    });

  /** End the handoff in the host, if it is there: never fails or takes long, as it runs when a call ends. */
  const endInHost = (id: string) =>
    host.endHandoff(id).pipe(
      Effect.timeout(CLEANUP_TIMEOUT),
      Effect.catch((error) => Effect.logWarning("Ending a Browser Handoff failed", error)),
    );

  const withdraw = (id: string) =>
    Effect.suspend(() => {
      waiting.delete(id);

      const remaining = stored().filter((request) => request.id !== id);

      return remaining.length === stored().length ? Effect.void : put(remaining);
    });

  /** Ask the host in rounds until the handoff has an outcome. */
  const waitFor = (request: BrowserHandoffRequest) =>
    Effect.gen(function* () {
      let failures = 0;

      while (true) {
        const now = yield* Clock.currentTimeMillis;
        const remaining = request.deadline + graceMs - now;

        if (remaining <= 0) return { status: "timeout" } satisfies BrowserHandoffOutcome;

        // The browser is in use while the owner works in it: it must not be closed as idle.
        yield* session.touch;

        const round = yield* host.waitHandoff(request.id, Math.min(remaining, pollMs)).pipe(
          Effect.match({
            onFailure: (error) => ({ failed: error }) as const,
            onSuccess: (status) => ({ status }) as const,
          }),
        );

        if ("failed" in round) {
          failures += 1;

          if (failures >= MAX_HOST_FAILURES) return yield* round.failed;

          yield* Effect.sleep("2 seconds");
          continue;
        }

        failures = 0;

        switch (round.status.state) {
          case "waiting":
            continue;
          case "complete": {
            if (round.status.success)
              return { status: "completed" } satisfies BrowserHandoffOutcome;

            const ended = yield* Clock.currentTimeMillis;

            if (ended >= request.deadline - TIMEOUT_SLACK_MS) {
              return { status: "timeout" } satisfies BrowserHandoffOutcome;
            }

            const reason = round.status.reason?.trim();

            const failed: Types.Mutable<
              Extract<BrowserHandoffOutcome, { readonly status: "failed" }>
            > = {
              status: "failed",
            };

            if (reason !== undefined && reason !== "") {
              failed.reason = withoutLink(reason, request.url);
            }

            return failed satisfies BrowserHandoffOutcome;
          }

          case "ended":
          case "unknown":
            return { status: "ended" } satisfies BrowserHandoffOutcome;
        }
      }
    });

  const request: BrowserHandoffsService["request"] = ({ id, conversationId, instructions }) =>
    Effect.gen(function* () {
      let found = stored().find((pending) => pending.id === id);

      if (found === undefined) {
        const started = yield* host.startHandoff({
          requestId: id,
          conversationId,
          instructions,
          timeoutMs,
        });

        const created: BrowserHandoffRequest = {
          id,
          conversationId,
          instructions,
          url: started.url,
          deadline: started.startedAt + timeoutMs,
        };

        found = created;

        // A blank link is a handoff that is over already (a start that came again after it ended): nothing to show the
        // owner, and the wait finds the outcome.
        if (started.url !== "") {
          yield* put([...stored(), created]);

          // In the background: the push may take seconds, and the wait must neither wait on it nor outlive an abort.
          yield* Effect.forkDetach(
            notifications.notify({
              kind: "notice",
              body: pushBody(instructions),
              url: created.url,
            }),
          );
        }
      }

      waiting.add(id);

      return yield* waitFor(found);
    }).pipe(
      // However the call ends (an outcome, a failure, an abort): the request is withdrawn and the handoff ended. An
      // eviction runs no finalizer: the request stays, and the rerun waits for it.
      Effect.ensuring(Effect.andThen(withdraw(id), endInHost(id))),
    );

  return {
    pending: Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      return stored().filter((pending) => pending.deadline + graceMs > now);
    }),
    request,
    dropAbandoned: Effect.suspend(() => {
      const abandoned = stored().filter((pending) => !waiting.has(pending.id));

      if (abandoned.length === 0) return Effect.void;

      return put(stored().filter((pending) => waiting.has(pending.id))).pipe(
        Effect.andThen(
          Effect.forEach(abandoned, (pending) => endInHost(pending.id), { discard: true }),
        ),
      );
    }),
  };
};

/** The Session's `BrowserHandoffs` over its storage and host; needs the Session's `BrowserSession` and `OwnerNotifications`. */
export const browserHandoffsLayer = (options: BrowserHandoffsOptions) =>
  Layer.effect(
    BrowserHandoffs,
    Effect.all([Effect.service(BrowserSession), Effect.service(OwnerNotifications)]).pipe(
      Effect.map(([session, notifications]) =>
        makeBrowserHandoffs(options, session, notifications),
      ),
    ),
  );
