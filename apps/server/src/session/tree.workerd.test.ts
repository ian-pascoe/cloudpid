// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The Session tree (GLOSSARY.md → Session tree) and the copy behind a Fork or Clone, on a real Session host.
import { runInDurableObject } from "cloudflare:test";
import type { SessionTree, TreeNode } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { TestRegistry } from "../registry/store.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly SESSIONS: DurableObjectNamespace<TestSession>;
      readonly REGISTRIES: DurableObjectNamespace<TestRegistry>;
    }
  }
}

const fresh = () => env.SESSIONS.get(env.SESSIONS.newUniqueId());

/** The node of `tree` whose role and text are these. */
const node = (tree: SessionTree, role: TreeNode["role"], text: string): TreeNode => {
  const found = tree.nodes.find((each) => each.role === role && each.text === text);

  if (found === undefined) throw new Error(`No ${role} node "${text}" in the tree`);

  return found;
};

/** A Session of two exchanges: "first" answered "one", "second" answered "two". */
const twoExchanges = async (instance: TestSession) => {
  instance.script(["one", "two"]);
  await instance.prompt({ requestId: "turn-1", text: "first" });
  await instance.prompt({ requestId: "turn-2", text: "second" });

  return instance.tree();
};

describe("a Session's tree", () => {
  it("branches before an owner's message, gives its text back, and runs the next message on the new branch", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      const before = await twoExchanges(instance);
      const root = before.active;

      expect(before.nodes.map((each) => each.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(before.leaf).toBe(node(before, "assistant", "two").id);

      const went = await instance.navigate({
        entryId: node(before, "user", "second").id,
        position: "before",
      });

      expect(went).toMatchObject({ navigated: { text: "second" } });

      const branch = await instance.activeBranch();

      expect(branch).not.toBe(root);

      instance.script(["three"]);
      await instance.prompt({ requestId: "turn-3", text: "other" });

      const after = await instance.tree();
      const one = node(after, "assistant", "one");

      // Both messages after "one" are its children, each on its own branch.
      expect(node(after, "user", "second")).toMatchObject({ parent: one.id, conversationId: root });
      expect(node(after, "user", "other")).toMatchObject({
        parent: one.id,
        conversationId: branch,
      });
      expect(after.active).toBe(branch);
      expect(after.leaf).toBe(node(after, "assistant", "three").id);
      expect(after.branches.map((each) => each.conversationId)).toEqual([root, branch]);
    });
  });

  it("goes back to a branch's tip without making another, and switches as the chevrons do", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      const before = await twoExchanges(instance);
      const root = before.active;

      await instance.navigate({ entryId: node(before, "assistant", "one").id, position: "at" });

      const branch = await instance.activeBranch();

      // Back to the root's last answer: its tip, so the root is made active again.
      await instance.navigate({ entryId: node(before, "assistant", "two").id, position: "at" });

      expect(await instance.activeBranch()).toBe(root);

      await instance.switchBranch(branch);

      expect(await instance.activeBranch()).toBe(branch);
      // An empty branch is not listed once it is left.
      await instance.switchBranch(root);

      expect((await instance.tree()).branches.map((each) => each.conversationId)).toEqual([root]);
    });
  });

  it("addresses the active branch by its ID, and no branch left behind", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      const before = await twoExchanges(instance);
      const root = before.active;

      await instance.navigate({ entryId: node(before, "assistant", "one").id, position: "at" });

      const branch = await instance.activeBranch();

      expect(await instance.command("export", "", branch)).toHaveProperty("outcome");
      expect(await instance.command("export", "", root)).toMatchObject({
        failure: expect.stringContaining("not the active one"),
      });
    });
  });

  it("places a summary of the branch left at the start of the branch entered", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      const before = await twoExchanges(instance);

      instance.script(["## Goal\nSay two"]);

      const went = await instance.navigate({
        entryId: node(before, "assistant", "one").id,
        position: "at",
        summary: { instructions: "the numbers" },
      });

      expect(went).toHaveProperty("navigated");

      const after = await instance.tree();
      const summary = node(after, "notice", "Branch summary");

      expect(summary).toMatchObject({
        parent: node(after, "assistant", "one").id,
        conversationId: after.active,
      });
      expect(instance.requestMessages().at(-1)).toContain("Additional focus: the numbers");
    });
  });

  it("refuses to navigate while the active branch's Run is in progress", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      const before = await twoExchanges(instance);

      instance.script(["hang"]);
      await instance.submit({ requestId: "turn-3", text: "third" });
      await instance.hanging.promise;

      const went = await instance.navigate({
        entryId: node(before, "assistant", "one").id,
        position: "at",
      });

      expect(went).toMatchObject({ failure: expect.stringContaining("Run") });
      expect(await instance.activeBranch()).toBe(before.active);
      await instance.abortRoot();
    });
  });
});

describe("copying a Session for a Fork or Clone", () => {
  it("fills the new Session with the active branch up to the point, renumbered, and the owner's message back", async () => {
    const target = "fork-of-two-exchanges";

    await runInDurableObject(fresh(), async (instance: TestSession) => {
      const before = await twoExchanges(instance);

      // The new Session is reached through a stub of its own, as the main Worker reaches it.
      const plan = await instance.forkInto(target, {
        point: { entryId: node(before, "user", "second").id, position: "before" },
        quiet: "none",
      });

      expect(plan.text).toBe("second");
    });

    await runInDurableObject(env.SESSIONS.getByName(target), async (copy: TestSession) => {
      const tree = await copy.tree();

      expect(tree.nodes.map((each) => [each.role, each.text])).toEqual([
        ["user", "first"],
        ["assistant", "one"],
      ]);
      expect(await copy.copying()).toBe(false);

      // It takes messages, with the copied ones as its context.
      copy.script(["again"]);
      await copy.prompt({ requestId: "turn-1", text: "next" });

      expect((await copy.tree()).nodes.map((each) => each.text)).toEqual([
        "first",
        "one",
        "next",
        "again",
      ]);
    });
  });

  it("keeps picked the model the branch ran with at the point, and leaves the default unpicked", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      instance.script(["one", "two"]);
      await instance.configure({ model: { provider: "anthropic", modelId: "claude-haiku-5-5" } });
      await instance.prompt({ requestId: "turn-1", text: "first" });
      await instance.configure({ model: { provider: "anthropic", modelId: "claude-sonnet-5-5" } });
      await instance.prompt({ requestId: "turn-2", text: "second" });

      const tree = await instance.tree();

      const plan = await instance.forkInto("fork-with-a-pick", {
        point: { entryId: node(tree, "assistant", "one").id, position: "at" },
        quiet: "none",
      });

      expect(plan.pick.model).toMatchObject({ provider: "anthropic", modelId: "claude-haiku-5-5" });
      expect(plan.pick.thinkingLevel).toBeUndefined();
    });
  });

  it("refuses a Clone while the Run is in progress", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      await twoExchanges(instance);

      instance.script(["hang"]);
      await instance.submit({ requestId: "turn-3", text: "third" });
      await instance.hanging.promise;

      await expect(instance.forkInto("clone-refused", { quiet: "branch" })).rejects.toThrow(
        /Run is in progress/u,
      );
      await instance.abortRoot();
    });
  });

  it("refuses a Fork in a new workspace while a Run is in progress, and makes one in the Workspace", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      const before = await twoExchanges(instance);

      instance.script(["hang"]);
      await instance.submit({ requestId: "turn-3", text: "third" });
      await instance.hanging.promise;

      const point = { entryId: node(before, "assistant", "one").id, position: "at" } as const;

      await expect(
        instance.forkInto("fork-in-new-workspace-refused", { point, quiet: "session" }),
      ).rejects.toThrow(/cannot be forked in a new workspace while a Run is in progress/u);

      // A Fork that stays in the Workspace carries no files, so the Run may go on.
      const plan = await instance.forkInto("fork-while-running", { point, quiet: "none" });

      expect(plan.through).toBe(point.entryId);
      await instance.abortRoot();
    });
  });

  it("takes no message while its files are carried, until the Fork releases it", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      const before = await twoExchanges(instance);
      const point = { entryId: node(before, "assistant", "two").id, position: "at" } as const;

      await instance.forkInto("fork-carrying-files", { point, quiet: "session" });

      await expect(instance.submit({ requestId: "turn-3", text: "third" })).rejects.toThrow(
        /files are being carried/u,
      );

      await instance.releaseFork();
      instance.script(["three"]);
      await instance.prompt({ requestId: "turn-3", text: "third" });
    });
  });

  it("refuses to fork a Session that is itself still being filled", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      await twoExchanges(instance);
      await instance.importStart();

      await expect(
        instance.forkInto("fork-of-a-fork-being-filled", { quiet: "none" }),
      ).rejects.toThrow(/still being made/u);
    });
  });

  it("carries pi-durable's default agent for a Fork before the first message", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      const before = await twoExchanges(instance);

      const plan = await instance.forkInto("fork-before-everything", {
        point: { entryId: node(before, "user", "first").id, position: "before" },
        quiet: "none",
      });

      expect(plan.through).toBeNull();
      expect(plan.agent).toEqual({});
      expect(plan.text).toBe("first");
    });
  });
});
