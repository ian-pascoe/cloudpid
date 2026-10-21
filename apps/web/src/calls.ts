// A call of a shared function atom that answers its own caller. A `concurrent` fn atom keeps one result for all its
// callers, and while two calls overlap that result is the earlier one's, so a caller that awaited the result could get
// another call's answer. A `Call` carries its argument with a Deferred that its own run completes, however it ends.

import { RegistryContext, useAtomMount } from "@effect/atom-react";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import type * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { use } from "react";

/** One call: its argument, and the outcome of the run it started. */
export interface Call<Arg, A, E> {
  readonly arg: Arg;
  readonly outcome: Deferred.Deferred<A, E>;
}

/** A call of `arg` whose outcome is still to come. */
export const callOf = <Arg, A = never, E = never>(arg: Arg): Call<Arg, A, E> => ({
  arg,
  outcome: Deferred.makeUnsafe<A, E>(),
});

/** `f` as the body of a fn atom written with calls: each run completes its call's outcome with how it ended. */
export const replying =
  <Arg, A, E, R, Context>(f: (arg: Arg, get: Context) => Effect.Effect<A, E, R>) =>
  (call: Call<Arg, A, E>, get: Context): Effect.Effect<A, E, R> =>
    f(call.arg, get).pipe(Effect.onExit((exit) => Deferred.done(call.outcome, exit)));

/** Call fn atom `atom` of `registry` with `arg`; resolves to how that call's own run ended. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a promise for React callers, not an Effect
export const callIn = <Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Writable<unknown, Call<Arg, A, E>>,
  arg: Arg,
): Promise<Exit.Exit<A, E>> => {
  const call = callOf<Arg, A, E>(arg);

  registry.set(atom, call);

  return call.outcome.pipe(Deferred.await, Effect.runPromiseExit);
};

/**
 * Calls of fn atom `atom`, each resolving to how its own run ended. The atom stays mounted while the component is, and
 * an unmount interrupts the runs, which then resolve as interrupted.
 */
export const useCall = <Arg, A, E>(
  atom: Atom.Writable<unknown, Call<Arg, A, E>>,
): ((arg: Arg) => Promise<Exit.Exit<A, E>>) => {
  const registry = use(RegistryContext);

  useAtomMount(atom);

  return (arg) => callIn(registry, atom, arg);
};
