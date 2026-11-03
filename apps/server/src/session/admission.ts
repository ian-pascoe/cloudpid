// The lines an owner's messages wait in before they are placed: one per conversation, so a message that is slow to
// prepare holds back only the ones sent after it to the same conversation (docs/architecture/mcp-in-a-session.md →
// Getting a prompt at send). The Session's lock (`inArrivalOrder`) is not held while a message waits or prepares. Stop
// withdraws the messages in a conversation's line that are not yet being placed.
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { type SessionError, withdrawn } from "./errors.ts";

/** A message in a line. */
type Member = {
  /** Done when the message has left the line, however it ended. */
  readonly left: Deferred.Deferred<void>;
  /** Done when Stop withdraws the message: what it prepares is cancelled. */
  readonly cancel: Deferred.Deferred<void>;
  /** Whether Stop withdrew it. A withdrawn message places nothing. */
  withdrawn: boolean;
  /** Whether it is being placed: Stop leaves it, and it is withdrawn as queued input once it is placed. */
  placing: boolean;
};

/** Where a message stands in its conversation's line: wait for `turn`, and `leave` when done, however it ended. */
type Place = {
  readonly member: Member;
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

  /** The messages in line, being prepared or being placed, for each conversation. */
  const members = new Map<ConversationId, Set<Member>>();

  // Synchronous, so that taking a place is one step with being first or last in line.
  const join = (key: ConversationId): Place => {
    const previous = tails.get(key);

    const member: Member = {
      left: Deferred.makeUnsafe<void>(),
      cancel: Deferred.makeUnsafe<void>(),
      withdrawn: false,
      placing: false,
    };

    tails.set(key, member.left);
    members.set(key, (members.get(key) ?? new Set()).add(member));

    return {
      member,
      turn: previous === undefined ? Effect.void : Deferred.await(previous),
      leave: Effect.sync(() => {
        Deferred.doneUnsafe(member.left, Effect.void);

        if (tails.get(key) === member.left) tails.delete(key);

        const line = members.get(key);

        line?.delete(member);

        if (line?.size === 0) members.delete(key);
      }),
    };
  };

  /**
   * Run `prepare` in the line of the conversation `which` finds, after every message that joined it earlier has left,
   * then `place` under `inArrivalOrder`, and let the next message go when it ends. The conversation is found, and the
   * line joined, under `inArrivalOrder`: a message sent while the Session tree moves is for the branch it moved to, and
   * is in line before any sent after it. Until it ends the conversation counts as being prepared for (`isPreparing`),
   * which keeps the tree where it is. A message interrupted while it waits still waits for its turn and for the lock,
   * so the ones behind it never get ahead of the ones before it.
   *
   * A message `withdraw` reached before it is placed fails with `withdrawn()`: what it was preparing is cancelled, it
   * places nothing, and it still waits for its turn to leave, so the ones behind it keep their order.
   */
  const inLine = <E1, R1, P, E2, R2, A, E3, R3>(
    which: Effect.Effect<ConversationId, E1, R1>,
    prepare: (conversationId: ConversationId) => Effect.Effect<P, E2, R2>,
    place: (conversationId: ConversationId, prepared: P) => Effect.Effect<A, E3, R3>,
  ): Effect.Effect<A, E1 | E2 | E3 | SessionError, R1 | R2 | R3> =>
    Effect.uninterruptibleMask((restore) =>
      arriving(
        inArrivalOrder(restore(which).pipe(Effect.map((key) => ({ key, place: join(key) })))),
      ).pipe(
        Effect.flatMap(({ key, place: line }) => {
          const { member } = line;

          const stopped = Effect.suspend(() => Effect.fail(withdrawn()));

          const cancelled = Deferred.await(member.cancel).pipe(Effect.andThen(stopped));

          // Checked and set in one step under the lock, so Stop either reaches the message first or finds it placing.
          const placed = (prepared: P) =>
            Effect.suspend((): Effect.Effect<A, E3 | SessionError, R3> => {
              if (member.withdrawn) return stopped;

              member.placing = true;

              return place(key, prepared);
            }).pipe(inArrivalOrder);

          const run = Effect.suspend(() =>
            member.withdrawn
              ? stopped
              : Effect.raceFirst(prepare(key), cancelled).pipe(Effect.flatMap(placed)),
          );

          return line.turn.pipe(Effect.andThen(restore(run)), Effect.ensuring(line.leave));
        }),
      ),
    );

  /**
   * Withdraw the messages in conversation `key`'s line that are not being placed: each is cancelled and answers as
   * withdrawn. Done once the ones being placed are, so that a Stop that goes on to abort the conversation finds them
   * queued and withdraws them as it does the rest. Other conversations' lines are untouched.
   */
  const withdraw = (key: ConversationId): Effect.Effect<void> =>
    Effect.suspend(() => {
      const placing: Array<Deferred.Deferred<void>> = [];
      const cancelling: Array<Member> = [];

      for (const member of members.get(key) ?? []) {
        if (member.placing) {
          placing.push(member.left);
        } else {
          member.withdrawn = true;
          cancelling.push(member);
        }
      }

      // After every one is marked: cancelling a message may carry the one behind it on at once.
      for (const member of cancelling) Deferred.doneUnsafe(member.cancel, Effect.void);

      return Effect.forEach(placing, (left) => Deferred.await(left), { discard: true });
    });

  /** `withdraw` for every conversation with a line (Stop all). */
  const withdrawAll: Effect.Effect<void> = Effect.suspend(() =>
    Effect.forEach([...members.keys()], withdraw, { discard: true }),
  );

  /** Whether a message is in line for conversation `key`, not yet placed. */
  const isPreparing = (key: ConversationId): boolean => members.has(key);

  /** Whether a message is in line for any conversation. */
  const anyPreparing = (): boolean => members.size > 0;

  return { inLine, withdraw, withdrawAll, isPreparing, anyPreparing };
};
