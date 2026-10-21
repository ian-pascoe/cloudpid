// pi-durable's Harness is Promise-based, so these tests are too.
// @effect-diagnostics asyncFunction:off
import type { JsonValue } from "@earendil-works/chord";
import type * as Chord from "@earendil-works/chord/context";
import { defineExtension, type Task, type TaskRuntime } from "@earendil-works/pi-durable";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ChordContext } from "./chord.ts";
import { callDurable, type HarnessError } from "./Harness.ts";
import { context, openFauxHarness } from "./harness.fixture.ts";
import { effectTask } from "./task.ts";

/** Who the task greets: a service its phases read. */
class Greeted extends Context.Service<Greeted, string>()(
  "@cloudpid/effect-durable/task.test/Greeted",
) {}

class GreetingRefused extends Schema.TaggedError<
  GreetingRefused,
  { readonly brand: unique symbol }
>()("GreetingRefused", { message: Schema.String }) {}

type GreetState = { phase: "prepare" } | { phase: "greet" };

/** Move a task to the checkpoint of its next phase. */
const advance = (runtime: TaskRuntime<string, GreetState, string, object>, next: GreetState) =>
  callDurable("commit", (chord) =>
    runtime.commit(() => ({ status: "running", checkpoint: next }), chord),
  );

/** Open a Harness with `task` installed and start it, returning the harness and the new task's ID. */
const start = async <I extends JsonValue, S extends { phase: string }, R>(
  task: Task<I, S, R, object>,
  input: I,
) => {
  const { harness, root } = await openFauxHarness(
    [defineExtension({ name: "greeting", tasks: [task] })],
    [],
  );

  const id = await root.commit(
    (tx) => tx.createTask(task, input, { ownership: { kind: "conversation" } }),
    context,
  );

  harness.resume();

  return { harness, id };
};

describe("effectTask", () => {
  it("runs its phase Effects with their services and settles in a real Harness", async () => {
    let seenContext: Chord.Context | undefined;

    const greeting = effectTask<string, GreetState, string, HarnessError, Greeted>({
      name: "test.greeting",
      version: 1,
      initial: () => ({ phase: "prepare" }),
      phases: {
        prepare: (_task, runtime) => advance(runtime, { phase: "greet" }),
        greet: (task, runtime) =>
          Effect.gen(function* () {
            const greeted = yield* Greeted;

            seenContext = yield* ChordContext;

            yield* callDurable("commit", (chord) =>
              runtime.commit(
                () => ({
                  status: "terminal",
                  outcome: {
                    status: "completed",
                    result: `${task.input} greets ${greeted}`,
                  },
                }),
                chord,
              ),
            );
          }),
      },
    }).pipe(Effect.provideService(Greeted, "Ada"));

    const { harness, id } = await start(Effect.runSync(greeting), "Grace");
    const settled = await harness.waitForTask(id, context);

    expect(settled.state.outcome).toEqual({ status: "completed", result: "Grace greets Ada" });
    // The phase's Context is the one pi-durable cancels, not the background one.
    expect(seenContext).not.toBe(context);
    expect(seenContext?.abortSignal?.aborted).toBe(false);
  });

  it("interrupts the running phase's fiber when the task is aborted", async () => {
    const started = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();

    const waiting = effectTask<null, { phase: "wait" }, null, never, never>({
      name: "test.waiting",
      version: 1,
      initial: () => ({ phase: "wait" }),
      phases: {
        wait: () =>
          Effect.sync(() => started.resolve()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())),
          ),
      },
    });

    const { harness, id } = await start(Effect.runSync(waiting), null);

    await started.promise;
    await harness.abortTask(id, context);
    await interrupted.promise;

    const settled = await harness.waitForTask(id, context);

    expect(settled.state.outcome).toEqual({ status: "aborted" });
  });

  it("settles a typed failure as failed with its message", async () => {
    const refusing = effectTask<null, { phase: "greet" }, null, GreetingRefused, never>({
      name: "test.refusing",
      version: 1,
      initial: () => ({ phase: "greet" }),
      phases: {
        greet: () => Effect.fail(GreetingRefused.make({ message: "Nobody to greet" })),
      },
    });

    const { harness, id } = await start(Effect.runSync(refusing), null);
    const settled = await harness.waitForTask(id, context);

    expect(settled.state.outcome).toEqual({
      status: "failed",
      error: { message: "Nobody to greet" },
    });
  });

  it("settles a defect as faulted, as a throw from a native phase does", async () => {
    const crashing = effectTask<null, { phase: "greet" }, null, never, never>({
      name: "test.crashing",
      version: 1,
      initial: () => ({ phase: "greet" }),
      phases: { greet: () => Effect.die(new Error("Greeting crashed")) },
    });

    const { harness, id } = await start(Effect.runSync(crashing), null);
    const settled = await harness.waitForTask(id, context);

    expect(settled.state.outcome).toMatchObject({
      status: "faulted",
      error: { message: "Greeting crashed" },
    });
  });

  it("settles a rejected commit as faulted, not failed, though callDurable fails it with a typed HarnessError", async () => {
    const rejecting = effectTask<null, { phase: "greet" }, null, HarnessError>({
      name: "test.rejecting",
      version: 1,
      initial: () => ({ phase: "greet" }),
      phases: {
        greet: (_task, runtime) =>
          callDurable("commit", (chord) =>
            runtime.commit(() => {
              throw new Error("Commit callback threw");
            }, chord),
          ),
      },
    });

    const { harness, id } = await start(Effect.runSync(rejecting), null);
    const settled = await harness.waitForTask(id, context);

    expect(settled.state.outcome).toMatchObject({
      status: "faulted",
      error: { message: expect.stringContaining("Commit callback threw") },
    });
  });

  it("runs a custom abort Effect with its services and settles as it commits", async () => {
    const started = Promise.withResolvers<void>();

    const cleaning = effectTask<null, { phase: "wait" }, null, HarnessError, Greeted>({
      name: "test.cleaning",
      version: 1,
      initial: () => ({ phase: "wait" }),
      phases: {
        wait: () => Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never)),
      },
      abort: (_task, runtime) =>
        Effect.gen(function* () {
          const greeted = yield* Greeted;

          yield* callDurable("commit", (chord) =>
            runtime.commit(
              () => ({
                status: "terminal",
                outcome: { status: "aborted", reason: `${greeted} left` },
              }),
              chord,
            ),
          );
        }),
    }).pipe(Effect.provideService(Greeted, "Ada"));

    const { harness, id } = await start(Effect.runSync(cleaning), null);

    await started.promise;
    await harness.abortTask(id, context);

    const settled = await harness.waitForTask(id, context);

    expect(settled.state.outcome).toEqual({ status: "aborted", reason: "Ada left" });
  });

  it("settles a typed failure of a custom abort Effect as failed", async () => {
    const started = Promise.withResolvers<void>();

    const stuck = effectTask<null, { phase: "wait" }, null, GreetingRefused>({
      name: "test.stuck",
      version: 1,
      initial: () => ({ phase: "wait" }),
      phases: {
        wait: () => Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never)),
      },
      abort: () => Effect.fail(GreetingRefused.make({ message: "Cannot clean up" })),
    });

    const { harness, id } = await start(Effect.runSync(stuck), null);

    await started.promise;
    await harness.abortTask(id, context);

    const settled = await harness.waitForTask(id, context);

    expect(settled.state.outcome).toEqual({
      status: "failed",
      error: { message: "Cannot clean up" },
    });
  });
});
