// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
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

/** Poll `check` inside the object until it holds. */
const eventually = async (
  stub: DurableObjectStub<TestSession>,
  check: (instance: TestSession, state: DurableObjectState) => Promise<boolean>,
): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await runInDurableObject(stub, check)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Condition not reached");
};

let counter = 0;

/** A Session registered in a fresh Registry, with its Session object reporting to that Registry. */
const registered = async () => {
  const sessionId = `session-${(counter += 1)}`;
  const registryName = `registry-${counter}`;
  const registry = env.REGISTRIES.getByName(registryName);
  const stub = env.SESSIONS.getByName(sessionId);

  await registry.createSession({ id: sessionId, title: null }, 1);
  await runInDurableObject(stub, (instance: TestSession) => instance.reportTo(registryName));

  const status = async () => (await registry.listSessions())[0]?.status;
  const reported = () => runInDurableObject(stub, (instance: TestSession) => instance.reported());

  return { stub, status, reported, registry };
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
    // The alarm's instance finishes the run by itself: `idle()` only reads, and no client submits or waits.
    await eventually(stub, (instance) => instance.idle());

    const answer = await runInDurableObject(stub, (instance: TestSession) =>
      instance.prompt({ requestId: "turn-1", text: "hi" }),
    );

    expect(answer).toMatchObject({ status: "answered", text: "recovered" });
    // The next heartbeat finds nothing live and clears itself.
    await runDurableObjectAlarm(stub);
    await eventually(stub, async (_instance, state) => (await state.storage.getAlarm()) === null);
  });

  it("reports that a run is live, then that it ended, even one finished after an eviction", async () => {
    const { stub, status, reported } = await registered();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["hang", "recovered"]);
      await instance.submit({ requestId: "turn-1", text: "hi" });
      await instance.hanging.promise;
    });
    expect(await status()).toBe("running");

    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    // No client waits and no later alarm runs: the instance reports the end of the run it resumed itself.
    await vi.waitFor(async () => expect(await status()).toBe("idle"));

    // Any report of the live run comes before the one that it ended, which is last.
    const sequence = await reported();

    expect(sequence[0]).toBe("running");
    expect(sequence.at(-1)).toBe("idle");
    expect(sequence.slice(0, -1)).not.toContain("idle");
  });

  it("reports an answered prompt as running, then idle", async () => {
    const { stub, reported } = await registered();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["done"]);
      await instance.prompt({ requestId: "turn-1", text: "hi" });
    });

    expect(await reported()).toEqual(["running", "idle"]);
  });

  it("keeps its heartbeat while the Registry fails and reports the end of the run once it is back", async () => {
    const { stub, status, reported } = await registered();

    await runInDurableObject(stub, (instance: TestSession) => instance.reports("failing"));
    // A new instance, which has not told the Registry anything yet.
    await evictDurableObject(stub);

    const answer = await runInDurableObject(stub, (instance: TestSession) => {
      instance.script(["done"]);

      return instance.prompt({ requestId: "turn-1", text: "hi" });
    });

    // A Registry that is down does not fail the prompt.
    expect(answer).toMatchObject({ status: "answered", text: "done" });
    expect(await reported()).toEqual([]);
    // The end of the run could not be reported, so the heartbeat stays armed to try again.
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    await runInDurableObject(stub, (instance: TestSession) => instance.reports("working"));
    await runDurableObjectAlarm(stub);
    expect(await status()).toBe("idle");
    expect(await reported()).toEqual(["idle"]);
    await eventually(stub, async (_instance, state) => (await state.storage.getAlarm()) === null);
  });

  it("treats a report that hangs as failed, so a slow Registry stalls neither the prompt nor the constructor", async () => {
    const { stub, reported } = await registered();

    await runInDurableObject(stub, (instance: TestSession) => instance.reports("hanging"));
    // The new instance's open reports once and gives up after the timeout.
    await evictDurableObject(stub);

    const answer = await runInDurableObject(stub, (instance: TestSession) => {
      instance.script(["done"]);

      return instance.prompt({ requestId: "turn-1", text: "hi" });
    });

    expect(answer).toMatchObject({ status: "answered", text: "done" });
    expect(await reported()).toEqual([]);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
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

  it("answers a prompt that calls a tool, with the result in the transcript", async () => {
    const stub = fresh();

    const [answer, results] = await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(['call:echo:{"text":"2d6"}', "You rolled."]);

      return [
        await instance.prompt({ requestId: "turn-1", text: "Echo 2d6" }),
        await instance.toolResults(),
      ] as const;
    });

    expect(answer).toMatchObject({ status: "answered", text: "You rolled." });
    expect(results).toEqual(["echo: 2d6"]);
  });
});

describe("a Session's agent", () => {
  /** Prompt the Session once, as turn `n`. */
  const ask = (stub: DurableObjectStub<TestSession>, n: number) =>
    runInDurableObject(stub, (instance: TestSession) =>
      instance.prompt({ requestId: `turn-${n}`, text: "hi" }),
    );

  const requests = (stub: DurableObjectStub<TestSession>) =>
    runInDurableObject(stub, (instance: TestSession) => instance.requests());

  const script = (stub: DurableObjectStub<TestSession>, ...responses: string[]) =>
    runInDurableObject(stub, (instance: TestSession) => instance.script(responses));

  it("runs a new Session's first request on the default model at the default thinking level", async () => {
    const { stub } = await registered();

    await script(stub, "one");
    await ask(stub, 1);

    expect(await requests(stub)).toEqual([{ model: "claude-opus-5-5", thinking: "high" }]);
  });

  it("applies a default changed in the Registry to the next request of an idle Session, with no restart", async () => {
    const { stub, registry } = await registered();

    await script(stub, "one", "two");
    await ask(stub, 1);

    await registry.updateSettings(
      { model: "anthropic/claude-sonnet-5-5", thinkingLevel: "low" },
      1,
    );
    await ask(stub, 2);

    expect(await requests(stub)).toEqual([
      { model: "claude-opus-5-5", thinking: "high" },
      { model: "claude-sonnet-5-5", thinking: "low" },
    ]);
  });

  it("applies the default in force when a new Session first runs", async () => {
    const { stub, registry } = await registered();

    await registry.updateSettings({ model: "anthropic/claude-haiku-5-5" }, 1);
    await script(stub, "one");
    await ask(stub, 1);

    expect(await requests(stub)).toEqual([{ model: "claude-haiku-5-5", thinking: "high" }]);
  });

  it("keeps what a Session picked, and follows the default for what it left alone", async () => {
    const { stub, registry } = await registered();

    await script(stub, "one", "two");
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.configure({ model: { provider: "anthropic", modelId: "claude-haiku-5-5" } }),
    );
    await ask(stub, 1);
    await registry.updateSettings(
      { model: "anthropic/claude-sonnet-5-5", thinkingLevel: "low" },
      1,
    );
    await ask(stub, 2);

    expect(await requests(stub)).toEqual([
      { model: "claude-haiku-5-5", thinking: "high" },
      { model: "claude-haiku-5-5", thinking: "low" },
    ]);
  });

  it("changes the model and thinking level of the next request when the Session picks them", async () => {
    const { stub } = await registered();

    await script(stub, "one", "two");
    await ask(stub, 1);
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.configure({
        model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
        thinkingLevel: "minimal",
      }),
    );
    await ask(stub, 2);

    expect(await requests(stub)).toEqual([
      { model: "claude-opus-5-5", thinking: "high" },
      { model: "claude-sonnet-5-5", thinking: "minimal" },
    ]);
  });

  it("follows the default again once its pick is cleared with null", async () => {
    const { stub, registry } = await registered();

    await script(stub, "one", "two");
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.configure({
        model: { provider: "anthropic", modelId: "claude-haiku-5-5" },
        thinkingLevel: "low",
      }),
    );
    await ask(stub, 1);
    await registry.updateSettings({ model: "anthropic/claude-sonnet-5-5" }, 1);
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.configure({ model: null, thinkingLevel: null }),
    );
    await ask(stub, 2);

    expect(await requests(stub)).toEqual([
      { model: "claude-haiku-5-5", thinking: "low" },
      { model: "claude-sonnet-5-5", thinking: "high" },
    ]);
  });

  it("keeps its pick across an eviction", async () => {
    const { stub } = await registered();

    await script(stub, "one");
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.configure({ model: { provider: "anthropic", modelId: "claude-haiku-5-5" } }),
    );
    await evictDurableObject(stub);
    await ask(stub, 1);

    expect(await requests(stub)).toEqual([{ model: "claude-haiku-5-5", thinking: "high" }]);
  });

  it("ignores a pick of a model the settings no longer accept, and follows the default", async () => {
    const { stub } = await registered();

    await script(stub, "one");
    // As an earlier release left it: a pick of a model that has since been dropped.
    await runInDurableObject(stub, (_instance: TestSession, state) => {
      state.storage.kv.put("agent-pick", {
        model: { provider: "anthropic", modelId: "claude-retired" },
        thinkingLevel: "low",
      });
    });
    await ask(stub, 1);

    expect(await requests(stub)).toEqual([{ model: "claude-opus-5-5", thinking: "low" }]);
  });

  it("carries on with the settings it last read while the Registry is down", async () => {
    const { stub, registry } = await registered();

    await script(stub, "one", "two", "three");
    await registry.updateSettings({ model: "anthropic/claude-sonnet-5-5" }, 1);
    await ask(stub, 1);

    await runInDurableObject(stub, (instance: TestSession) => instance.settingsRegistry("failing"));
    await ask(stub, 2);
    // A new instance has only what the last one kept.
    await evictDurableObject(stub);
    await ask(stub, 3);

    expect(await requests(stub)).toEqual([
      { model: "claude-sonnet-5-5", thinking: "high" },
      { model: "claude-sonnet-5-5", thinking: "high" },
      { model: "claude-sonnet-5-5", thinking: "high" },
    ]);
  });
});
