// Waiting, in a workerd test, for a Durable Object to reach a state read inside it (docs/development/workers.md →
// workerd tests), on the test's deadline as `poll` waits.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { DEFAULT_RESTART_LIMIT } from "@earendil-works/pi-durable";
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

/**
 * A live tool call of a Session, with the restarts pi-durable counts toward its restart limit, whether it runs now, and
 * whether it is parked.
 */
export type ToolCallTask = {
  readonly id: number;
  readonly restarts: number;
  readonly running: boolean;
  readonly parked: boolean;
};

/** How many restarts in a row pi-durable lets a task make without progress (`settings.restartLimit`, left at its default). */
export const RESTART_LIMIT = DEFAULT_RESTART_LIMIT;

/** More restarts in a row than `RESTART_LIMIT`. */
export const PAST_THE_RESTART_LIMIT = RESTART_LIMIT + 3;

/**
 * Cut `stub`'s Session off `times` times as prod does while a call waits for the owner and nobody looks: the object
 * hibernates (here, an eviction) and its heartbeat alarm starts a new instance, which reruns the call (#647). Each time,
 * wait until `ready` holds of its live tool calls after that restart (counted from 1): the rerun is back where the next
 * cut-off should find it.
 */
export const restartRepeatedly = async <
  O extends Rpc.DurableObjectBranded & { toolCalls(): Promise<ReadonlyArray<ToolCallTask>> },
>(
  stub: DurableObjectStub<O>,
  times: number,
  ready: (calls: ReadonlyArray<ToolCallTask>, restart: number) => boolean,
): Promise<void> => {
  for (let restart = 1; restart <= times; restart += 1) {
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    let calls: ReadonlyArray<ToolCallTask> = [];

    await poll(
      async () => {
        calls = await runInDurableObject(stub, (instance) => instance.toolCalls());

        return ready(calls, restart);
      },
      () => `Not ready after restart ${restart}: ${JSON.stringify(calls)}`,
    );
  }
};

/** Wait until `stub`'s object (a Session) has no work live; if it never has, fail saying `failure`. */
export const idle = <O extends Rpc.DurableObjectBranded & { idle(): Promise<boolean> }>(
  stub: DurableObjectStub<O>,
  failure = "Never idle",
): Promise<void> => eventually(stub, (instance) => instance.idle(), failure);
