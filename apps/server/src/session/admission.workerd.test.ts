// Admitting a message in two steps against real Durable Object storage (docs/architecture/mcp-in-a-session.md → Getting a
// prompt at send): a message is prepared (here, its attached pages are read, held until the test lets them end) outside the
// Session's lock, in a queue per conversation, then placed. A slow preparation holds back neither Stop nor another
// conversation, messages keep their order within each conversation, and the Session tree stays put while one is prepared.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectRecord:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestSubagentSession } from "./subagents.workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SUBAGENT_SESSIONS: DurableObjectNamespace<TestSubagentSession>;
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` inside the object until it holds. */
const eventually = async (
  stub: DurableObjectStub<TestSubagentSession>,
  check: (instance: TestSubagentSession) => Promise<boolean>,
): Promise<void> => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await runInDurableObject(stub, check)) return;
    await sleep(10);
  }

  throw new Error("Condition not reached");
};

/**
 * A Session whose root has started a subagent and whose subagent has answered, so both conversations are idle, with the
 * subagent's conversation.
 */
const withChild = async () => {
  const stub = env.SUBAGENT_SESSIONS.get(env.SUBAGENT_SESSIONS.newUniqueId());

  await runInDurableObject(stub, async (instance: TestSubagentSession) => {
    await instance.submit("Delegate quietly");
    await instance.hanging.promise;
    instance.release();
    instance.answerChild();
  });
  await eventually(
    stub,
    async (instance) =>
      (await instance.subagents())?.agents["agent-1"]?.turns.at(-1)?.status === "completed",
  );
  await eventually(stub, (instance) => instance.idle());

  const state = await runInDurableObject(stub, (instance: TestSubagentSession) =>
    instance.subagents(),
  );

  const child = state?.agents["agent-1"]?.conversationId;

  if (child === undefined) throw new Error("No child was started");

  return { stub, child };
};

/** The texts of the user messages of the root (or of `child`) that were sent by the test: its own, which start with `m`. */
const sent = (instance: TestSubagentSession, child?: Parameters<TestSubagentSession["texts"]>[1]) =>
  instance.texts("user", child).then((texts) => texts.filter((text) => /^[a-z]\d$/.test(text)));

describe("admitting a message", () => {
  it("holds back neither Stop, nor another conversation, nor the lookups while a message is being prepared", async () => {
    const { stub, child } = await withChild();

    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.holdPreparing("a1");

      const slow = instance.submit("a1");

      await sleep(50);

      // Another conversation is admitted meanwhile.
      await instance.submitTo(child, "c1");
      // Stop and a read of the Session go ahead.
      await instance.abort();
      await instance.stopEverything();
      await instance.idle();
      // The message being prepared is not placed yet.
      expect(await sent(instance)).toEqual([]);

      instance.finishPreparing("a1");
      await slow;
    });
    await eventually(stub, (instance) => instance.idle());

    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance)),
    ).toEqual(["a1"]);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance, child)),
    ).toEqual(["c1"]);
  });

  it("keeps the order of each conversation's messages, whichever conversation's preparation is slow", async () => {
    const { stub, child } = await withChild();

    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.holdPreparing("a1");
      instance.holdPreparing("c1");

      const root = [instance.submit("a1"), instance.submit("a2"), instance.submit("a3")];
      const sub = [instance.submitTo(child, "c1"), instance.submitTo(child, "c2")];

      await sleep(50);
      expect(await sent(instance)).toEqual([]);
      expect(await sent(instance, child)).toEqual([]);

      // The subagent's first message ends first: the root's messages stay behind their own first.
      instance.finishPreparing("c1");
      await Promise.all(sub);
      expect(await sent(instance, child)).toEqual(["c1", "c2"]);
      expect(await sent(instance)).toEqual([]);

      instance.finishPreparing("a1");
      await Promise.all(root);
    });
    await eventually(stub, (instance) => instance.idle());

    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance)),
    ).toEqual(["a1", "a2", "a3"]);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance, child)),
    ).toEqual(["c1", "c2"]);
  });

  it("refuses to navigate the Session tree while a message is being prepared, and not after", async () => {
    const { stub } = await withChild();

    const [during, after] = await runInDurableObject(
      stub,
      async (instance: TestSubagentSession) => {
        instance.holdPreparing("a1");

        const slow = instance.submit("a1");

        await sleep(50);

        const during = await instance.navigateNowhere();

        instance.finishPreparing("a1");
        await slow;

        return [during, await instance.navigateNowhere()];
      },
    );

    expect(during).toBe(
      "The Session tree cannot be navigated while a message is being prepared: wait for it to be sent.",
    );
    // Once it is placed the refusal is another's: the Run it started is under way, or the point is not in the tree.
    expect(after).not.toContain("is being prepared");
  });
});
