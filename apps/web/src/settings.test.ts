// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import { DEFAULT_SETTINGS, overridesFrom, SettingsError, type Settings } from "@cloudpid/config";
import type { SettingsState } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "@effect/vitest";
import { failureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { settingsAtom, updateSettingsAtom } from "./settings.ts";

const stateOf = (settings: Settings): SettingsState => ({
  settings,
  overrides: overridesFrom(settings),
});

/** A Registry holding `settings`, which an update replaces unless it asks for the "max" thinking level, which the Registry refuses. */
const holding = (settings: Settings) => {
  let held = settings;
  const saved: unknown[] = [];

  const registry = registryWith({
    getSettings: () => Effect.sync(() => stateOf(held)),
    updateSettings: ({ overrides }) =>
      JSON.stringify(overrides).includes("max")
        ? Effect.fail(new SettingsError({ message: "thinkingLevel: not supported" }))
        : Effect.sync(() => {
            saved.push(overrides);
            held = { ...held, thinkingLevel: "high" };

            return stateOf(held);
          }),
  });

  registry.mount(settingsAtom);

  return { registry, saved };
};

describe("the settings", () => {
  it.effect("loads the settings the Registry answers with", () =>
    Effect.gen(function* () {
      const { registry } = holding(DEFAULT_SETTINGS);
      const result = yield* settled(registry, settingsAtom);

      expect(AsyncResult.getOrThrow(result).settings).toEqual(DEFAULT_SETTINGS);
    }),
  );

  it.effect("says why when the Registry cannot answer them", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        getSettings: () => Effect.die(new Error("The Registry is down.")),
      });

      registry.mount(settingsAtom);

      expect(failureOf(yield* settled(registry, settingsAtom))).toBe("The Registry is down.");
    }),
  );

  it.effect(
    "saves the overrides of the settings, answers with the new state, and loads again",
    () =>
      Effect.gen(function* () {
        const { registry, saved } = holding(DEFAULT_SETTINGS);

        yield* settled(registry, settingsAtom);
        registry.set(updateSettingsAtom, { ...DEFAULT_SETTINGS, thinkingLevel: "high" });

        const answer = yield* settled(registry, updateSettingsAtom);

        expect(AsyncResult.getOrThrow(answer).settings.thinkingLevel).toBe("high");
        expect(saved).toEqual([overridesFrom({ ...DEFAULT_SETTINGS, thinkingLevel: "high" })]);
        expect(
          AsyncResult.getOrThrow(yield* settled(registry, settingsAtom)).settings.thinkingLevel,
        ).toBe("high");
      }),
  );

  it.effect(
    "says why a save was refused, with the Registry's message, and keeps the settings",
    () =>
      Effect.gen(function* () {
        const { registry, saved } = holding(DEFAULT_SETTINGS);

        yield* settled(registry, settingsAtom);
        registry.set(updateSettingsAtom, { ...DEFAULT_SETTINGS, thinkingLevel: "max" });

        expect(failureOf(yield* settled(registry, updateSettingsAtom))).toBe(
          "thinkingLevel: not supported",
        );
        expect(saved).toEqual([]);
        expect(AsyncResult.getOrThrow(yield* settled(registry, settingsAtom)).settings).toEqual(
          DEFAULT_SETTINGS,
        );
      }),
  );
});
