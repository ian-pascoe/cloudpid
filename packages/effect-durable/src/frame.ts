// The async context a piece of work runs in. Workers tracing nests a span under whichever span is active in the
// current async context, and Effect runs fibers on a scheduler that does not keep it, so a fiber is run in the frame
// it was started from (`CallerFrame`), or in that of its current span's native span.
import { AsyncLocalStorage } from "node:async_hooks";
import * as Context from "effect/Context";

/** Runs a function in a captured async context. */
export type Frame = <R>(run: () => R) => R;

/** The async context to run a fiber's steps in while no span of its own is current. */
export const CallerFrame = Context.Reference<Frame | undefined>("@cloudpid/telemetry/CallerFrame", {
  defaultValue: () => undefined,
});

/** The current async context, to be run in later. */
export const captureFrame = (): Frame => AsyncLocalStorage.snapshot();
