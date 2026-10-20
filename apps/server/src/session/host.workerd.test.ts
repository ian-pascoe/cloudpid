// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestSession } from "./host.fixture.ts";

const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

/** Poll `check` inside the object until it holds. */
const eventually = async (
  stub: DurableObjectStub<TestSession>,
  check: (state: DurableObjectState) => Promise<boolean>,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await runInDurableObject(stub, (_instance: TestSession, state) => check(state))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Condition not reached");
};

describe("a Session host", () => {
  it("resumes a run cut off by an eviction from its heartbeat alarm and answers", async () => {
    const stub = fresh();

    await runInDurableObject(stub, async (instance: TestSession, state) => {
      instance.script(["hang", "recovered"]);
      await instance.submit({ requestId: "turn-1", text: "hi" });
      await instance.hanging.promise;
      // The heartbeat was armed before the input was admitted.
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const answer = await runInDurableObject(stub, (instance: TestSession) =>
      instance.prompt({ requestId: "turn-1", text: "hi" }),
    );

    expect(answer).toMatchObject({ status: "answered", text: "recovered" });
    // Nothing is left to do: the heartbeat is gone.
    await eventually(stub, async (state) => (await state.storage.getAlarm()) === null);
  });

  it("admits a prompt submitted twice with one request id once", async () => {
    const stub = fresh();

    const [first, second] = await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["first", "second"]);

      return [
        await instance.prompt({ requestId: "turn-1", text: "hi" }),
        await instance.prompt({ requestId: "turn-1", text: "hi" }),
      ];
    });

    expect(first).toMatchObject({ status: "answered", text: "first" });
    expect(second).toEqual(first);
  });
});
