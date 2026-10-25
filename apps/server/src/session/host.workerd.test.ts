// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Arr from "effect/Array";
import { describe, expect, it, vi } from "vitest";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { REQUEST_COST, type TestSession } from "./host.fixture.ts";

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

/**
 * `vi.waitFor`, with room for a loaded CI runner: its 1 s default timed out there while a Session settled (the Registry
 * reports ahead of the notification can take their full timeouts).
 */
const settles = <T>(check: () => Promise<T>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 50 });

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
const registered = async (prefix = "session") => {
  const sessionId = `${prefix}-${(counter += 1)}`;
  const registryName = `registry-${counter}`;
  const registry = env.REGISTRIES.getByName(registryName);
  const stub = env.SESSIONS.getByName(sessionId);

  await registry.createSession({ id: sessionId, title: null, workspace: NEW_IN_DEFAULT }, 1);
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
    await settles(async () => expect(await status()).toBe("idle"));

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

  it("notifies the owner when a run they started finishes, once", async () => {
    const { stub } = await registered();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["done"]);
      await instance.prompt({ requestId: "turn-1", text: "hi" });
    });

    await settles(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
      ).toEqual([{ kind: "finished" }]),
    );

    // Settling again (the heartbeat, a later wake) does not tell them twice.
    await runDurableObjectAlarm(stub);
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: TestSession) => instance.idle());
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.notified())).toEqual([
      { kind: "finished" },
    ]);
  });

  it("notifies the owner, after an eviction, of a run that finished while no client waited", async () => {
    const { stub } = await registered();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["hang", "recovered"]);
      await instance.submit({ requestId: "turn-1", text: "hi" });
      await instance.hanging.promise;
    });
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);

    await settles(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
      ).toEqual([{ kind: "finished" }]),
    );
  });

  it("notifies the owner, with the model's error, when a run fails", async () => {
    const { stub } = await registered();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["error:invalid request: the prompt is bad"]);
      await instance.prompt({ requestId: "turn-1", text: "hi" });
    });

    await settles(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
      ).toEqual([{ kind: "failed", reason: "invalid request: the prompt is bad" }]),
    );
  });

  it("notifies the owner once of the Agent changes a run made, besides its end", async () => {
    const { stub } = await registered("environment");

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script([
        'call:environment_variable_set:{"name":"API_URL","value":"https://api.test","reason":"The tests read it"}',
        'call:environment_variable_set:{"name":"MODE","value":"ci","reason":"The build reads it"}',
        "Set both.",
      ]);
      await instance.prompt({ requestId: "turn-1", text: "Set them" });
    });

    await settles(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
      ).toEqual([
        { kind: "finished" },
        {
          kind: "notice",
          body: '2 Agent changes: environment_variable_set "Default" variables.API_URL; environment_variable_set "Default" variables.MODE',
        },
      ]),
    );

    // A later run that changes nothing sends only its end.
    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["done"]);
      await instance.prompt({ requestId: "turn-2", text: "hi" });
    });

    await settles(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
      ).toHaveLength(3),
    );
  });

  it("says nothing of a run the owner stopped", async () => {
    const { stub, status } = await registered();

    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["hang"]);
      await instance.submit({ requestId: "turn-1", text: "hi" });
      await instance.hanging.promise;
      await instance.abortRoot();
    });
    await settles(async () => expect(await status()).toBe("idle"));
    await runDurableObjectAlarm(stub);

    expect(await runInDurableObject(stub, (instance: TestSession) => instance.notified())).toEqual(
      [],
    );
  });

  it("keeps a notification the Registry could not take, and sends it when the next run settles", async () => {
    const { stub } = await registered();

    await runInDurableObject(stub, (instance: TestSession) => instance.notifications("failing"));
    await runInDurableObject(stub, async (instance: TestSession) => {
      instance.script(["done", "again"]);
      await instance.prompt({ requestId: "turn-1", text: "hi" });
    });
    await runDurableObjectAlarm(stub);
    expect(await runInDurableObject(stub, (instance: TestSession) => instance.notified())).toEqual(
      [],
    );

    await runInDurableObject(stub, (instance: TestSession) => instance.notifications("working"));
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.prompt({ requestId: "turn-2", text: "hi again" }),
    );

    await settles(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
      ).toEqual([{ kind: "finished" }]),
    );
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

  it("defers the tools the offered set leaves out, and follows a change of it from the next request on", async () => {
    const { stub, registry } = await registered("tool-search");

    const offered = () =>
      runInDurableObject(stub, (instance: TestSession) => instance.offeredTools());

    await script(stub, "one", "two", "three");
    await ask(stub, 1);

    // The defaults offer neither echo nor todo, and always offer tool_search and context tools.
    await registry.updateSettings({ tools: { offered: ["echo", "secret_*"] } }, 1);
    await ask(stub, 2);

    // Defaults back: what the Registry saved is gone, so the offered set is the default again.
    await registry.updateSettings({}, 2);
    await ask(stub, 3);

    const [first, second, third] = await offered();

    expect(first).toContain("tool_search");
    expect(first).not.toContain("echo");
    expect(first).not.toContain("todo");
    expect(second).toEqual(
      expect.arrayContaining(["echo", "secret_ask", "secret_list", "tool_search"]),
    );
    expect(second).not.toContain("todo");
    expect(third).not.toContain("echo");
    expect(third).toContain("secret_ask");
    expect(third).not.toContain("secret_list");
  });

  it("runs the next request of the Run that changed the default on the new model, through settings_model_set", async () => {
    const { stub, registry } = await registered("settings");

    await script(
      stub,
      'call:settings_model_set:{"model":"anthropic/claude-sonnet-5-5","thinking_level":"low","reason":"The task is small"}',
      "Changed.",
    );
    await ask(stub, 1);

    expect(await requests(stub)).toEqual([
      { model: "claude-opus-5-5", thinking: "high" },
      { model: "claude-sonnet-5-5", thinking: "low" },
    ]);
    expect((await registry.getSettings()).overrides).toEqual({
      model: "anthropic/claude-sonnet-5-5",
      thinkingLevel: "low",
    });
    expect(await registry.listSettingsChanges()).toMatchObject([
      { field: "model", tool: "settings_model_set", reason: "The task is small" },
      { field: "thinkingLevel" },
    ]);

    await settles(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
      ).toEqual([
        { kind: "finished" },
        {
          kind: "notice",
          body: "2 Agent changes: settings_model_set model; settings_model_set thinkingLevel",
        },
      ]),
    );
  });

  it("leaves a Session's own pick alone when the agent changes the default", async () => {
    const { stub, registry } = await registered("settings");

    await script(
      stub,
      'call:settings_model_set:{"model":"anthropic/claude-sonnet-5-5","reason":"r"}',
      "Changed.",
    );
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.configure({ model: { provider: "anthropic", modelId: "claude-haiku-5-5" } }),
    );
    await ask(stub, 1);

    expect(await requests(stub)).toEqual([
      { model: "claude-haiku-5-5", thinking: "high" },
      { model: "claude-haiku-5-5", thinking: "high" },
    ]);
    expect((await registry.getSettings()).settings.model).toBe("anthropic/claude-sonnet-5-5");
  });

  it("refuses an invalid value with the owner's message, and records nothing", async () => {
    const { stub, registry } = await registered("settings");

    await script(
      stub,
      'call:settings_compaction_set:{"reserve_tokens":-1,"reason":"r"}',
      "Refused.",
    );
    await ask(stub, 1);

    expect(await registry.listSettingsChanges()).toEqual([]);
    expect((await registry.getSettings()).overrides).toEqual({});
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

describe("a Session's title", () => {
  const titled = async (replies: string[], script: string[] = ["It is fixed."]) => {
    const session = await registered();

    await runInDurableObject(session.stub, (instance: TestSession) => {
      instance.script(script);
      instance.titles(replies);
    });

    return session;
  };

  const ask = (stub: DurableObjectStub<TestSession>, n: number, text = "Fix the login bug") =>
    runInDurableObject(stub, (instance: TestSession) =>
      instance.prompt({ requestId: `turn-${n}`, text }),
    );

  const titleRequests = (stub: DurableObjectStub<TestSession>) =>
    runInDurableObject(stub, (instance: TestSession) => instance.titleRequests());

  const stored = async (registry: DurableObjectStub<TestRegistry>) => {
    const [session] = await registry.listSessions();

    return { title: session?.title, source: session?.titleSource };
  };

  it("names the Session after its first answer, with the small role's model and only once", async () => {
    const { stub, registry } = await titled(['"Fix the login bug."', "A second title"]);

    await ask(stub, 1);
    await settles(async () =>
      expect(await stored(registry)).toEqual({ title: "Fix the login bug", source: "generated" }),
    );

    const [request, ...more] = await titleRequests(stub);

    expect(request?.model).toBe("claude-haiku-5-5");
    // The first message and the answer, nothing else.
    expect(request?.messages).toContain("Fix the login bug");
    expect(request?.messages).toContain("It is fixed.");
    expect(more).toEqual([]);

    // Later answers do not name it again, not even from a new instance.
    await runInDurableObject(stub, (instance: TestSession) => instance.script(["Done again."]));
    await ask(stub, 2, "Now the tests");
    await evictDurableObject(stub);
    await ask(stub, 3, "And the docs");
    expect(await titleRequests(stub)).toHaveLength(1);
    expect(await stored(registry)).toEqual({ title: "Fix the login bug", source: "generated" });
  });

  it("does not hold up the Run: the answer and the idle report come before the title", async () => {
    const { stub, registry, status } = await titled(["gate:Fix the login bug"]);

    expect(await ask(stub, 1)).toMatchObject({ status: "answered", text: "It is fixed." });
    await runInDurableObject(stub, (instance: TestSession) => instance.gated.promise);
    await settles(async () => expect(await status()).toBe("idle"));
    expect(await stored(registry)).toEqual({ title: null, source: null });

    await runInDurableObject(stub, (instance: TestSession) => instance.open());
    await settles(async () =>
      expect(await stored(registry)).toEqual({ title: "Fix the login bug", source: "generated" }),
    );
  });

  it("keeps a title the owner set before the first answer, and never asks the model", async () => {
    const { stub, registry } = await titled(["Generated"]);

    await registry.renameSession("session-" + counter, "My name");
    await ask(stub, 1);
    await runDurableObjectAlarm(stub);
    await evictDurableObject(stub);
    await ask(stub, 2);

    expect(await titleRequests(stub)).toEqual([]);
    expect(await stored(registry)).toEqual({ title: "My name", source: "owner" });
  });

  it("keeps a title the owner set while it was being generated", async () => {
    const { stub, registry } = await titled(["gate:Generated"]);

    await ask(stub, 1);
    await runInDurableObject(stub, (instance: TestSession) => instance.gated.promise);
    await registry.renameSession("session-" + counter, "My name");
    await runInDurableObject(stub, (instance: TestSession) => instance.open());

    await settles(async () => {
      const [request] = await titleRequests(stub);

      expect(request).toBeDefined();
      // The title was offered and refused: the Session does not look again.
      expect(
        await runInDurableObject(stub, (_i, state) => state.storage.kv.get("title-task")),
      ).toMatchObject({
        done: true,
      });
    });
    expect(await stored(registry)).toEqual({ title: "My name", source: "owner" });
  });

  it("names a Session whose first Run an eviction cut off, once it finishes", async () => {
    const { stub, registry } = await titled(["Fix the login bug"], ["hang", "Finally fixed."]);

    await runInDurableObject(stub, async (instance: TestSession) => {
      await instance.submit({ requestId: "turn-1", text: "Fix the login bug" });
      await instance.hanging.promise;
    });
    await evictDurableObject(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await settles(async () =>
      expect(await stored(registry)).toEqual({ title: "Fix the login bug", source: "generated" }),
    );
    expect((await titleRequests(stub))[0]?.messages).toContain("Finally fixed.");
  });

  it("tries again at a later answer, even after an eviction, when the Registry could not be reached", async () => {
    const { stub, registry } = await titled(["First try", "Fix the login bug"]);

    await runInDurableObject(stub, (instance: TestSession) => instance.titleRegistry("failing"));
    await ask(stub, 1);
    await runInDurableObject(stub, (instance: TestSession) => instance.idle());
    expect(await stored(registry)).toEqual({ title: null, source: null });

    // One answer is one attempt, however many times the Session settles.
    const attempts = () =>
      runInDurableObject(
        stub,
        (_instance: TestSession, state) =>
          state.storage.kv.get<{ attempts: number }>("title-task")?.attempts,
      );

    await settles(async () => expect(await attempts()).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await attempts()).toBe(1);

    // The attempt is kept across an eviction, and a later answer tries again.
    await evictDurableObject(stub);
    await runInDurableObject(stub, (instance: TestSession) => {
      instance.titleRegistry("working");
      instance.script(["Fixed again."]);
    });
    await ask(stub, 2, "Now the tests");

    await settles(async () =>
      expect(await stored(registry)).toEqual({ title: "First try", source: "generated" }),
    );
  });

  it("shows the model no Secret the Session holds", async () => {
    const { stub, registry } = await titled(["Rotate the credentials"]);
    const secret = "hunter2-correct-horse-battery";

    await runInDurableObject(stub, (instance: TestSession) => instance.hold({ API_KEY: secret }));
    await ask(stub, 1, `Rotate the key ${secret} please`);

    await settles(async () =>
      expect(await stored(registry)).toEqual({
        title: "Rotate the credentials",
        source: "generated",
      }),
    );

    const [request] = await titleRequests(stub);

    expect(request?.messages).toContain("Rotate the key");
    expect(request?.messages).not.toContain(secret);
  });

  it("cuts a long first message and answer before the model sees them", async () => {
    const { stub, registry } = await titled(["A very long title"], ["y".repeat(50_000)]);

    await ask(stub, 1, "x".repeat(50_000));
    await settles(async () => expect((await stored(registry)).source).toBe("generated"));

    const [request] = await titleRequests(stub);

    expect(request?.messages.length).toBeLessThan(10_000);
  });
});

describe("a Session's spend limit", () => {
  const ask = (stub: DurableObjectStub<TestSession>, n: number) =>
    runInDurableObject(stub, (instance: TestSession) =>
      instance.prompt({ requestId: `turn-${n}`, text: "hi" }),
    );

  const requests = (stub: DurableObjectStub<TestSession>) =>
    runInDurableObject(stub, (instance: TestSession) => instance.requests());

  it("refuses the request that would follow once the Session has spent its limit, and tells the owner why", async () => {
    const { stub, registry } = await registered();

    // One request costs `REQUEST_COST`: the Run's second request finds the Session at its limit.
    await registry.updateSettings({ spendLimit: { perSession: REQUEST_COST } }, 1);
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script(['call:echo:{"text":"one"}', "never sent"]),
    );

    expect(await ask(stub, 1)).toMatchObject({ status: "unanswered", reason: "model_error" });
    expect(await requests(stub)).toHaveLength(1);

    await settles(async () =>
      expect(
        await runInDurableObject(stub, (instance: TestSession) => instance.notified()),
      ).toEqual([{ kind: "failed", reason: expect.stringContaining("out of budget") }]),
    );
  });

  it("holds every later prompt to it, across an eviction, until the limit is raised or cleared", async () => {
    const { stub, registry } = await registered();

    await registry.updateSettings({ spendLimit: { perSession: REQUEST_COST } }, 1);
    await runInDurableObject(stub, (instance: TestSession) => instance.script(["first answer"]));
    expect(await ask(stub, 1)).toMatchObject({ status: "answered", text: "first answer" });

    await evictDurableObject(stub);
    expect(await ask(stub, 2)).toMatchObject({ status: "unanswered", reason: "model_error" });
    expect(await requests(stub)).toHaveLength(1);

    await registry.updateSettings({ spendLimit: { perSession: 10 } }, 2);
    await runInDurableObject(stub, (instance: TestSession) => instance.script(["second answer"]));
    expect(await ask(stub, 3)).toMatchObject({ status: "answered", text: "second answer" });

    await registry.updateSettings({ spendLimit: { perSession: REQUEST_COST } }, 3);
    expect(await ask(stub, 4)).toMatchObject({ status: "unanswered", reason: "model_error" });

    await registry.updateSettings({}, 4);
    await runInDurableObject(stub, (instance: TestSession) => instance.script(["third answer"]));
    expect(await ask(stub, 5)).toMatchObject({ status: "answered", text: "third answer" });
  });

  it("is off by default: a Session spends without bound", async () => {
    const { stub } = await registered();

    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script(["one", "two", "three"]),
    );

    for (const n of [1, 2, 3]) {
      expect(await ask(stub, n)).toMatchObject({ status: "answered" });
    }
  });

  it("does not stop the title call, which it counts", async () => {
    const session = await registered();

    await session.registry.updateSettings({ spendLimit: { perSession: REQUEST_COST } }, 1);
    await runInDurableObject(session.stub, (instance: TestSession) => {
      instance.script(["It is fixed."]);
      instance.titles(["Fix the login bug"]);
    });

    // The answer is the Session's only request under its limit; the title call goes through although it is now at it.
    expect(await ask(session.stub, 1)).toMatchObject({ status: "answered" });
    await settles(async () =>
      expect((await session.registry.listSessions())[0]?.titleSource).toBe("generated"),
    );
    expect(
      await runInDurableObject(session.stub, (instance: TestSession) => instance.spent()),
    ).toBeCloseTo(2 * REQUEST_COST);
  });
});

describe("a Session's spans", () => {
  const spansOf = (stub: DurableObjectStub<TestSession>, name: string) =>
    runInDurableObject(stub, (instance: TestSession) =>
      Arr.filter(instance.spans(), (span) => span.name === name),
    );

  const prompt = (stub: DurableObjectStub<TestSession>, n: number) =>
    runInDurableObject(stub, (instance: TestSession) =>
      instance.prompt({ requestId: `turn-${n}`, text: "hi" }),
    );

  it("makes each Run a session.run span that ends with its outcome", async () => {
    const { stub } = await registered();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["one", "two"]));
    await prompt(stub, 1);
    await prompt(stub, 2);

    await settles(async () => {
      const runs = await spansOf(stub, "session.run");

      expect(runs).toHaveLength(2);
      expect(Arr.every(runs, (run) => run.ended)).toBe(true);
    });

    const [first] = await spansOf(stub, "session.run");

    expect(first?.attributes).toMatchObject({ "run.outcome": "done" });
  });

  it("ends the span of a Run the spend limit stopped, with the reason", async () => {
    const { stub, registry } = await registered();

    await registry.updateSettings({ spendLimit: { perSession: REQUEST_COST } }, 1);
    await runInDurableObject(stub, (instance: TestSession) =>
      instance.script(['call:echo:{"text":"one"}', "never sent"]),
    );
    await prompt(stub, 1);

    await settles(async () =>
      expect((await spansOf(stub, "session.run"))[0]).toMatchObject({
        ended: true,
        attributes: { "run.outcome": "model_error" },
      }),
    );
  });

  it("makes resuming work after an eviction a session.resume span", async () => {
    const { stub } = await registered();

    await runInDurableObject(stub, (instance: TestSession) => instance.script(["hi"]));
    await prompt(stub, 1);
    await evictDurableObject(stub);
    await runDurableObjectAlarm(stub);
    expect(await spansOf(stub, "session.resume")).not.toHaveLength(0);
  });
});
