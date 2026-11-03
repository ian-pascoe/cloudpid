// Admitting a message in two steps against real Durable Object storage (docs/architecture/mcp-in-a-session.md → Getting a
// prompt at send): a message is prepared (here, its attached pages are read, held until the test lets them end) outside the
// Session's lock, in a line per conversation, then placed. A slow preparation holds back no other conversation, messages
// keep their order within each conversation, the Session tree stays put while one is prepared, and Stop withdraws the
// messages in a conversation's line (preparing or waiting) so that none is placed after it.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectRecord:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { NAVIGATE_WHILE_PREPARING } from "./branches.ts";
import type { TestSubagentSession } from "./subagents.workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SUBAGENT_SESSIONS: DurableObjectNamespace<TestSubagentSession>;
    }
  }
}

/** How a submit ended: placed, or withdrawn by Stop. */
const PLACED = "placed";
const WITHDRAWN = "withdrawn";

/** The end of `submit`: it was placed, withdrawn by Stop, or failed for another reason (which is thrown). */
const settled = (submit: Promise<number>): Promise<string> =>
  submit.then(
    () => PLACED,
    (error: Error) => {
      if (error.message.includes("Stopped before it was sent")) return WITHDRAWN;

      throw error;
    },
  );

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
  it("holds back neither another conversation nor the lookups while a message is being prepared", async () => {
    const { stub, child } = await withChild();

    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.holdPreparing("a1");

      const slow = instance.submit("a1");

      await sleep(50);

      // Another conversation is admitted meanwhile.
      await instance.submitTo(child, "c1");
      // A read of the Session goes ahead. It never took the lock, so this does not show the split: the other
      // conversation's message above does, which waited on the lock before.
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

    expect(during).toBe(NAVIGATE_WHILE_PREPARING);
    // Once it is placed the refusal is another's: the Run it started is under way, or the point is not in the tree.
    expect(after).not.toContain("is being prepared");
  });

  it("refuses to switch Session branch while a message is being prepared", async () => {
    const { stub } = await withChild();

    const [root, during, after] = await runInDurableObject(
      stub,
      async (instance: TestSubagentSession) => {
        const root = await instance.activeBranch();

        // A second branch to switch to: the Session's first message branched before.
        const went = await instance.navigateToStart(false);

        if ("failure" in went) throw new Error(went.failure);

        instance.holdPreparing("a1");

        const slow = instance.submit("a1");

        await sleep(50);

        const during = await instance.switchTo(root);

        instance.finishPreparing("a1");
        await slow;

        return [root, during, await instance.activeBranch()] as const;
      },
    );

    expect(during).toBe(NAVIGATE_WHILE_PREPARING);
    // The refusal left the new branch active, where the message was placed.
    expect(after).not.toBe(root);
  });

  it("places messages in the order they arrived when the first arrives while the Session tree moves", async () => {
    const { stub } = await withChild();

    const branch = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      const summarizing = instance.holdSummary();
      const moving = instance.navigateToStart(true);

      // The move holds the lock while its summary is made; the first message is sent meanwhile, and the second after.
      await summarizing;
      instance.holdPreparing("a1");

      const first = instance.submit("a1");

      await sleep(50);
      instance.finishSummary();

      const went = await moving;

      if ("failure" in went) throw new Error(went.failure);

      const second = instance.submit("a2");

      await sleep(50);
      // The first is for the branch the Session moved to, and the second is behind it: neither is placed yet.
      expect(await sent(instance, went.active)).toEqual([]);

      instance.finishPreparing("a1");
      await Promise.all([first, second]);

      return went.active;
    });

    await eventually(stub, (instance) => instance.idle());

    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance, branch)),
    ).toEqual(["a1", "a2"]);
  });

  it("withdraws, on Stop, the message being prepared and the ones waiting behind it, and not another conversation's", async () => {
    const { stub, child } = await withChild();

    const outcomes = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.holdPreparing("a1");
      instance.holdPreparing("c1");

      const root = [instance.submit("a1"), instance.submit("a2")].map(settled);
      const sub = settled(instance.submitTo(child, "c1"));

      await sleep(50);

      // A message in line is unsettled input: the Session is not idle, so the MCP endpoint's Stop does not skip it.
      expect(await instance.busyness()).toEqual({ idle: false, unsettled: true });
      await instance.abort();

      // Withdrawn without its preparation being let end: a1's was cancelled, and a2 never started.
      const withdrawn = await Promise.all(root);

      // The other conversation's line is untouched: its message is still being prepared, and is placed.
      instance.finishPreparing("c1");

      return { withdrawn, other: await sub };
    });

    expect(outcomes.withdrawn).toEqual([WITHDRAWN, WITHDRAWN]);
    expect(outcomes.other).toBe(PLACED);
    await eventually(stub, (instance) => instance.idle());
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance)),
    ).toEqual([]);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance, child)),
    ).toEqual(["c1"]);

    // The line is free again: a message sent after the Stop is placed, and the tree may move.
    await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      await instance.submit("a3");
    });
    await eventually(stub, (instance) => instance.idle());
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance)),
    ).toEqual(["a3"]);
  });

  it("withdraws only the line of the subagent Stop names", async () => {
    const { stub, child } = await withChild();

    const outcomes = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.holdPreparing("a1");
      instance.holdPreparing("c1");

      const root = settled(instance.submit("a1"));
      const sub = settled(instance.submitTo(child, "c1"));

      await sleep(50);
      await instance.abort({ conversationId: child });

      const withdrawn = await sub;

      instance.finishPreparing("a1");

      return { withdrawn, other: await root };
    });

    expect(outcomes).toEqual({ withdrawn: WITHDRAWN, other: PLACED });
  });

  it("withdraws every conversation's line on Stop all", async () => {
    const { stub, child } = await withChild();

    const withdrawn = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      instance.holdPreparing("a1");
      instance.holdPreparing("c1");

      const lines = [instance.submit("a1"), instance.submitTo(child, "c1")].map(settled);

      await sleep(50);
      await instance.stopEverything();

      return Promise.all(lines);
    });

    expect(withdrawn).toEqual([WITHDRAWN, WITHDRAWN]);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance)),
    ).toEqual([]);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance, child)),
    ).toEqual([]);
  });

  it("leaves the tree free to move once Stop withdrew the message that kept it", async () => {
    const { stub } = await withChild();

    const [during, after] = await runInDurableObject(
      stub,
      async (instance: TestSubagentSession) => {
        instance.holdPreparing("a1");

        const slow = settled(instance.submit("a1"));

        await sleep(50);

        const during = await instance.navigateNowhere();

        await instance.abort();
        await slow;

        return [during, await instance.navigateNowhere()];
      },
    );

    expect(during).toBe(NAVIGATE_WHILE_PREPARING);
    expect(after).not.toBe(NAVIGATE_WHILE_PREPARING);
  });
});
