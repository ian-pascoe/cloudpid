// The Session's Slash commands through a Session host on real Durable Object storage (docs/spec.md → Client and protocol
// → Slash commands). workerd's `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { type ConversationId, sessionCommandsFor } from "@cloudpid/protocol";
import type { TestRegistry } from "../registry/store.fixture.ts";
import type { TestSession } from "./host.fixture.ts";

/** A new Workspace of the default Environment, as `createSession` makes one. */
const NEW_IN_DEFAULT = {
  kind: "new",
  id: "0a1b2c3d",
  environment: "default",
  branch: "cloudpid/0a1b2c3d",
  base: null,
} as const;

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

let counter = 0;

/** A Session whose settings keep almost nothing out of a compaction, so a short conversation has something to compact. */
const compacting = async () => {
  const id = `compact-${(counter += 1)}`;
  const registry = env.REGISTRIES.getByName(`commands-registry-${counter}`);
  const stub = env.SESSIONS.getByName(id);

  await registry.createSession({ id, title: null, workspace: NEW_IN_DEFAULT }, 1);
  await registry.updateSettings({ compaction: { keepRecentTokens: 1 } }, 1);
  await runInDurableObject(stub, (instance: TestSession) =>
    instance.reportTo(`commands-registry-${counter}`),
  );

  return stub;
};

const settles = <T>(check: () => Promise<T>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

describe("the Session's Slash commands", () => {
  it("offer the server commands, without /rollover where the agent has no context_rollover, and no templates or Skills without a Workspace", async () => {
    const catalog = await runInDurableObject(fresh(), (instance: TestSession) =>
      instance.catalog(),
    );

    expect(catalog).toEqual({ commands: sessionCommandsFor(false), templates: [], skills: [] });
  });

  it("clear the Todo List with /todo clear", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      instance.script([
        'call:todo:{"action":"add","tasks":[{"title":"One"},{"title":"Two"}]}',
        "Planned.",
      ]);
      await instance.prompt({ requestId: "plan", text: "Plan" });
      expect(await instance.todoTitles()).toEqual(["One", "Two"]);

      expect(await instance.command("todo", "clear")).toEqual({
        outcome: { notice: "Cleared 2 Tasks." },
      });
      expect(await instance.todoTitles()).toEqual([]);
      expect(await instance.command("todo", "clear")).toEqual({
        outcome: { notice: "The Todo List is already empty." },
      });
      expect(await instance.command("todo", "")).toEqual({ failure: "/todo takes clear." });
    });
  });

  it("send a client watching the Todo List the cleared list after /todo clear", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      instance.script(['call:todo:{"action":"add","tasks":[{"title":"One"}]}', "Planned."]);
      await instance.prompt({ requestId: "plan", text: "Plan" });

      const watch = instance.watchTodos();

      await settles(async () => expect(watch.lists).toEqual([["One"]]));
      await instance.command("todo", "clear");
      await settles(async () => expect(watch.lists).toEqual([["One"], []]));
      watch.stop();
    });
  });

  it("export the History across a compaction", async () => {
    const stub = await compacting();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["First answer.", "The summary.", "Later answer."]);
      await instance.prompt({ requestId: "one", text: "First" });
      await instance.command("compact", "");
    });

    await settles(async () => {
      const kinds = await runInDurableObject(stub, async (instance: TestSession) =>
        (await instance.rootEntries()).map((entry) => entry.kind),
      );

      expect(kinds).toContain("pi.compaction");
    });

    const content = await runInDurableObject(stub, async (instance: TestSession) => {
      await instance.prompt({ requestId: "two", text: "Later" });

      const exported = await instance.command("export", "");

      if (!("outcome" in exported)) throw new Error(exported.failure);

      return exported.outcome.file?.content ?? "";
    });

    // The window before the compaction, the compaction, and the window after it.
    const order = [
      "## Owner\n\nFirst",
      "## Agent\n\nFirst answer.",
      "### Context compacted",
      "## Owner\n\nLater",
      "## Agent\n\nLater answer.",
    ].map((part) => content.indexOf(part));

    expect(order.every((at) => at !== -1)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it("export the whole History as Markdown with /export", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      instance.script(['call:echo:{"text":"ping"}', "Pong."]);
      await instance.prompt({ requestId: "ask", text: "Say pong" });

      const exported = await instance.command("export", "");

      if (!("outcome" in exported)) throw new Error(exported.failure);

      const file = exported.outcome.file;

      expect(file?.name).toMatch(/^conversation-\d+-history\.md$/);
      expect(file?.mimeType).toBe("text/markdown");
      expect(file?.content).toContain("## Owner\n\nSay pong");
      expect(file?.content).toContain(
        '**Tool call** `echo`\n\n```json\n{\n  "text": "ping"\n}\n```',
      );
      expect(file?.content).toContain("**Tool result** `echo`\n\n```\necho: ping\n```");
      expect(file?.content).toContain("## Agent\n\nPong.");
      expect(await instance.command("export", "now")).toEqual({
        failure: "/export takes no argument.",
      });
    });
  });

  it("run /compact once the Run in progress ends", async () => {
    const stub = await compacting();

    await runInDurableObject(stub, async (instance: TestSession, state) => {
      instance.script(["First answer.", "gate:Second answer.", "The summary."]);
      await instance.prompt({ requestId: "one", text: "First" });
      await instance.submit({ requestId: "two", text: "Second" });
      await instance.gated.promise;

      expect(await instance.command("compact", "the API")).toEqual({
        outcome: { notice: "The context is compacted once the run ends." },
      });
      // Nothing compacts while the Run goes on: the request waits in storage.
      expect(state.storage.kv.get("pending-compactions")).toEqual({ 1: "the API" });

      instance.open();
    });

    await settles(async () => {
      const kinds = await runInDurableObject(stub, async (instance: TestSession) =>
        (await instance.rootEntries()).map((entry) => entry.kind),
      );

      expect(kinds).toContain("pi.compaction");
    });

    await runInDurableObject(stub, async (instance: TestSession, state) => {
      const entries = await instance.rootEntries();
      const answer = entries.findIndex((entry) => entry.text === "Second answer.");
      const summary = entries.findIndex((entry) => entry.kind === "pi.compaction");

      // The summary came after the Run's answer, and the focus reached the summarizer.
      expect(summary).toBeGreaterThan(answer);
      expect(instance.requestMessages().at(-1)).toContain("the API");
      expect(state.storage.kv.get("pending-compactions")).toEqual({});
    });
  });

  it("keep a /compact waiting for the Run through an eviction, and run it after the Run", async () => {
    const stub = await compacting();

    await runInDurableObject(stub, async (instance: TestSession, state) => {
      instance.script(["First answer.", "hang", "Second answer.", "The summary."]);
      await instance.prompt({ requestId: "one", text: "First" });
      await instance.submit({ requestId: "two", text: "Second" });
      await instance.hanging.promise;

      expect(await instance.command("compact", "the API")).toEqual({
        outcome: { notice: "The context is compacted once the run ends." },
      });
      expect(state.storage.kv.get("pending-compactions")).toEqual({ 1: "the API" });
    });

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await settles(async () => {
      const kinds = await runInDurableObject(stub, async (instance: TestSession) =>
        (await instance.rootEntries()).map((entry) => entry.kind),
      );

      expect(kinds).toContain("pi.compaction");
    });

    await runInDurableObject(stub, async (instance: TestSession, state) => {
      const entries = await instance.rootEntries();
      const answer = entries.findIndex((entry) => entry.text === "Second answer.");
      const summary = entries.findIndex((entry) => entry.kind === "pi.compaction");

      // The resumed Run answered first, then the compaction ran with the focus asked for before the eviction.
      expect(answer).not.toBe(-1);
      expect(summary).toBeGreaterThan(answer);
      expect(instance.requestMessages().at(-1)).toContain("the API");
      expect(state.storage.kv.get("pending-compactions")).toEqual({});
    });
  });

  it("compact at once while idle", async () => {
    const stub = await compacting();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["First answer.", "The summary."]);
      await instance.prompt({ requestId: "one", text: "First" });

      expect(await instance.command("compact", "")).toEqual({
        outcome: { notice: "Compacting the context." },
      });
    });

    await settles(async () => {
      const kinds = await runInDurableObject(stub, async (instance: TestSession) =>
        (await instance.rootEntries()).map((entry) => entry.kind),
      );

      expect(kinds).toContain("pi.compaction");
    });
  });

  it("refuse a /compact focus over 2000 characters, keeping nothing", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession, state) => {
      expect(await instance.command("compact", "x".repeat(2001))).toEqual({
        failure: "Keep the compaction focus to 2000 characters.",
      });
      expect(state.storage.kv.get("pending-compactions")).toBeUndefined();
    });
  });

  it("refuse /rollover in a conversation without context_rollover, and a focus over 2000 characters", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      expect(await instance.command("rollover", "")).toEqual({
        failure: "This conversation cannot roll over: it has no context_rollover tool.",
      });
      expect(await instance.command("rollover", "x".repeat(2001))).toEqual({
        failure: "Keep the Rollover focus to 2000 characters.",
      });
    });
  });

  it("refuse a command the Session does not have, and a conversation that is not an agent's", async () => {
    await runInDurableObject(fresh(), async (instance: TestSession) => {
      expect(await instance.command("model", "x")).toEqual({
        failure: "The Session has no /model command.",
      });

      // SAFETY: a positive integer, as a conversation ID is; no conversation of this Session has it.
      const refused = await instance.command("export", "", 99 as ConversationId);

      expect("failure" in refused && refused.failure).toMatch(/not the root or a subagent/);
    });
  });
});
