// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectRecord:off
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Arr from "effect/Array";
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

/** Start a child that hangs on its first request, by a root that answers once it has delegated. */
const delegateQuietly = async (stub: DurableObjectStub<TestSubagentSession>) => {
  await runInDurableObject(stub, async (instance: TestSubagentSession) => {
    await instance.submit("Delegate quietly");
    await instance.hanging.promise;
  });

  const state = await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.subagents(),
  );

  const child = state?.agents["agent-1"]?.conversationId;

  if (child === undefined) throw new Error("No child was started");

  return child;
};

/** Poll until the child's only turn has settled with `status`. */
const turnSettled = (stub: DurableObjectStub<TestSubagentSession>, status: string) =>
  eventually(
    stub,
    async (instance) =>
      (await instance.subagents())?.agents["agent-1"]?.turns.at(-1)?.status === status,
  );

it("lets the owner abort one subagent: its turn ends aborted and the root is left alone", async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());
  const child = await delegateQuietly(stub);

  await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.abort({ conversationId: child }),
  );
  await turnSettled(stub, "aborted");

  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) => instance.subagents()),
  ).toMatchObject({ agents: { "agent-1": { turns: [{ status: "aborted", delivery: "none" }] } } });
  // Nothing was reported to the root, which saw only what the owner said.
  await eventually(stub, (instance) => instance.idle());
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) => instance.texts("user")),
  ).toEqual(["Delegate quietly"]);
});

it("refuses owner input to, and an abort of, a conversation that is neither the root nor a subagent's", async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());
  const child = await delegateQuietly(stub);
  // SAFETY: only a number the Session never gave out is used, to see it refused; it is not looked up as a branded ID.
  const stranger = (child + 40) as typeof child;

  await expect(
    runInDurableObject(stub, (instance: TestSubagentSession) =>
      instance.submitTo(stranger, "Hello"),
    ),
  ).rejects.toThrow(/not the root or a subagent/);
  await expect(
    runInDurableObject(stub, (instance: TestSubagentSession) =>
      instance.abort({ conversationId: stranger }),
    ),
  ).rejects.toThrow(/not the root or a subagent/);
  // The subagent is untouched.
  expect(
    (await runInDurableObject(stub, (instance: TestSubagentSession) => instance.subagents()))
      ?.agents["agent-1"]?.turns[0]?.status,
  ).toBe("running");
});

it("stops the root without its subagents, and with them when asked", async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

  await delegateQuietly(stub);
  await runInDurableObject(stub, (instance: TestSubagentSession) => instance.abort());

  // The child still works.
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) =>
      instance.taskGraph((graph) => graph.agents[0]?.status === "working"),
    ),
  ).toMatchObject({ agents: [{ id: "agent-1", parent: "root", status: "working" }] });

  await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.abort({ subagents: true }),
  );
  await turnSettled(stub, "aborted");
  await eventually(stub, (instance) => instance.idle());
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) => instance.texts("user")),
  ).toEqual(["Delegate quietly"]);
});

it("runs the owner's input to an idle subagent in its conversation, without reporting its answer to the root", async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

  // The child answers at once, and its answer reaches the root as a follow-up.
  await runInDurableObject(stub, async (instance: TestSubagentSession) => {
    instance.release();
    await instance.submit("Delegate quietly");
  });
  await eventually(stub, async (instance) => (await instance.texts("user")).length === 2);
  await eventually(stub, (instance) => instance.idle());

  const state = await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.subagents(),
  );

  const child = state!.agents["agent-1"]!.conversationId;

  const reports = await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.texts("user"),
  );

  await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.submitTo(child, "A word from the owner"),
  );
  await eventually(stub, async (instance) => (await instance.texts("user", child)).length === 2);
  await eventually(stub, (instance) => instance.idle());

  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) =>
      instance.texts("user", child),
    ),
  ).toContain("A word from the owner");
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) =>
      instance.texts("assistant", child),
    ),
  ).toEqual(["The answer is 42.", "The answer is 42."]);
  // The root heard nothing new.
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) => instance.texts("user")),
  ).toEqual(reports);
});

it("streams the task graph: a subagent working, then idle once it is stopped, with no bookkeeping among the background work", async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

  await delegateQuietly(stub);
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) =>
      instance.taskGraph((graph) => graph.agents[0]?.status === "working"),
    ),
  ).toMatchObject({ background: [] });
  await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.abort({ subagents: true }),
  );
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) =>
      instance.taskGraph((graph) => graph.agents[0]?.status === "idle"),
    ),
  ).toMatchObject({ agents: [{ id: "agent-1", role: null }], background: [] });
});

it("runs the owner's input into a child's run that a parent turn waits on, and gives the wait the one answer", async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

  await runInDurableObject(stub, async (instance: TestSubagentSession) => {
    await instance.submit("Delegate it");
    await instance.hanging.promise;
  });
  await eventually(
    stub,
    async (instance) => Object.keys((await instance.subagents())?.waiters ?? {}).length === 1,
  );

  const child = (await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.subagents(),
  ))!.agents["agent-1"]!.conversationId;

  // The owner speaks while the run the root waits on is going, and then the child answers.
  await runInDurableObject(stub, async (instance: TestSubagentSession) => {
    await instance.submitTo(child, "A word from the owner");
    instance.release();
    instance.answerChild();
  });
  await eventually(stub, (instance) => instance.idle());

  const subagents = await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.subagents(),
  );

  expect(subagents?.agents["agent-1"]?.turns).toMatchObject([
    { id: "turn-1", status: "completed", delivery: "wait" },
  ]);
  expect(subagents?.waiters).toEqual({});
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) =>
      instance.texts("user", child),
    ),
  ).toContain("A word from the owner");

  const results = await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.texts("toolResult"),
  );

  // One answer, claimed by the wait, and not reported to the root again.
  expect(results[1]).toMatch(/^agent-1 turn-1 completed \([\d.]+s\)\n\nThe answer is 42\.$/);
  expect(
    await runInDurableObject(stub, (instance: TestSubagentSession) => instance.texts("user")),
  ).toEqual(["Delegate it"]);
});

it("stops everything below the root, a grandchild too, and the Session goes idle", async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

  await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.submit("Delegate deep"),
  );
  // The child starts a subagent of its own, which hangs.
  await eventually(
    stub,
    async (instance) => Object.keys((await instance.subagents())?.agents ?? {}).length === 2,
  );
  await eventually(stub, async (instance) => {
    const agents = Object.values((await instance.subagents())?.agents ?? {});

    return (
      agents.length === 2 && Arr.every(agents, (agent) => agent.turns.at(-1)?.status === "running")
    );
  });

  await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.abort({ subagents: true }),
  );
  await eventually(stub, (instance) => instance.idle());

  const agents = Object.values(
    (await runInDurableObject(stub, (instance: TestSubagentSession) => instance.subagents()))
      ?.agents ?? {},
  );

  expect(agents).toHaveLength(2);

  for (const agent of agents) {
    expect(agent.turns.at(-1)).toMatchObject({ status: "aborted", delivery: "none" });
  }
});
