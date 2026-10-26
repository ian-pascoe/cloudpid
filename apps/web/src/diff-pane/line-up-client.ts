// The page's side of the line-up worker (`line-up.worker.ts`): each pair asked under an ID and answered under it. A
// worker that fails (its script gone after a deploy, an error it did not catch) is dropped, the pairs it held fail, and
// the next pair starts a new one. A pair that has no answer within `LINE_UP_WATCHDOG` (the worker is stuck: jsdiff's own
// budget is 2 s) fails, and the worker is replaced, the other pairs it held asked again of the new one.
// @effect-diagnostics missingPipeableSignature:off -- a constructor over a worker, not a combinator.

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { LineUp, LineUpRequest } from "./line-up.ts";

/** What the worker answers: a pair's ID and its lined-up patch. */
const Answer = Schema.Struct({
  id: Schema.Finite,
  result: Schema.Struct({ patch: Schema.String, replaced: Schema.Boolean }),
});

const decodeAnswer = Schema.decodeUnknownOption(Answer);

/** How long a pair may wait for its answer before the worker is taken to be stuck. */
export const LINE_UP_WATCHDOG = Duration.seconds(20);

/** Why a pair was not lined up. */
export class LineUpFailed extends Schema.TaggedError<
  LineUpFailed,
  { readonly brand: unique symbol }
>()("LineUpFailed", { message: Schema.String }) {}

/** What the client needs of a worker: `Worker`, or a test's fake. */
export interface WorkerLike {
  readonly postMessage: (message: { readonly id: number; readonly request: LineUpRequest }) => void;
  readonly terminate: () => void;
  readonly addEventListener: (
    type: "message" | "error",
    listener: (event: { readonly data?: unknown }) => void,
  ) => void;
}

/** Lines file pairs up off the page. */
export interface LineUpClient {
  readonly lineUp: (request: LineUpRequest) => Effect.Effect<LineUp, LineUpFailed>;
  /** Shut the worker; the pairs it held fail. */
  readonly terminate: () => void;
}

interface Waiting {
  readonly request: LineUpRequest;
  readonly resume: (effect: Effect.Effect<LineUp, LineUpFailed>) => void;
}

/** A client of the workers `spawn` makes, one at a time. */
export const lineUpClient = (
  spawn: () => WorkerLike,
  watchdog: Duration.Input = LINE_UP_WATCHDOG,
): LineUpClient => {
  const waiting = new Map<number, Waiting>();
  let worker: WorkerLike | undefined;
  let asked = 0;

  const fail = (ids: Iterable<number>, message: string) => {
    for (const id of ids) {
      const held = waiting.get(id);

      waiting.delete(id);
      held?.resume(Effect.fail(LineUpFailed.make({ message })));
    }
  };

  const start = (): WorkerLike => {
    const started = spawn();

    started.addEventListener("message", (event) => {
      const answer = decodeAnswer(event.data);

      if (started !== worker || Option.isNone(answer)) return;

      const { id, result } = answer.value;
      const held = waiting.get(id);

      waiting.delete(id);
      held?.resume(Effect.succeed(result));
    });
    started.addEventListener("error", () => {
      if (started !== worker) return;

      // Dead: whatever it held fails, and the next pair starts another.
      started.terminate();
      worker = undefined;
      fail(waiting.keys(), "The line-up worker failed.");
    });

    return started;
  };

  const current = (): WorkerLike => {
    worker ??= start();

    return worker;
  };

  /** Replace a stuck worker (pair `stuck` waits no more): the others it held are asked of the new one. */
  const replace = (stuck: number) => {
    worker?.terminate();
    worker = undefined;
    waiting.delete(stuck);

    for (const [id, { request }] of waiting) current().postMessage({ id, request });
  };

  return {
    lineUp: (request) =>
      Effect.suspend(() => {
        asked += 1;

        const id = asked;

        return Effect.callback<LineUp, LineUpFailed>((resume) => {
          waiting.set(id, { request, resume });
          current().postMessage({ id, request });

          // Not waited for any more (the file scrolled away, or the watchdog): its answer is dropped.
          return Effect.sync(() => {
            waiting.delete(id);
          });
        }).pipe(
          Effect.timeoutOrElse({
            duration: watchdog,
            orElse: () =>
              Effect.sync(() => {
                replace(id);
              }).pipe(
                Effect.andThen(
                  Effect.fail(LineUpFailed.make({ message: "Lining the file up did not finish." })),
                ),
              ),
          }),
        );
      }),
    terminate: () => {
      worker?.terminate();
      worker = undefined;
      fail(waiting.keys(), "The line-up worker was shut.");
    },
  };
};
