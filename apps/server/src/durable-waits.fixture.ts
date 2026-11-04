// Waiting, in a workerd test, for a Durable Object to reach a state read inside it (docs/development/workers.md →
// workerd tests), on the test's deadline as `poll` waits.
// @effect-diagnostics missingPipeableSignature:off
import { runInDurableObject } from "cloudflare:test";
import { poll } from "./poll.fixture.ts";

/** Wait until `check`, run inside `stub`'s object, holds; if it never does, fail saying `failure`. */
export const eventually = <O extends Rpc.DurableObjectBranded>(
  stub: DurableObjectStub<O>,
  check: (instance: O, state: DurableObjectState) => boolean | Promise<boolean>,
  failure = "Condition not reached",
): Promise<void> =>
  poll(
    () => runInDurableObject(stub, check),
    () => failure,
  );

/** Wait until `stub`'s object (a Session) has no work live; if it never has, fail saying `failure`. */
export const idle = <O extends Rpc.DurableObjectBranded & { idle(): Promise<boolean> }>(
  stub: DurableObjectStub<O>,
  failure = "Never idle",
): Promise<void> => eventually(stub, (instance) => instance.idle(), failure);
