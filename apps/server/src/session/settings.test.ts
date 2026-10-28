// @effect-diagnostics asyncFunction:off
import { DEFAULT_OFFERED_TOOLS, DEFAULT_SETTINGS, resolveLeniently } from "@cloudpid/config";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  harnessSettings,
  SessionSettings,
  sessionSettingsLayer,
  type SettingsKv,
  toolSearchSettings,
  valuesFrom,
} from "./settings.ts";

/** An in-memory `storage.kv`. */
const memoryKv = (): SettingsKv => {
  const values = new Map<string, unknown>();

  return {
    // SAFETY: only this test writes the map, and it stores what it reads back.
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: (key, value) => void values.set(key, value),
  };
};

/**
 * A Registry whose saved overrides the test changes, or breaks: Global's, and the Overrides of the Environment the
 * Session works in.
 */
const registry = (global: Schema.Json = {}, own: Schema.Json = {}) => {
  const state = { global, own, failing: false, reads: 0 };

  return {
    state,
    read: Effect.suspend(() => {
      state.reads += 1;

      return state.failing
        ? Effect.die(new Error("Registry is down"))
        : Effect.succeed({ global: state.global, overrides: state.own });
    }),
  };
};

const open = (
  source: Pick<ReturnType<typeof registry>, "read">,
  kv: SettingsKv = memoryKv(),
  timeout: Duration.Input = "2 seconds",
  backoff: Duration.Input = 0,
) =>
  Effect.runSync(
    Effect.gen(function* () {
      const services = yield* Layer.build(
        sessionSettingsLayer({ read: source.read, kv, timeout, backoff }),
      );

      return Context.get(services, SessionSettings);
    }).pipe(Effect.scoped),
  );

describe("a Session's settings", () => {
  it("are the defaults until the Registry has been read", () => {
    const settings = open(registry({ model: "anthropic/claude-sonnet-5-5" }));

    expect(settings.current()).toEqual(valuesFrom(DEFAULT_SETTINGS));
    expect(settings.current().agent).toEqual({
      model: { provider: "anthropic", modelId: "claude-opus-5-5" },
      thinkingLevel: "high",
    });
  });

  it("follow the Registry's overrides once refreshed, and again whenever they change", async () => {
    const source = registry({ model: "anthropic/claude-sonnet-5-5", thinkingLevel: "low" });
    const settings = open(source);

    await Effect.runPromise(settings.refresh);
    expect(settings.current().agent).toEqual({
      model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
      thinkingLevel: "low",
    });

    source.state.global = { compaction: { enabled: false } };
    await Effect.runPromise(settings.refresh);
    expect(settings.current().agent).toEqual(valuesFrom(DEFAULT_SETTINGS).agent);
    expect(settings.current().compaction.enabled).toBe(false);
  });

  it("keep the last overrides read while the Registry fails", async () => {
    const source = registry({ thinkingLevel: "low" });
    const settings = open(source);

    await Effect.runPromise(settings.refresh);
    source.state.failing = true;
    await Effect.runPromise(settings.refresh);

    expect(settings.current().agent.thinkingLevel).toBe("low");
  });

  it("keep the last overrides read while the Registry is too slow", async () => {
    const kv = memoryKv();
    const source = registry({ thinkingLevel: "low" });

    await Effect.runPromise(open(source, kv).refresh);

    const stuck = open({ read: Effect.never }, kv, "10 millis");

    await Effect.runPromise(stuck.refresh);
    expect(stuck.current().agent.thinkingLevel).toBe("low");
  });

  it("start a new instance from the overrides the last one read, with the Registry down", async () => {
    const kv = memoryKv();
    const source = registry({ thinkingLevel: "low" });

    await Effect.runPromise(open(source, kv).refresh);
    source.state.failing = true;

    expect(open(source, kv).current().agent.thinkingLevel).toBe("low");
  });

  it("leave the Registry alone for the backoff after a read fails, so a Registry that is down costs one try", async () => {
    const source = registry({ thinkingLevel: "low" });
    const settings = open(source, memoryKv(), "2 seconds", "1 hour");

    source.state.failing = true;
    await Effect.runPromise(settings.refresh);
    await Effect.runPromise(settings.refresh);
    expect(source.state.reads).toBe(1);

    // Once the backoff is over, the next read goes through; a read that works ends it.
    const quick = open(source, memoryKv(), "2 seconds", 0);

    await Effect.runPromise(quick.refresh);
    await Effect.runPromise(quick.refresh);
    expect(source.state.reads).toBe(3);

    source.state.failing = false;
    await Effect.runPromise(quick.refresh);
    expect(quick.current().agent.thinkingLevel).toBe("low");
  });

  it("keep the kept overrides that still resolve when another no longer does", () => {
    const kv = memoryKv();

    kv.put("settings-overrides", { model: "anthropic/retired-model", thinkingLevel: "low" });

    const settings = open(registry(), kv).current();

    expect(settings.agent.thinkingLevel).toBe("low");
    expect(settings.agent.model).toEqual(valuesFrom(DEFAULT_SETTINGS).agent.model);
  });

  it("run a Session in an Environment with its Overrides, and one in another with Global's", async () => {
    const source = (own: Schema.Json) => registry({ model: "anthropic/claude-sonnet-5-5" }, own);
    const inA = open(source({ model: "anthropic/claude-haiku-5-5", thinkingLevel: "low" }));
    const inB = open(source({}));

    await Effect.runPromise(inA.refresh);
    await Effect.runPromise(inB.refresh);

    expect(inA.current().agent).toEqual({
      model: { provider: "anthropic", modelId: "claude-haiku-5-5" },
      thinkingLevel: "low",
    });
    expect(inB.current().agent).toEqual({
      model: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
      thinkingLevel: "high",
    });
  });

  it("keep an Environment's Override equal to Global when Global changes, until it is reset", async () => {
    const source = registry(
      { model: "anthropic/claude-sonnet-5-5" },
      { model: "anthropic/claude-sonnet-5-5" },
    );

    const settings = open(source);

    source.state.global = { model: "anthropic/claude-haiku-5-5" };
    await Effect.runPromise(settings.refresh);
    expect(settings.current().agent.model.modelId).toBe("claude-sonnet-5-5");

    source.state.own = {};
    await Effect.runPromise(settings.refresh);
    expect(settings.current().agent.model.modelId).toBe("claude-haiku-5-5");
  });

  it("start, after the deploy that gave Environments Overrides, from Global's overrides an earlier release kept, as before", async () => {
    const kv = memoryKv();

    const before = {
      model: "anthropic/claude-sonnet-5-5",
      thinkingLevel: "minimal",
      tools: { offered: ["read", "restart_container"] },
      spendLimit: { perSession: 3 },
    };

    // What a Session of the earlier release kept: Global's overrides alone.
    kv.put("settings-overrides", before);

    const source = registry();

    source.state.failing = true;

    const settings = open(source, kv);

    expect(settings.current()).toEqual(valuesFrom(resolveLeniently(before).settings));

    // Its first read, from a Registry whose Environments have no Overrides yet, resolves the same.
    source.state.failing = false;
    source.state.global = before;
    await Effect.runPromise(settings.refresh);
    expect(settings.current()).toEqual(valuesFrom(resolveLeniently(before).settings));
  });

  it("fall back to the defaults when the kept overrides no longer resolve", () => {
    const kv = memoryKv();

    kv.put("settings-overrides", { model: "anthropic/retired-model" });

    expect(open(registry(), kv).current()).toEqual(valuesFrom(DEFAULT_SETTINGS));
  });
});

describe("the offered tools", () => {
  it("are the default core tools until the Registry has been read, and follow its overrides after", async () => {
    const source = registry({ tools: { offered: ["read", "web_*"] } });
    const settings = open(source);

    const offered = Effect.runSync(
      toolSearchSettings.pipe(Effect.provideService(SessionSettings, settings)),
    );

    expect(offered.current().offered).toEqual(DEFAULT_OFFERED_TOOLS);

    await Effect.runPromise(settings.refresh);
    expect(offered.current().offered).toEqual(["read", "web_*"]);

    source.state.global = {};
    await Effect.runPromise(settings.refresh);
    expect(offered.current().offered).toEqual(DEFAULT_OFFERED_TOOLS);
  });
});

describe("the spend limit", () => {
  it("is off until the Registry has been read, and follows its overrides after", async () => {
    const source = registry({ spendLimit: { perSession: 2.5 } });
    const settings = open(source);

    expect(settings.current().spendLimit).toBeNull();

    await Effect.runPromise(settings.refresh);
    expect(settings.current().spendLimit).toBe(2.5);

    source.state.global = {};
    await Effect.runPromise(settings.refresh);
    expect(settings.current().spendLimit).toBeNull();
  });

  it("is the Environment's own where it overrides Global's, so it stops only that Environment's Sessions", async () => {
    const global = { spendLimit: { perSession: 10 } };
    const inA = open(registry(global, { spendLimit: { perSession: 0.5 } }));
    const inB = open(registry(global));
    const unlimitedInC = open(registry(global, { spendLimit: { perSession: null } }));

    await Effect.runPromise(inA.refresh);
    await Effect.runPromise(inB.refresh);
    await Effect.runPromise(unlimitedInC.refresh);

    expect(inA.current().spendLimit).toBe(0.5);
    expect(inB.current().spendLimit).toBe(10);
    expect(unlimitedInC.current().spendLimit).toBeNull();
  });
});

describe("the Harness's settings", () => {
  it("read the compaction policy live, so a refresh changes the next resolution", async () => {
    const source = registry();
    const settings = open(source);
    const live = harnessSettings(settings);

    expect(live.compaction).toEqual(DEFAULT_SETTINGS.compaction);

    source.state.global = { compaction: { enabled: false, reserveTokens: 1_000 } };
    await Effect.runPromise(settings.refresh);

    expect(live.compaction).toEqual({
      ...DEFAULT_SETTINGS.compaction,
      enabled: false,
      reserveTokens: 1_000,
    });
  });

  it("keep no idle contexts or documents in memory, as Workers need", () => {
    const live = harnessSettings(open(registry()));

    expect(live.contextRetentionMs).toBe(0);
    expect(live.documentRetentionMs).toBe(0);
  });
});
