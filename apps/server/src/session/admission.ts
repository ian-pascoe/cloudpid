// The lines an owner's messages wait in before they are placed: one per conversation, so a message that is slow to
// prepare holds back only the ones sent after it to the same conversation (docs/architecture/mcp-in-a-session.md →
// Getting a prompt at send). The Session's lock (`inArrivalOrder`) is not held while a message waits or prepares. Stop
// withdraws the messages in a conversation's line that are not yet being placed (same section).
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import { type SessionError, withdrawnFailure } from "./errors.ts";

/**
 * Where a message in a line stands: `in-line` while it waits its turn or is prepared, `placing` once it holds the lock to
 * be placed (Stop leaves it, and withdraws it as queued input once it is placed), `withdrawn` once Stop reached it first
 * (it places nothing).
 */
type MemberState = "in-line" | "placing" | "withdrawn";

/** A message in a line. */
type Member = {
  /** Done when the message has left the line, however it ended. */
  readonly left: Deferred.Deferred<void>;
  /** Done when Stop withdraws the message: whatever it is preparing is cancelled. */
  readonly cancel: Deferred.Deferred<void>;
  /** The `requestId` it was sent under, if any: kept when it is withdrawn, so a resend is withdrawn too. */
  readonly requestId: string | undefined;
  state: MemberState;
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
export const admissionLines = (options: {
  readonly inArrivalOrder: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Keep `requestId` of a withdrawn message, so that sent again it is withdrawn again. Never failing. */
  readonly remember: (requestId: string) => Effect.Effect<void>;
}) => {
  const { inArrivalOrder, remember } = options;

  // Messages take their place in line one at a time, so two that arrive together are in line in the order they arrived,
  // though the read that tells which conversation each is for may finish in either.
  const arriving = Semaphore.withPermit(Semaphore.makeUnsafe(1));

  /** The last of each line: the message a new one waits for. */
  const tails = new Map<ConversationId, Deferred.Deferred<void>>();

  /** The messages in line, being prepared or being placed, for each conversation. */
  const members = new Map<ConversationId, Set<Member>>();

  // A message that has been sent but has not joined its line is still on its way: it waits for the lock, which a
  // `navigate` may hold across a summary, and only then knows its conversation. Each Stop is counted, and where it
  // reached which conversation is kept while a message is on its way, so such a message sent before the Stop joins
  // withdrawn.
  let stops = 0;
  let onTheirWay = 0;
  const stoppedAt = new Map<ConversationId, number>();

  // Synchronous, so that taking a place is one step with being first or last in line. `seen` is the stop count when the
  // message was sent.
  const join = (key: ConversationId, seen: number, requestId: string | undefined): Place => {
    const previous = tails.get(key);

    const member: Member = {
      left: Deferred.makeUnsafe<void>(),
      cancel: Deferred.makeUnsafe<void>(),
      requestId,
      state: (stoppedAt.get(key) ?? 0) > seen ? "withdrawn" : "in-line",
    };

    if (member.state === "withdrawn") Deferred.doneUnsafe(member.cancel, Effect.void);

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

  /** A message has joined its line, or failed on its way. */
  const arrived = Effect.sync(() => {
    onTheirWay -= 1;

    if (onTheirWay === 0) stoppedAt.clear();
  });

  /**
   * Run `prepare` in the line of the conversation `which` finds, after every message that joined it earlier has left,
   * then `place` under `inArrivalOrder`, and let the next message go when it ends. The conversation is found, and the
   * line joined, under `inArrivalOrder`: a message sent while the Session tree moves is for the branch it moved to, and
   * is in line before any sent after it. Until it ends the conversation counts as being prepared for (`isPreparing`),
   * which keeps the tree where it is. A message interrupted while it waits still waits for its turn and for the lock,
   * so the ones behind it never get ahead of the ones before it.
   *
   * A message `withdrawLine` reached before it is placed (or sent before it, though it joined its line after) fails as
   * `withdrawnFailure()`: what it was preparing is cancelled, it places nothing, and it still waits for its turn to
   * leave, so the ones behind it keep their order.
   */
  const inLine = <E1, R1, P, E2, R2, A, E3, R3>(
    which: Effect.Effect<ConversationId, E1, R1>,
    prepare: (conversationId: ConversationId) => Effect.Effect<P, E2, R2>,
    place: (conversationId: ConversationId, prepared: P) => Effect.Effect<A, E3, R3>,
    requestId?: string,
  ): Effect.Effect<A, E1 | E2 | E3 | SessionError, R1 | R2 | R3> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const seen = stops;

        // Inside the mask, so that an interrupt cannot come between counting the message and the `arrived` that ends it.
        onTheirWay += 1;

        return arriving(
          inArrivalOrder(
            restore(which).pipe(Effect.map((key) => ({ key, line: join(key, seen, requestId) }))),
          ),
        ).pipe(
          Effect.ensuring(arrived),
          Effect.flatMap(({ key, line }) => {
            const { member } = line;

            const withdrawnFail = Effect.suspend(() => Effect.fail(withdrawnFailure()));

            const cancelled = Deferred.await(member.cancel).pipe(Effect.andThen(withdrawnFail));

            // Checked and set in one step under the lock, so Stop either reaches the message first or finds it placing.
            const placed = (prepared: P) =>
              Effect.suspend((): Effect.Effect<A, E3 | SessionError, R3> => {
                if (member.state === "withdrawn") return withdrawnFail;

                member.state = "placing";

                return place(key, prepared);
              }).pipe(inArrivalOrder);

            const run = Effect.suspend(() =>
              member.state === "withdrawn"
                ? withdrawnFail
                : Effect.raceFirst(prepare(key), cancelled).pipe(Effect.flatMap(placed)),
            );

            // Withdrawn on joining (a Stop reached its conversation after it was sent): remembered here, as `withdrawLine`
            // remembers the ones it reaches, with no wait that an interrupt could cut short.
            const remembered =
              member.state === "withdrawn" && requestId !== undefined
                ? remember(requestId)
                : Effect.void;

            return remembered.pipe(
              Effect.andThen(line.turn),
              Effect.andThen(restore(run)),
              Effect.ensuring(line.leave),
            );
          }),
        );
      }),
    );

  /**
   * Withdraw the messages in conversation `key`'s line that are not being placed, and the ones sent before this Stop
   * that are still on their way to it: each is cancelled and fails as withdrawn. Done once the ones being placed are, so
   * that a Stop that goes on to abort the conversation finds them queued and withdraws them as it does the rest. Other
   * conversations' lines are untouched.
   */
  const withdrawLine = (key: ConversationId): Effect.Effect<void> =>
    Effect.suspend(() => {
      stops += 1;

      if (onTheirWay > 0) stoppedAt.set(key, stops);

      const placing: Array<Deferred.Deferred<void>> = [];
      const reached: Array<Member> = [];
      const toRemember: Array<string> = [];

      for (const member of members.get(key) ?? []) {
        if (member.state === "placing") placing.push(member.left);

        if (member.state === "in-line") {
          member.state = "withdrawn";
          reached.push(member);

          if (member.requestId !== undefined) toRemember.push(member.requestId);
        }
      }

      // After every one is marked: cancelling a message may carry the one behind it on at once.
      for (const member of reached) Deferred.doneUnsafe(member.cancel, Effect.void);

      // Remembered here, not by each message as it ends: a submitter interrupted meanwhile must not skip it.
      return Effect.forEach(toRemember, remember, { discard: true }).pipe(
        Effect.andThen(Effect.forEach(placing, (left) => Deferred.await(left), { discard: true })),
      );
    });

  /** Whether a message is in line for conversation `key`, not yet placed. */
  const isPreparing = (key: ConversationId): boolean => members.has(key);

  /** Whether a message is in line for any conversation. */
  const anyPreparing = (): boolean => members.size > 0;

  return { inLine, withdrawLine, isPreparing, anyPreparing };
};
