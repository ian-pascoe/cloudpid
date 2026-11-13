// Admitting a message in two steps against real Durable Object storage (docs/architecture/mcp-in-a-session.md → Getting a
// prompt at send): a message is prepared (here, its attached pages are read, held until the test lets them end) outside the
// Session's lock, in a line per conversation, then placed. A slow preparation holds back no other conversation, messages
// keep their order within each conversation, the Session tree stays put while one is prepared, and Stop withdraws the
// messages in a conversation's line (preparing or waiting) so that none is placed after it.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectRecord:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { NAVIGATE_WHILE_PREPARING } from "./branches.ts";
import { eventually, idle } from "../durable-waits.fixture.ts";
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
  await idle(stub);

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
      const preparingA1 = instance.holdPreparing("a1");

      const slow = instance.submit("a1");

      await preparingA1;

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
    await idle(stub);

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
      const preparingA1 = instance.holdPreparing("a1");
      const preparingC1 = instance.holdPreparing("c1");

      const root = [instance.submit("a1"), instance.submit("a2"), instance.submit("a3")];
      const sub = [instance.submitTo(child, "c1"), instance.submitTo(child, "c2")];

      await Promise.all([preparingA1, preparingC1]);
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
    await idle(stub);

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
        const preparingA1 = instance.holdPreparing("a1");

        const slow = instance.submit("a1");

        await preparingA1;

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

        const preparingA1 = instance.holdPreparing("a1");

        const slow = instance.submit("a1");

        await preparingA1;

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
      const preparingA1 = instance.holdPreparing("a1");

      const first = instance.submit("a1");

      // It waits for the lock before it is prepared, and nothing says it got there: a moment lets it.
      await sleep(50);
      instance.finishSummary();

      const went = await moving;

      if ("failure" in went) throw new Error(went.failure);

      const second = instance.submit("a2");

      await preparingA1;
      // A moment for the second to be placed if it wrongly could be: nothing signals a message that waits in its line.
      await sleep(50);
      // The first is for the branch the Session moved to, and the second is behind it: neither is placed yet.
      expect(await sent(instance, went.active)).toEqual([]);

      instance.finishPreparing("a1");
      await Promise.all([first, second]);

      return went.active;
    });

    await idle(stub);

    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance, branch)),
    ).toEqual(["a1", "a2"]);
  });

  it("withdraws, on Stop, the message being prepared and the ones waiting behind it, and not another conversation's", async () => {
    const { stub, child } = await withChild();

    const outcomes = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      const preparingA1 = instance.holdPreparing("a1");
      const preparingC1 = instance.holdPreparing("c1");

      const root = [instance.submitOutcome("a1"), instance.submitOutcome("a2")];
      const sub = instance.submitOutcome("c1", child);

      await Promise.all([preparingA1, preparingC1]);

      // A message in line is unsettled input: the Session is not idle, so the MCP endpoint's Stop does not skip it.
      expect(await instance.busyness()).toEqual({ idle: false, unsettled: true });
      await instance.abort();

      // Withdrawn without its preparation being let end: a1's was cancelled, and a2 never started.
      const withdrawn = await Promise.all(root);

      // The other conversation's line is untouched: its message is still being prepared, and is placed.
      instance.finishPreparing("c1");

      return { withdrawn, other: await sub };
    });

    expect(outcomes.withdrawn).toEqual(["withdrawn", "withdrawn"]);
    expect(outcomes.other).toBe("placed");
    await idle(stub);
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
    await idle(stub);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance)),
    ).toEqual(["a3"]);
  });

  it("withdraws only the line of the subagent Stop names", async () => {
    const { stub, child } = await withChild();

    const outcomes = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      const preparingA1 = instance.holdPreparing("a1");
      const preparingC1 = instance.holdPreparing("c1");

      const root = instance.submitOutcome("a1");
      const sub = instance.submitOutcome("c1", child);

      await Promise.all([preparingA1, preparingC1]);
      await instance.abort({ conversationId: child });

      const withdrawn = await sub;

      instance.finishPreparing("a1");

      return { withdrawn, other: await root };
    });

    expect(outcomes).toEqual({ withdrawn: "withdrawn", other: "placed" });
  });

  it("withdraws every conversation's line on Stop all", async () => {
    const { stub, child } = await withChild();

    const withdrawn = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      const preparingA1 = instance.holdPreparing("a1");
      const preparingC1 = instance.holdPreparing("c1");

      const lines = [instance.submitOutcome("a1"), instance.submitOutcome("c1", child)];

      await Promise.all([preparingA1, preparingC1]);
      await instance.stopEverything();

      return Promise.all(lines);
    });

    expect(withdrawn).toEqual(["withdrawn", "withdrawn"]);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance)),
    ).toEqual([]);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance, child)),
    ).toEqual([]);
  });

  it("withdraws the line of every subagent below the conversation when Stop reaches them with subagents", async () => {
    const { stub, child } = await withChild();

    const withdrawn = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      const preparingA1 = instance.holdPreparing("a1");
      const preparingC1 = instance.holdPreparing("c1");

      const lines = [instance.submitOutcome("a1"), instance.submitOutcome("c1", child)];

      await Promise.all([preparingA1, preparingC1]);
      await instance.abort({ subagents: true });

      return Promise.all(lines);
    });

    expect(withdrawn).toEqual(["withdrawn", "withdrawn"]);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance, child)),
    ).toEqual([]);
  });

  it("places a message that is being placed when Stop arrives, and Stop waits for it, then aborts it as it does queued input", async () => {
    const { stub } = await withChild();

    const order = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      const order: string[] = [];

      // The message is prepared at once, and held in the middle of being placed.
      const placing = instance.holdPlacing();

      const placed = instance.submitOutcome("a1").then((outcome) => {
        order.push(outcome);
      });

      await placing;

      const stopped = instance.abort().then(() => {
        order.push("stopped");
      });

      await sleep(50);
      // Stop does not cut the placing, and does not go on to abort before it is done.
      expect(order).toEqual([]);
      instance.finishPlacing();
      await Promise.all([placed, stopped]);

      return order;
    });

    expect(order).toEqual(["placed", "stopped"]);
    // What was placed was aborted: nothing is left running or queued.
    await idle(stub);
  });

  it("withdraws a message sent before Stop that was still waiting for the lock a move of the Session tree held", async () => {
    const { stub, child } = await withChild();

    const outcomes = await runInDurableObject(stub, async (instance: TestSubagentSession) => {
      const summarizing = instance.holdSummary();
      const moving = instance.navigateToStart(true);

      // The move holds the lock while its summary is made: the message is sent meanwhile, and is not in a line yet.
      await summarizing;

      const before = instance.submitOutcome("c1", child);

      // Nothing says a message got to the lock it waits for: a moment lets it.
      await sleep(50);
      await instance.abort({ conversationId: child });

      // Sent after the Stop, it is for the conversation as it is after it.
      const after = instance.submitOutcome("c2", child);

      // Nothing says it got to the lock it waits for either: a moment lets it.
      await sleep(50);
      instance.finishSummary();

      const went = await moving;

      if ("failure" in went) throw new Error(went.failure);

      return { before: await before, after: await after };
    });

    expect(outcomes).toEqual({ before: "withdrawn", after: "placed" });
    await idle(stub);
    expect(
      await runInDurableObject(stub, (instance: TestSubagentSession) => sent(instance, child)),
    ).toEqual(["c2"]);
  });

  it("leaves the tree free to move once Stop withdrew the message that kept it", async () => {
    const { stub } = await withChild();

    const [during, after] = await runInDurableObject(
      stub,
      async (instance: TestSubagentSession) => {
        const preparingA1 = instance.holdPreparing("a1");

        const slow = instance.submitOutcome("a1");

        await preparingA1;

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
