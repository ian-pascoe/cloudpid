// Chord `Context` ↔ Effect fibers (ADR-0003). pi-durable passes every invocation a Chord `Context` whose abort signal
// cancels it; the fiber that runs an invocation's Effect is interrupted by that signal and sees the Context as
// `ChordContext`, so pi-durable calls it makes inherit both the Context's values and its cancellation.
import * as Chord from "@earendil-works/chord/context";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Tracer from "effect/Tracer";

/** The Chord `Context` of the pi-durable invocation this fiber runs for; outside one, the background context. */
export const ChordContext = Context.Reference<Chord.Context>(
  "@cloudpid/effect-durable/ChordContext",
  { defaultValue: () => Chord.BACKGROUND_CONTEXT },
);

/**
 * Runs Effects with `services` for pi-durable invocations: each fiber sees the invocation's Chord `Context` as
 * `ChordContext` and is interrupted when that Context is cancelled. The span `services` were captured in, such as the
 * startup span that built a tool, is dropped: an invocation is not part of it.
 */
export const invoker = <R>(services: Context.Context<R>) => {
  // SAFETY: Effects read the parent span optionally, for tracing; none needs it as a service of its own.
  const detached = Context.omit(Tracer.ParentSpan)(services) as Context.Context<R>;

  return <A, E>(effect: Effect.Effect<A, E, R>, context: Chord.Context): Promise<Exit.Exit<A, E>> =>
    Effect.runPromiseExitWith(detached)(Effect.provideService(effect, ChordContext, context), {
      signal: context.abortSignal,
    });
};

/** An invocation's value, or its failure, defect, or interruption thrown, for pi-durable code that awaits it. */
export const settle = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isSuccess(exit)) return exit.value;

  throw Cause.squash(exit.cause);
};
