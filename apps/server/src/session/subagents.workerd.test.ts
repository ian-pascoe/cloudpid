// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectRecord:off
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { TestSubagentSession } from "./subagents.workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SUBAGENT_SESSIONS: DurableObjectNamespace<TestSubagentSession>;
    }
  }
}

/** Poll `check` inside the object until it holds. */
const eventually = async (
  stub: DurableObjectStub<TestSubagentSession>,
  check: (instance: TestSubagentSession) => Promise<boolean>,
): Promise<void> => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await runInDurableObject(stub, check)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Condition not reached");
};

it("keeps a working subagent and the wait blocked on it through an eviction, and hands the wait the answer", async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

  await runInDurableObject(stub, async (instance: TestSubagentSession, state) => {
    await instance.submit("Delegate it");
    await instance.hanging.promise;
    expect(await state.storage.getAlarm()).not.toBeNull();
  });

  await eventually(
    stub,
    async (instance) => Object.keys((await instance.subagents())?.waiters ?? {}).length === 1,
  );

  // The child may answer once it runs again, in the next instance.
  await runInDurableObject(stub, (instance: TestSubagentSession) => instance.release());
  await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await eventually(stub, (instance) => instance.idle());

  const subagents = await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.subagents(),
  );

  expect(subagents?.agents["agent-1"]?.turns).toMatchObject([
    { id: "turn-1", status: "completed", delivery: "wait" },
  ]);
  expect(subagents?.waiters).toEqual({});

  const results = await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.texts("toolResult"),
  );

  expect(results[0]).toMatch(/^Spawned agent-1 \(turn turn-1\)/);
  expect(results[1]).toMatch(/^agent-1 turn-1 completed \([\d.]+s\)\n\nThe answer is 42\.$/);
  // The wait claimed the answer, so it was not also reported as a follow-up.
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) => instance.texts("user")),
  ).toEqual(["Delegate it"]);
});

it("keeps a working subagent through an eviction, and reports its answer as a follow-up when nobody waits", async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

  await runInDurableObject(stub, async (instance: TestSubagentSession) => {
    await instance.submit("Delegate quietly");
    await instance.hanging.promise;
  });

  await runInDurableObject(stub, (instance: TestSubagentSession) => instance.release());
  await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await eventually(stub, (instance) => instance.idle());

  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) => instance.texts("user")),
  ).toEqual([
    "Delegate quietly",
    "[Subagent result | agent=agent-1 | turn=turn-1 | status=completed]\nThe answer is 42.",
  ]);
});
