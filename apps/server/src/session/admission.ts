// The lines an owner's messages wait in before they are placed: one per conversation, so a message that is slow to
// prepare holds back only the ones sent after it to the same conversation (docs/architecture/mcp-in-a-session.md →
// Getting a prompt at send). The Session's lock (`inArrivalOrder`) is not held while a message waits or prepares.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Where a message stands in its conversation's line: wait for `turn`, and `leave` when done, however it ended. */
type Place = {
  readonly turn: Effect.Effect<void>;
  readonly leave: Effect.Effect<void>;
};

/** The lines of one Session, and the conversations a message is being prepared for. Held in memory: an eviction drops them. */
export const admissionLines = () => {
  // Messages take their place in line one at a time, so two that arrive together are in line in the order they arrived,
  // though the read that tells which conversation each is for may finish in either.
  const arriving = Semaphore.withPermit(Semaphore.makeUnsafe(1));

  /** The last of each line: the message a new one waits for. */
  const tails = new Map<string, Deferred.Deferred<void>>();

  /** How many messages are being prepared (or placed) for each conversation. */
  const preparing = new Map<string, number>();

  // Synchronous, so that taking a place is one step with being first or last in line.
  const join = (key: string): Place => {
    const previous = tails.get(key);
    const mine = Deferred.makeUnsafe<void>();

    tails.set(key, mine);

    return {
      turn: previous === undefined ? Effect.void : Deferred.await(previous),
      leave: Effect.sync(() => {
        Deferred.doneUnsafe(mine, Effect.void);

        if (tails.get(key) === mine) tails.delete(key);
      }),
    };
  };

  /**
   * Run `body` in the line of the conversation `which` finds, after every message that joined it earlier has finished,
   * and let the next one go when it ends. A message that is interrupted while it waits still waits for its turn, so the
   * ones behind it never get ahead of the ones before it.
   */
  const inLine = <E1, R1, A, E2, R2>(
    which: Effect.Effect<string, E1, R1>,
    body: Effect.Effect<A, E2, R2>,
  ): Effect.Effect<A, E1 | E2, R1 | R2> =>
    Effect.uninterruptibleMask((restore) =>
      arriving(restore(which).pipe(Effect.map((key) => ({ key, place: join(key) })))).pipe(
        Effect.flatMap(({ place }) =>
          place.turn.pipe(Effect.andThen(restore(body)), Effect.ensuring(place.leave)),
        ),
      ),
    );

  /** Count a message as being prepared for conversation `key`, until `end`. */
  const begin = (key: string): void => {
    preparing.set(key, (preparing.get(key) ?? 0) + 1);
  };

  /** Stop counting a message that `begin` counted for conversation `key`. */
  const end = (key: string): void => {
    const left = (preparing.get(key) ?? 1) - 1;

    if (left > 0) preparing.set(key, left);
    else preparing.delete(key);
  };

  /** Whether a message is being prepared for conversation `key` now. */
  const isPreparing = (key: string): boolean => preparing.has(key);

  return { inLine, begin, end, isPreparing };
};
