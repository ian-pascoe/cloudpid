// Effect-defined pi-durable tasks (ADR-0003): each phase is an Effect run with the services of the Effect that builds
// the task, and interrupted when pi-durable cancels the invocation. Checkpoints and commits stay native: a phase
// commits through `runtime`, and Effect never schedules.
import type * as Chord from "@earendil-works/chord/context";
import {
  defineTask,
  type NextTaskState,
  type RunningTask,
  type Task,
  type TaskDefinition,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type Failure, invoker, settleTyped } from "./chord.ts";
import { HarnessError } from "./Harness.ts";

/** What an Effect task may fail with: its message becomes the `failed` outcome's error. */
export type TaskFailure = Failure;

/**
 * A task whose phases, and abort handler, are Effects. Each takes the arguments of the native handler without its
 * trailing Chord `Context`, which becomes the fiber's `ChordContext`; a handler commits through `runtime` as a native
 * one does, for example with `callDurable`.
 *
 * A typed failure settles the task `failed` with its message, as pi-durable's docs call an expected failure the
 * implementation commits. A defect is thrown, which settles the task `faulted` as any throw does; so is a
 * `HarnessError`, which `callDurable` (and so the Harness facade) fails with when pi-durable rejects a call, such as a
 * `runtime.commit` that throws or a storage error. Those are contract failures, not the task's expected ones, so a
 * phase need not `orDie` them. An Effect interrupted because the task was aborted is thrown too, and the abort handler
 * settles the task.
 */
export type EffectTaskDefinition<
  I,
  S extends { phase: string },
  R,
  H extends object,
  E extends TaskFailure,
  Services,
> = Omit<TaskDefinition<I, S, R, H>, "phases" | "abort"> & {
  readonly phases: {
    readonly [P in S["phase"]]: (
      task: RunningTask<I, Extract<S, { phase: P }>, R>,
      runtime: TaskRuntime<I, S, R, H>,
    ) => Effect.Effect<void, E, Services>;
  };
  /**
   * Runs in a fresh invocation after an abort mark and must commit a terminal outcome. pi-durable requires it so that
   * every task decides how it is cancelled; this adapter defaults to the common answer, committing `aborted`, so only a
   * task with something to clean up or a reason to record writes one.
   */
  readonly abort?: (
    task: RunningTask<I, S, R>,
    runtime: TaskRuntime<I, S, R, H>,
  ) => Effect.Effect<void, E, Services>;
};

const isHarnessError = Schema.is(HarnessError);

const aborted = <S, R>(): NextTaskState<S, R> => ({
  status: "terminal",
  outcome: { status: "aborted" },
});

/**
 * A pi-durable task from an Effect definition, run with the services of the Effect that builds it. The fiber of a phase
 * is interrupted when pi-durable cancels the invocation, for example on `abortTask()` or when the Harness closes.
 */
export const effectTask = <
  I,
  S extends { phase: string },
  R,
  E extends TaskFailure,
  Services = never,
  H extends object = object,
>(
  definition: EffectTaskDefinition<I, S, R, H, E, Services>,
): Effect.Effect<Task<I, S, R, H>, never, Services> =>
  Effect.map(Effect.context<Services>(), (services) => {
    const invoke = invoker(services);
    const { phases, abort, ...rest } = definition;

    /** Runs `effect` as the body of an invocation: its typed failure settles the task `failed`. */
    // @effect-diagnostics-next-line asyncFunction:off -- the body of a native phase, which pi-durable awaits.
    const run = async (
      effect: Effect.Effect<void, E, Services>,
      runtime: TaskRuntime<I, S, R, H>,
      context: Chord.Context,
    ): Promise<void> => {
      const settled = settleTyped(await invoke(effect, context), context);

      if (Result.isSuccess(settled)) return;

      // A rejected pi-durable call is a contract failure, which faults the task as a native throw does.
      if (isHarnessError(settled.failure)) throw settled.failure;

      const { message } = settled.failure;

      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "failed", error: { message } } }),
        context,
      );
    };

    // SAFETY: `phases` has one handler per phase of `S`, which the task runs with the checkpoint narrowed to it.
    const adapted = Record.map(
      phases as Readonly<
        Record<
          string,
          (
            task: RunningTask<I, S, R>,
            runtime: TaskRuntime<I, S, R, H>,
          ) => Effect.Effect<void, E, Services>
        >
      >,
      (handler) =>
        (task: RunningTask<I, S, R>, runtime: TaskRuntime<I, S, R, H>, context: Chord.Context) =>
          run(handler(task, runtime), runtime, context),
    ) as TaskDefinition<I, S, R, H>["phases"];

    return defineTask({
      ...rest,
      phases: adapted,
      abort: (task, runtime, context) =>
        abort === undefined
          ? runtime.commit(() => aborted(), context)
          : run(abort(task, runtime), runtime, context),
    });
  });
