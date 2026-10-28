// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

// The Settings page's section forms (`forms.ts`) over the fake Registry: each section's Save sends the value as the
// Registry has it now with only the fields the owner changed replaced (the Container settings as a patch of them), so
// another section's draft is never sent, and a draft is kept per Scope until it is saved.

import {
  ContainerOverrides,
  type ContainerSettingsOverrides,
  DEFAULT_CONTAINER_SETTINGS,
  DEFAULT_SETTINGS,
  overridesFrom,
  patchContainerOverrides,
  resolveEnvironmentContainerSettings,
  resolveSettings,
  SettingsError,
  type Settings,
} from "@cloudpid/config";
import type { ContainerSettingsState, SettingsState } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schema from "effect/Schema";
import { failureOf } from "../registry.ts";
import { registryWith, settled } from "../registry.testing.ts";
import type { SectionForm } from "./drafts.ts";
import {
  containerSectionForm,
  environmentNameForm,
  environmentVariablesForm,
  generalForm,
  globalLimitsForm,
  globalVariablesForm,
  modelsForm,
  setupForm,
  toolsForm,
} from "./forms.ts";

const GLOBAL = "*";
const HAIKU = "anthropic/claude-haiku-5-5";

const stateOf = (settings: Settings): SettingsState => ({
  settings,
  overrides: overridesFrom(settings),
  overriddenIn: {},
});

/** A Registry holding `settings`, keeping each save; a save asking for the "max" thinking level is refused. */
const holdingSettings = (settings: Settings) => {
  const held = { settings };
  const saved: unknown[] = [];

  const registry = registryWith({
    getSettings: () => Effect.sync(() => stateOf(held.settings)),
    updateSettings: ({ overrides }) =>
      JSON.stringify(overrides).includes('"max"')
        ? Effect.fail(new SettingsError({ message: "thinkingLevel: not supported" }))
        : Effect.sync(() => {
            saved.push(overrides);
            held.settings = Result.getOrThrow(resolveSettings(overrides));

            return stateOf(held.settings);
          }),
  });

  return { registry, saved, held };
};

/** Run `form`'s Save at `scope`, with its query mounted as the section mounts it, and answer how it ended. */
const save = <Fields, E>(
  registry: AtomRegistry.AtomRegistry,
  form: SectionForm<Fields, E>,
  scope: string,
) =>
  Effect.gen(function* () {
    registry.mount(form.save(scope));
    registry.set(form.save(scope), undefined);

    return yield* settled(registry, form.save(scope));
  });

/** Wait until `form` shows something at `scope`, as a section waits for its saved value. */
const opened = <Fields, E>(
  registry: AtomRegistry.AtomRegistry,
  form: SectionForm<Fields, E>,
  scope: string,
) =>
  Effect.gen(function* () {
    registry.mount(form.fields(scope));
    registry.mount(form.dirty(scope));
    yield* settled(registry, form.loaded(scope));
  });

describe("a Settings section's Save", () => {
  it.effect(
    "sends the saved Settings with only its own fields replaced, and keeps another section's draft",
    () =>
      Effect.gen(function* () {
        const { registry, saved } = holdingSettings(DEFAULT_SETTINGS);

        yield* opened(registry, modelsForm, GLOBAL);
        yield* opened(registry, generalForm, GLOBAL);
        registry.set(generalForm.draft(GLOBAL), { skipPrompt: true });
        registry.set(modelsForm.draft(GLOBAL), {
          ...DEFAULT_SETTINGS,
          model: HAIKU,
          thinkingLevel: "low",
          roles: DEFAULT_SETTINGS.roles,
        });

        expect(registry.get(modelsForm.dirty(GLOBAL))).toBe(true);
        expect(registry.get(generalForm.dirty(GLOBAL))).toBe(true);

        yield* save(registry, modelsForm, GLOBAL);

        expect(saved).toEqual([
          overridesFrom({ ...DEFAULT_SETTINGS, model: HAIKU, thinkingLevel: "low" }),
        ]);
        expect(registry.get(modelsForm.draft(GLOBAL))).toBeUndefined();
        expect(registry.get(modelsForm.dirty(GLOBAL))).toBe(false);
        expect(registry.get(modelsForm.fields(GLOBAL))?.model).toBe(HAIKU);
        expect(registry.get(modelsForm.justSaved(GLOBAL))).toBe(true);
        // General's draft is still there, unsaved.
        expect(registry.get(generalForm.dirty(GLOBAL))).toBe(true);
        expect(registry.get(generalForm.fields(GLOBAL))).toEqual({ skipPrompt: true });
        registry.dispose();
      }),
  );

  it.effect(
    "writes over the Settings as the Registry has them now, not as the page last read them",
    () =>
      Effect.gen(function* () {
        const { registry, saved, held } = holdingSettings(DEFAULT_SETTINGS);

        yield* opened(registry, toolsForm, GLOBAL);
        // The agent changes the model after the page read the Settings.
        held.settings = { ...DEFAULT_SETTINGS, model: HAIKU };
        registry.set(toolsForm.draft(GLOBAL), { offered: "read\nbash" });
        yield* save(registry, toolsForm, GLOBAL);

        expect(saved).toEqual([
          overridesFrom({
            ...DEFAULT_SETTINGS,
            model: HAIKU,
            tools: { ...DEFAULT_SETTINGS.tools, offered: ["read", "bash"] },
          }),
        ]);
        registry.dispose();
      }),
  );

  it.effect("says why it was refused, and keeps the draft", () =>
    Effect.gen(function* () {
      const { registry, saved } = holdingSettings(DEFAULT_SETTINGS);

      yield* opened(registry, modelsForm, GLOBAL);
      registry.set(modelsForm.draft(GLOBAL), {
        model: DEFAULT_SETTINGS.model,
        thinkingLevel: "max",
        roles: DEFAULT_SETTINGS.roles,
      });

      expect(failureOf(yield* save(registry, modelsForm, GLOBAL))).toBe(
        "thinkingLevel: not supported",
      );
      expect(saved).toEqual([]);
      expect(registry.get(modelsForm.draft(GLOBAL))?.thinkingLevel).toBe("max");
      expect(registry.get(modelsForm.justSaved(GLOBAL))).toBe(false);
      registry.dispose();
    }),
  );

  it.effect("stops saying Saved once the draft changes again", () =>
    Effect.gen(function* () {
      const { registry } = holdingSettings(DEFAULT_SETTINGS);

      yield* opened(registry, generalForm, GLOBAL);
      registry.set(generalForm.draft(GLOBAL), { skipPrompt: true });
      yield* save(registry, generalForm, GLOBAL);

      expect(registry.get(generalForm.justSaved(GLOBAL))).toBe(true);

      registry.set(generalForm.draft(GLOBAL), { skipPrompt: false });

      expect(registry.get(generalForm.justSaved(GLOBAL))).toBe(false);
      registry.dispose();
    }),
  );

  it.effect("has no unsaved changes for a draft that means what is saved", () =>
    Effect.gen(function* () {
      const { registry } = holdingSettings({ ...DEFAULT_SETTINGS, spendLimit: { perSession: 5 } });

      yield* opened(registry, toolsForm, GLOBAL);
      yield* opened(registry, globalLimitsForm, GLOBAL);
      registry.set(toolsForm.draft(GLOBAL), {
        offered: `\n${DEFAULT_SETTINGS.tools.offered.join("\n\n")}\n`,
      });
      registry.set(globalLimitsForm.draft(GLOBAL), { spendLimit: "5.00" });

      expect(registry.get(toolsForm.dirty(GLOBAL))).toBe(false);
      expect(registry.get(globalLimitsForm.dirty(GLOBAL))).toBe(false);

      registry.set(globalLimitsForm.draft(GLOBAL), { spendLimit: "" });

      expect(registry.get(globalLimitsForm.dirty(GLOBAL))).toBe(true);
      registry.dispose();
    }),
  );

  it("puts the defaults' own fields in the draft for Reset to defaults", () => {
    expect(modelsForm.defaults).toEqual({
      model: DEFAULT_SETTINGS.model,
      thinkingLevel: DEFAULT_SETTINGS.thinkingLevel,
      roles: DEFAULT_SETTINGS.roles,
    });
    expect(globalLimitsForm.defaults).toEqual({ spendLimit: "" });
    expect(environmentNameForm.defaults).toBeUndefined();
    // A save of the defaults would reset every Global variable, so there is no such button.
    expect(globalVariablesForm.defaults).toBeUndefined();
  });
});

/** An Environment's answer for Overrides `overrides` over Global at the defaults. */
const containerStateOf = (overrides: ContainerSettingsOverrides): ContainerSettingsState => ({
  settings: resolveEnvironmentContainerSettings(DEFAULT_CONTAINER_SETTINGS, overrides),
  global: DEFAULT_CONTAINER_SETTINGS,
  overrides,
});

/** A Registry holding the Overrides of Environment `work` (none at first), applying and keeping each patch saved. */
const holdingContainer = (overrides: ContainerSettingsOverrides = {}) => {
  const held = { overrides };
  const saved: unknown[] = [];

  const registry = registryWith({
    getEnvironmentSettings: () => Effect.sync(() => containerStateOf(held.overrides)),
    updateEnvironmentSettings: ({ environment, set, reset }) =>
      Effect.fromResult(patchContainerOverrides(held.overrides, { set, reset })).pipe(
        Effect.flatMap(Schema.decodeEffect(ContainerOverrides)),
        Effect.orDie,
        Effect.map((next) => {
          saved.push({ environment, set, reset });
          held.overrides = next;

          return containerStateOf(next);
        }),
      ),
  });

  return { registry, saved };
};

describe("an Environment's Container settings sections", () => {
  it.effect("save the Container section's fields without the Setup draft, or the Variables'", () =>
    Effect.gen(function* () {
      const { registry, saved } = holdingContainer();

      yield* opened(registry, containerSectionForm, "work");
      yield* opened(registry, setupForm, "work");
      yield* opened(registry, environmentVariablesForm, "work");
      registry.set(setupForm.draft("work"), {
        toolchains: "",
        setupScript: "echo setup",
        startScript: "",
      });
      registry.set(environmentVariablesForm.draft("work"), { variables: "A=1" });
      registry.set(containerSectionForm.draft("work"), {
        instance: DEFAULT_CONTAINER_SETTINGS.instance,
        idle: "30",
        ignore: "/data\n\n",
        spareWorkspace: false,
      });

      yield* save(registry, containerSectionForm, "work");

      // The size, left alone, is not sent: it keeps inheriting Global's.
      expect(saved).toEqual([
        {
          environment: "work",
          set: { idleMinutes: 30, ignore: ["/data"], spareWorkspace: false },
        },
      ]);
      expect(registry.get(setupForm.dirty("work"))).toBe(true);
      expect(registry.get(environmentVariablesForm.dirty("work"))).toBe(true);
      expect(registry.get(containerSectionForm.dirty("work"))).toBe(false);
      registry.dispose();
    }),
  );

  it.effect("keep a draft per Environment", () =>
    Effect.gen(function* () {
      const { registry } = holdingContainer();

      yield* opened(registry, setupForm, "work");
      yield* opened(registry, setupForm, "home");
      registry.set(setupForm.draft("work"), {
        toolchains: "",
        setupScript: "echo work",
        startScript: "",
      });

      expect(registry.get(setupForm.dirty("work"))).toBe(true);
      expect(registry.get(setupForm.dirty("home"))).toBe(false);
      expect(registry.get(setupForm.fields("home"))?.setupScript).toBe(
        DEFAULT_CONTAINER_SETTINGS.setupScript,
      );
      registry.dispose();
    }),
  );
});

describe("Global's Variables section", () => {
  it.effect("saves the variables typed as a patch: those added set, those taken out reset", () =>
    Effect.gen(function* () {
      const saved: unknown[] = [];
      // What the Registry holds: the old variables until the save, then what it saved.
      const held = () => (saved.length === 0 ? { OLD: "1" } : { NODE_ENV: "test" });

      const stateOf = () => ({
        settings: { ...DEFAULT_CONTAINER_SETTINGS, variables: held() },
        overrides: { variables: held() },
        overriddenIn: {},
      });

      const registry = registryWith({
        getGlobalContainerSettings: () => Effect.sync(stateOf),
        updateGlobalContainerSettings: (patch) =>
          Effect.sync(() => {
            saved.push(patch);

            return stateOf();
          }),
      });

      yield* opened(registry, globalVariablesForm, GLOBAL);

      expect(registry.get(globalVariablesForm.fields(GLOBAL))).toEqual({ variables: "OLD=1" });

      registry.set(globalVariablesForm.draft(GLOBAL), { variables: "NODE_ENV=test" });
      yield* save(registry, globalVariablesForm, GLOBAL);

      expect(saved).toEqual([
        { set: { variables: { NODE_ENV: "test" } }, reset: ["variables.OLD"] },
      ]);
      expect(registry.get(globalVariablesForm.fields(GLOBAL))).toEqual({
        variables: "NODE_ENV=test",
      });
      registry.dispose();
    }),
  );
});

describe("an Environment's name", () => {
  it.effect("is saved as a rename, trimmed", () =>
    Effect.gen(function* () {
      const renamed: unknown[] = [];
      const held = { name: "Work" };

      const registry = registryWith({
        listEnvironments: () =>
          Effect.sync(() => [{ id: "work", name: held.name, repos: [], createdAt: 1 }]),
        renameEnvironment: (input) =>
          Effect.sync(() => {
            renamed.push(input);
            held.name = input.name;

            return { id: "work", name: held.name, repos: [], createdAt: 1 };
          }),
      });

      yield* opened(registry, environmentNameForm, "work");
      registry.set(environmentNameForm.draft("work"), { name: " Work " });

      expect(registry.get(environmentNameForm.dirty("work"))).toBe(false);

      registry.set(environmentNameForm.draft("work"), { name: " Job " });
      yield* save(registry, environmentNameForm, "work");

      expect(renamed).toEqual([{ environment: "work", name: "Job" }]);
      expect(registry.get(environmentNameForm.fields("work"))).toEqual({ name: "Job" });
      registry.dispose();
    }),
  );
});
