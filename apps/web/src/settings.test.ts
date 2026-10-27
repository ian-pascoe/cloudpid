// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import { DEFAULT_SETTINGS, overridesFrom, SettingsError, type Settings } from "@cloudpid/config";
import type { AgentChange, SettingsState } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "@effect/vitest";
import { offeredToText } from "./offered-tools.ts";
import { failureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { spendLimitToText } from "./spend-limit.ts";
import {
  dismissSettingsChangeAtom,
  justSavedAtom,
  limitTextAtom,
  offeredTextAtom,
  revertSettingsChangeAtom,
  settingsAtom,
  settingsChangesAtom,
  settingsDraftAtom,
  updateSettingsAtom,
} from "./settings.ts";

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

describe("the settings form", () => {
  /** The atoms the form reads, mounted once the settings have loaded. */
  const opened = (settings: Settings) =>
    Effect.gen(function* () {
      const held = holding(settings);

      yield* settled(held.registry, settingsAtom);
      held.registry.mount(settingsDraftAtom);
      held.registry.mount(offeredTextAtom);
      held.registry.mount(limitTextAtom);
      held.registry.mount(justSavedAtom);

      return held.registry;
    });

  it.effect("starts as the settings in force, with the text boxes saying the same", () =>
    Effect.gen(function* () {
      const registry = yield* opened(DEFAULT_SETTINGS);

      expect(registry.get(settingsDraftAtom)).toEqual(DEFAULT_SETTINGS);
      expect(registry.get(offeredTextAtom)).toBe(offeredToText(DEFAULT_SETTINGS.tools.offered));
      expect(registry.get(limitTextAtom)).toBe(
        spendLimitToText(DEFAULT_SETTINGS.spendLimit.perSession),
      );
    }),
  );

  it.effect("keeps what was typed when the settings are loaded again", () =>
    Effect.gen(function* () {
      const registry = yield* opened(DEFAULT_SETTINGS);

      registry.set(settingsDraftAtom, { ...DEFAULT_SETTINGS, thinkingLevel: "low" });
      registry.set(limitTextAtom, "12.50");
      registry.refresh(settingsAtom);
      yield* settled(registry, settingsAtom);

      expect(registry.get(settingsDraftAtom).thinkingLevel).toBe("low");
      expect(registry.get(limitTextAtom)).toBe("12.50");
    }),
  );

  it.effect("says it saved once a save works, until the draft changes", () =>
    Effect.gen(function* () {
      const registry = yield* opened(DEFAULT_SETTINGS);

      registry.set(settingsDraftAtom, { ...DEFAULT_SETTINGS, thinkingLevel: "high" });
      registry.set(updateSettingsAtom, registry.get(settingsDraftAtom));
      yield* settled(registry, updateSettingsAtom);

      expect(registry.get(justSavedAtom)).toBe(true);

      registry.set(settingsDraftAtom, { ...DEFAULT_SETTINGS, thinkingLevel: "low" });

      expect(registry.get(justSavedAtom)).toBe(false);
    }),
  );

  it.effect("does not say it saved when the save was refused", () =>
    Effect.gen(function* () {
      const registry = yield* opened(DEFAULT_SETTINGS);

      registry.set(updateSettingsAtom, { ...DEFAULT_SETTINGS, thinkingLevel: "high" });
      yield* settled(registry, updateSettingsAtom);
      registry.set(updateSettingsAtom, { ...DEFAULT_SETTINGS, thinkingLevel: "max" });
      yield* settled(registry, updateSettingsAtom);

      expect(registry.get(justSavedAtom)).toBe(false);
    }),
  );
});

describe("the Settings' Agent changes", () => {
  const change = (id: number, revertedBy: number | null = null): AgentChange => ({
    id,
    scope: "settings",
    at: 1_000,
    actor: "agent",
    session: "s-1",
    conversation: 1,
    tool: "settings_model_set",
    reason: "The task is small",
    field: "model",
    before: DEFAULT_SETTINGS.model,
    after: "anthropic/claude-haiku-5-5",
    reverts: null,
    revertedBy,
  });

  it.effect("lists them, and a revert writes the old value back and shows it in the form", () =>
    Effect.gen(function* () {
      const reverted: unknown[] = [];
      let held: Settings = { ...DEFAULT_SETTINGS, model: "anthropic/claude-haiku-5-5" };

      const registry = registryWith({
        getSettings: () => Effect.sync(() => stateOf(held)),
        listSettingsChanges: () => Effect.succeed([change(1, reverted.length === 0 ? null : 2)]),
        revertSettingsChange: (input) =>
          Effect.sync(() => {
            reverted.push(input);
            held = DEFAULT_SETTINGS;

            return { ...change(2), actor: "owner" as const, reverts: 1 };
          }),
      });

      registry.mount(settingsAtom);
      registry.mount(settingsDraftAtom);
      registry.mount(settingsChangesAtom);
      yield* settled(registry, settingsAtom);

      expect(AsyncResult.getOrThrow(yield* settled(registry, settingsChangesAtom))).toEqual([
        change(1),
      ]);
      expect(registry.get(settingsDraftAtom).model).toBe("anthropic/claude-haiku-5-5");

      registry.mount(revertSettingsChangeAtom);
      registry.set(revertSettingsChangeAtom, 1);
      yield* settled(registry, revertSettingsChangeAtom);
      yield* settled(registry, settingsChangesAtom);

      expect(reverted).toEqual([{ change: 1 }]);
      expect(AsyncResult.getOrThrow(registry.get(settingsChangesAtom))).toEqual([change(1, 2)]);
      expect(registry.get(settingsDraftAtom)).toEqual(DEFAULT_SETTINGS);
      registry.dispose();
    }),
  );

  it.effect("say why a revert was refused", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        revertSettingsChange: () =>
          Effect.fail(
            new SettingsError({ message: "model has changed since: it is x now, so not reverted" }),
          ),
      });

      registry.mount(revertSettingsChangeAtom);
      registry.set(revertSettingsChangeAtom, 1);

      expect(failureOf(yield* settled(registry, revertSettingsChangeAtom))).toBe(
        "model has changed since: it is x now, so not reverted",
      );
      registry.dispose();
    }),
  );

  it.effect("leave the list once dismissed, keeping the setting as it is", () =>
    Effect.gen(function* () {
      const dismissed: unknown[] = [];

      const registry = registryWith({
        listSettingsChanges: () =>
          Effect.sync(() => (dismissed.length === 0 ? [change(2), change(1)] : [change(2)])),
        dismissSettingsChange: (input) =>
          Effect.sync(() => {
            dismissed.push(input);
          }),
      });

      registry.mount(settingsChangesAtom);
      yield* settled(registry, settingsChangesAtom);

      registry.mount(dismissSettingsChangeAtom);
      registry.set(dismissSettingsChangeAtom, 1);
      yield* settled(registry, dismissSettingsChangeAtom);
      yield* settled(registry, settingsChangesAtom);

      expect(dismissed).toEqual([{ change: 1 }]);
      expect(AsyncResult.getOrThrow(registry.get(settingsChangesAtom))).toEqual([change(2)]);
      registry.dispose();
    }),
  );
});
