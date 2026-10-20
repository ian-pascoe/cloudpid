// Effect-defined pi-durable hooks (ADR-0003): each handler is an Effect run with the services of the Effect that builds
// the hook, and interrupted when pi-durable cancels the invocation.
import type * as Chord from "@earendil-works/chord/context";
import {
  type AnyTask,
  type CompactionHooks,
  type GenerationHooks,
  hook,
  type HookRegistration,
  type HooksOf,
  type ToolHooks,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import { invoker, settle } from "./chord.ts";

/**
 * A task's hook handlers as Effects: each takes the handler's arguments without the trailing Chord `Context`, which
 * becomes the fiber's `ChordContext`, and succeeds with what the handler returns.
 */
export type EffectHooks<Hooks> = {
  readonly [Name in keyof Hooks]?: Hooks[Name] extends (...args: infer Args) => infer Output
    ? Args extends readonly [...infer Params, Chord.Context]
      ? (...params: Params) => Effect.Effect<Awaited<Output>, unknown, unknown>
      : never
    : never;
};

/** The failures and the services of `handlers`' Effects. */
type Channels<Handlers> = {
  readonly [Name in keyof Handlers]-?: Handlers[Name] extends (
    ...params: never
  ) => Effect.Effect<infer _A, infer E, infer R>
    ? { readonly failure: E; readonly services: R }
    : never;
}[keyof Handlers];

/** A built-in task's hook handler; the adapter forwards its arguments and result without looking at them. */
type BuiltInHandler =
  | GenerationHooks[keyof GenerationHooks]
  | ToolHooks[keyof ToolHooks]
  | CompactionHooks[keyof CompactionHooks];

type HookArgument = Parameters<BuiltInHandler>[number];

type Handler<E, R> = (
  ...params: readonly HookArgument[]
) => Effect.Effect<Awaited<ReturnType<BuiltInHandler>>, E, R>;

/**
 * pi-durable hooks of `task` from Effect handlers, run with the services of the Effect that builds them. A handler's
 * failure or defect is thrown, which pi-durable treats as each hook documents: a throwing `beforeTool` blocks the call.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- as pi-durable's `hook()`: the task types the handlers.
export const effectHook = <K extends AnyTask, Handlers extends EffectHooks<HooksOf<K>>>(
  task: K,
  handlers: Handlers,
): Effect.Effect<HookRegistration, never, Channels<Handlers>["services"]> =>
  Effect.map(Effect.context<Channels<Handlers>["services"]>(), (services) => {
    const invoke = invoker(services);

    // SAFETY: `EffectHooks` derived each handler from one of `task`'s hooks, which take the Chord `Context` last.
    const effects = handlers as Readonly<
      Record<string, Handler<Channels<Handlers>["failure"], Channels<Handlers>["services"]>>
    >;

    const adapted = Record.map(effects, (handler) => (...args: readonly HookArgument[]) => {
      // SAFETY: pi-durable passes every hook handler the invocation's Chord `Context` last.
      const context = args.at(-1) as Chord.Context;

      return invoke(handler(...args.slice(0, -1)), context).then(settle);
    });

    // SAFETY: each adapted handler takes the arguments and returns the result of the hook it was derived from.
    return hook(task, adapted as Partial<HooksOf<K>>);
  });
