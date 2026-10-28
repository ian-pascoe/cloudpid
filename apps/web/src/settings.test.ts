// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import { DEFAULT_SETTINGS, overridesFrom, SettingsError, type Settings } from "@cloudpid/config";
import type { AgentChange, SettingsState } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "@effect/vitest";
import { failureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { modelsForm } from "./settings/forms.ts";
import {
  dismissSettingsChangeAtom,
  revertSettingsChangeAtom,
  settingsAtom,
  settingsChangesAtom,
} from "./settings.ts";

const stateOf = (settings: Settings): SettingsState => ({
  settings,
  overrides: overridesFrom(settings),
  overriddenIn: {},
});

describe("the settings", () => {
  it.effect("loads the settings the Registry answers with", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        getSettings: () => Effect.succeed(stateOf(DEFAULT_SETTINGS)),
      });

      registry.mount(settingsAtom);

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

  it.effect(
    "lists them, and a revert writes the old value back, which a section without a draft shows",
    () =>
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
        registry.mount(modelsForm.fields("*"));
        registry.mount(settingsChangesAtom);
        yield* settled(registry, modelsForm.loaded("*"));

        expect(AsyncResult.getOrThrow(yield* settled(registry, settingsChangesAtom))).toEqual([
          change(1),
        ]);
        expect(registry.get(modelsForm.fields("*"))?.model).toBe("anthropic/claude-haiku-5-5");

        registry.mount(revertSettingsChangeAtom);
        registry.set(revertSettingsChangeAtom, 1);
        yield* settled(registry, revertSettingsChangeAtom);
        yield* settled(registry, settingsChangesAtom);
        yield* settled(registry, modelsForm.loaded("*"));

        expect(reverted).toEqual([{ change: 1 }]);
        expect(AsyncResult.getOrThrow(registry.get(settingsChangesAtom))).toEqual([change(1, 2)]);
        expect(registry.get(modelsForm.fields("*"))?.model).toBe(DEFAULT_SETTINGS.model);
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
