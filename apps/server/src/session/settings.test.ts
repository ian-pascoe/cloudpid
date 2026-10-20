// @effect-diagnostics asyncFunction:off
import { DEFAULT_SETTINGS } from "@cloudpid/config";
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

/** A Registry whose saved overrides the test changes, or breaks. */
const registry = (overrides: Schema.Json = {}) => {
  const state = { overrides, failing: false, reads: 0 };

  return {
    state,
    read: Effect.suspend(() => {
      state.reads += 1;

      return state.failing
        ? Effect.die(new Error("Registry is down"))
        : Effect.succeed(state.overrides);
    }),
  };
};

const open = (
  source: Pick<ReturnType<typeof registry>, "read">,
  kv: SettingsKv = memoryKv(),
  timeout: Duration.Input = "2 seconds",
) =>
  Effect.runSync(
    Effect.gen(function* () {
      const services = yield* Layer.build(sessionSettingsLayer({ read: source.read, kv, timeout }));

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

    source.state.overrides = { compaction: { enabled: false } };
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

  it("fall back to the defaults when the kept overrides no longer resolve", () => {
    const kv = memoryKv();

    kv.put("settings-overrides", { model: "anthropic/retired-model" });

    expect(open(registry(), kv).current()).toEqual(valuesFrom(DEFAULT_SETTINGS));
  });
});

describe("the Harness's settings", () => {
  it("read the compaction policy live, so a refresh changes the next resolution", async () => {
    const source = registry();
    const settings = open(source);
    const live = harnessSettings(settings);

    expect(live.compaction).toEqual(DEFAULT_SETTINGS.compaction);

    source.state.overrides = { compaction: { enabled: false, reserveTokens: 1_000 } };
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
