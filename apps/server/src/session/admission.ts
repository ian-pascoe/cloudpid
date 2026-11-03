// The lines an owner's messages wait in before they are placed: one per conversation, so a message that is slow to
// prepare holds back only the ones sent after it to the same conversation (docs/architecture/mcp-in-a-session.md →
// Getting a prompt at send). The Session's lock (`inArrivalOrder`) is not held while a message waits or prepares.
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/** Where a message stands in its conversation's line: wait for `turn`, and `leave` when done, however it ended. */
type Place = {
  readonly turn: Effect.Effect<void>;
  readonly leave: Effect.Effect<void>;
};

/**
 * The lines of one Session, and the conversations a message is in line for. Held in memory: an eviction drops them.
 * `inArrivalOrder` is the Session's lock, under which a message's conversation is fixed.
 */
export const admissionLines = (
  inArrivalOrder: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) => {
  // Messages take their place in line one at a time, so two that arrive together are in line in the order they arrived,
  // though the read that tells which conversation each is for may finish in either.
  const arriving = Semaphore.withPermit(Semaphore.makeUnsafe(1));

  /** The last of each line: the message a new one waits for. */
  const tails = new Map<ConversationId, Deferred.Deferred<void>>();

  /** How many messages are in line, being prepared or being placed, for each conversation. */
  const counted = new Map<ConversationId, number>();

  // Synchronous, so that taking a place is one step with being first or last in line.
  const join = (key: ConversationId): Place => {
    const previous = tails.get(key);
    const mine = Deferred.makeUnsafe<void>();

    tails.set(key, mine);
    counted.set(key, (counted.get(key) ?? 0) + 1);

    return {
      turn: previous === undefined ? Effect.void : Deferred.await(previous),
      leave: Effect.sync(() => {
        Deferred.doneUnsafe(mine, Effect.void);

        if (tails.get(key) === mine) tails.delete(key);

        const left = (counted.get(key) ?? 1) - 1;

        if (left > 0) counted.set(key, left);
        else counted.delete(key);
      }),
    };
  };

  /**
   * Run `body` in the line of the conversation `which` finds, after every message that joined it earlier has finished,
   * and let the next one go when it ends. The conversation is found, and the line joined, under `inArrivalOrder`: a
   * message sent while the Session tree moves is for the branch it moved to, and is in line before any sent after it.
   * Until `body` ends the conversation counts as being prepared for (`isPreparing`), which keeps the tree where it is.
   * A message interrupted while it waits still waits for its turn and for the lock, so the ones behind it never get
   * ahead of the ones before it.
   */
  const inLine = <E1, R1, A, E2, R2>(
    which: Effect.Effect<ConversationId, E1, R1>,
    body: (conversationId: ConversationId) => Effect.Effect<A, E2, R2>,
  ): Effect.Effect<A, E1 | E2, R1 | R2> =>
    Effect.uninterruptibleMask((restore) =>
      arriving(
        inArrivalOrder(restore(which).pipe(Effect.map((key) => ({ key, place: join(key) })))),
      ).pipe(
        Effect.flatMap(({ key, place }) =>
          place.turn.pipe(Effect.andThen(restore(body(key))), Effect.ensuring(place.leave)),
        ),
      ),
    );

  /** Whether a message is in line for conversation `key`, not yet placed. */
  const isPreparing = (key: ConversationId): boolean => counted.has(key);

  return { inLine, isPreparing };
};
