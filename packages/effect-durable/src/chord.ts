// Chord `Context` ↔ Effect fibers (ADR-0003). pi-durable passes every invocation a Chord `Context` whose abort signal
// cancels it; the fiber that runs an invocation's Effect is interrupted by that signal and sees the Context as
// `ChordContext`, so pi-durable calls it makes inherit both the Context's values and its cancellation.
import * as Chord from "@earendil-works/chord/context";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Tracer from "effect/Tracer";
import { CallerFrame, captureFrame } from "./frame.ts";

/** What an adapted Effect may fail with: its message is what pi-durable records (a tool's error result, a task's `failed` outcome). */
export type Failure = { readonly message: string };

/** The Chord `Context` of the pi-durable invocation this fiber runs for; outside one, the background context. */
export const ChordContext = Context.Reference<Chord.Context>(
  "@cloudpid/effect-durable/ChordContext",
  { defaultValue: () => Chord.BACKGROUND_CONTEXT },
);

/**
 * Runs Effects with `services` for pi-durable invocations: each fiber sees the invocation's Chord `Context` as
 * `ChordContext` and is interrupted when that Context is cancelled. The span `services` were captured in, such as the
 * startup span that built a tool, is dropped: an invocation is not part of it. It runs in the async context it is called
 * from (`CallerFrame`), so the spans it makes nest under the one active where pi-durable called it (a `pi.tool` span, say).
 */
export const invoker = <R>(services: Context.Context<R>) => {
  // SAFETY: Effects read the parent span optionally, for tracing; none needs it as a service of its own.
  const detached = Context.omit(Tracer.ParentSpan)(services) as Context.Context<R>;

  return <A, E>(effect: Effect.Effect<A, E, R>, context: Chord.Context): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExitWith(detached)(
      effect.pipe(
        Effect.provideService(ChordContext, context),
        Effect.provideService(CallerFrame, captureFrame()),
      ),
      { signal: context.abortSignal },
    );
};

/** An invocation's value, or its failure, defect, or interruption thrown, for pi-durable code that awaits it. */
export const settle = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;

  throw Cause.squash(exit.cause);
};

/**
 * An invocation's value, or its typed failure. A defect, even beside a failure, and any failure of an invocation whose
 * Context was cancelled are thrown, so pi-durable records them itself, as a throw or as a cancellation.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- as `settle`: it runs in Promise code.
export const settleTyped = <A, E>(
  exit: Exit.Exit<A, E>,
  context: Chord.Context,
): Result.Result<A, E> => {
  if (Exit.isSuccess(exit)) return Result.succeed(exit.value);

  // Defects win over failures, as in Effect's own error reporting. Since effect 4.0.6 the runtime itself turns every
  // failure of a cause that holds a defect into a defect (a dying finalizer or concurrent sibling, #9433), in the
  // cause's order, so the first defect may be a failure that was demoted. Nothing marks which ones were, so several are
  // thrown together, and the crash is never hidden behind a failure.
  const defects = Arr.map(
    Arr.filter(exit.cause.reasons, Cause.isDieReason),
    (reason) => reason.defect,
  );

  if (defects.length === 1) throw defects[0];

  if (defects.length > 1) {
    throw new AggregateError(
      defects,
      Arr.join(
        Arr.map(defects, (defect) => (defect instanceof Error ? defect.message : String(defect))),
        "\n",
      ),
    );
  }

  const failure = Cause.findErrorOption(exit.cause);

  if (Option.isNone(failure) || context.abortSignal?.aborted === true) {
    throw Cause.squash(exit.cause);
  }

  return Result.fail(failure.value);
};
