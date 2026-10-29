// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

// The Settings page's section forms (`forms.ts`) over the fake Registry, at both Scopes (ADR-0027): each section's Save
// sends the value as the Registry has it now with only the fields the owner changed replaced, so another section's
// draft is never sent, and a draft is kept per Scope until it is saved. At an Environment a field is Inherited or
// Overridden, and a save sends only Overrides: an edited or overridden field set, a field reset to Global reset, and
// never an inherited value.

import {
  ContainerOverrides,
  type ContainerSettingsOverrides,
  DEFAULT_CONTAINER_SETTINGS,
  DEFAULT_SETTINGS,
  overridesFrom,
  patchContainerOverrides,
  resolveEnvironmentContainerSettings,
  resolveOverrides,
  resolveSettings,
  SettingsError,
  type Settings,
  withOverrides,
} from "@cloudpid/config";
import {
  type ContainerSettingsState,
  EnvironmentError,
  type SettingsOverridesState,
  type SettingsState,
} from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schema from "effect/Schema";
import { failureOf } from "../registry.ts";
import { type RegistryHandlers, registryWith, settled } from "../registry.testing.ts";
import type { SectionForm } from "./drafts.ts";
import {
  containerSectionForm,
  environmentInstructionsForm,
  environmentNameForm,
  environmentVariablesForm,
  formOf,
  generalForm,
  globalVariablesForm,
  instructionsForm,
  limitsForm,
  modelsForm,
  setupForm,
  toolsForm,
} from "./forms.ts";
import type { Marked } from "./scoped.ts";

const GLOBAL = "*";
const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";

/** A field's own value: Global's at Global, the Environment's Override at an Environment. */
const own = <const V>(value: V): Marked<V> => ({ value, inherited: false });

/** A field an Environment inherits, showing Global's `value`. */
const inherited = <const V>(value: V): Marked<V> => ({ value, inherited: true });

const stateOf = (settings: Settings): SettingsState => ({
  settings,
  overrides: overridesFrom(settings),
  overriddenIn: {},
});

/** Global's Container settings at the defaults, which the Limits section reads for the size limit. */
const GLOBAL_CONTAINER_AT_DEFAULTS: Partial<RegistryHandlers> = {
  getGlobalContainerSettings: () =>
    Effect.succeed({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {}, overriddenIn: {} }),
};

/**
 * A Registry holding `settings` (and Global's Container settings at the defaults), keeping each save; a save asking for
 * the "max" thinking level is refused.
 */
const holdingSettings = (settings: Settings) => {
  const held = { settings };
  const saved: unknown[] = [];

  const registry = registryWith({
    ...GLOBAL_CONTAINER_AT_DEFAULTS,
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

describe("a Settings section's Save at Global", () => {
  it.effect(
    "sends the saved Settings with only its own fields replaced, and keeps another section's draft",
    () =>
      Effect.gen(function* () {
        const { registry, saved } = holdingSettings(DEFAULT_SETTINGS);

        yield* opened(registry, modelsForm, GLOBAL);
        yield* opened(registry, generalForm, GLOBAL);
        registry.set(generalForm.draft(GLOBAL), { "branchSummary.skipPrompt": own(true) });
        registry.set(modelsForm.draft(GLOBAL), {
          ...modelsForm.defaults,
          model: own(HAIKU),
          thinkingLevel: own("low"),
        });

        expect(registry.get(modelsForm.dirty(GLOBAL))).toBe(true);
        expect(registry.get(generalForm.dirty(GLOBAL))).toBe(true);

        yield* save(registry, modelsForm, GLOBAL);

        expect(saved).toEqual([
          overridesFrom({ ...DEFAULT_SETTINGS, model: HAIKU, thinkingLevel: "low" }),
        ]);
        expect(registry.get(modelsForm.draft(GLOBAL))).toBeUndefined();
        expect(registry.get(modelsForm.dirty(GLOBAL))).toBe(false);
        expect(registry.get(modelsForm.fields(GLOBAL))?.model).toEqual(own(HAIKU));
        expect(registry.get(modelsForm.justSaved(GLOBAL))).toBe(true);
        // General's draft is still there, unsaved.
        expect(registry.get(generalForm.dirty(GLOBAL))).toBe(true);
        expect(registry.get(generalForm.fields(GLOBAL))).toEqual({
          "branchSummary.skipPrompt": own(true),
        });
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
        registry.set(toolsForm.draft(GLOBAL), { "tools.offered": own("read\nbash") });
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

  it.effect("saves the Instructions as typed, whitespace and all, over the saved Settings", () =>
    Effect.gen(function* () {
      const { registry, saved } = holdingSettings({ ...DEFAULT_SETTINGS, model: HAIKU });
      const text = "Answer in British English.\n\n- Keep commits small.\n";

      yield* opened(registry, instructionsForm, GLOBAL);

      expect(registry.get(instructionsForm.fields(GLOBAL))).toEqual({ instructions: own("") });

      registry.set(instructionsForm.draft(GLOBAL), { instructions: own(text) });

      expect(registry.get(instructionsForm.dirty(GLOBAL))).toBe(true);

      yield* save(registry, instructionsForm, GLOBAL);

      expect(saved).toEqual([
        overridesFrom({ ...DEFAULT_SETTINGS, model: HAIKU, instructions: text }),
      ]);
      expect(registry.get(instructionsForm.fields(GLOBAL))).toEqual({ instructions: own(text) });
      // A trailing newline is part of the text the agent reads, so it is a change.
      registry.set(instructionsForm.draft(GLOBAL), { instructions: own(text.trimEnd()) });

      expect(registry.get(instructionsForm.dirty(GLOBAL))).toBe(true);
      registry.dispose();
    }),
  );

  it.effect("says why it was refused, and keeps the draft", () =>
    Effect.gen(function* () {
      const { registry, saved } = holdingSettings(DEFAULT_SETTINGS);

      yield* opened(registry, modelsForm, GLOBAL);
      registry.set(modelsForm.draft(GLOBAL), { ...modelsForm.defaults, thinkingLevel: own("max") });

      expect(failureOf(yield* save(registry, modelsForm, GLOBAL))).toBe(
        "thinkingLevel: not supported",
      );
      expect(saved).toEqual([]);
      expect(registry.get(modelsForm.draft(GLOBAL))?.thinkingLevel).toEqual(own("max"));
      expect(registry.get(modelsForm.justSaved(GLOBAL))).toBe(false);
      registry.dispose();
    }),
  );

  it.effect("stops saying Saved once the draft changes again", () =>
    Effect.gen(function* () {
      const { registry } = holdingSettings(DEFAULT_SETTINGS);

      yield* opened(registry, generalForm, GLOBAL);
      registry.set(generalForm.draft(GLOBAL), { "branchSummary.skipPrompt": own(true) });
      yield* save(registry, generalForm, GLOBAL);

      expect(registry.get(generalForm.justSaved(GLOBAL))).toBe(true);

      registry.set(generalForm.draft(GLOBAL), { "branchSummary.skipPrompt": own(false) });

      expect(registry.get(generalForm.justSaved(GLOBAL))).toBe(false);
      registry.dispose();
    }),
  );

  it.effect("has no unsaved changes for a draft that means what is saved", () =>
    Effect.gen(function* () {
      const { registry } = holdingSettings({ ...DEFAULT_SETTINGS, spendLimit: { perSession: 5 } });

      yield* opened(registry, toolsForm, GLOBAL);
      yield* opened(registry, limitsForm, GLOBAL);
      registry.set(toolsForm.draft(GLOBAL), {
        "tools.offered": own(`\n${DEFAULT_SETTINGS.tools.offered.join("\n\n")}\n`),
      });

      expect(registry.get(toolsForm.dirty(GLOBAL))).toBe(false);

      const typed = registry.get(limitsForm.fields(GLOBAL));

      if (typed === null) throw new Error("the Limits did not load");

      registry.set(limitsForm.draft(GLOBAL), { ...typed, "spendLimit.perSession": own("5.00") });

      expect(registry.get(limitsForm.dirty(GLOBAL))).toBe(false);

      registry.set(limitsForm.draft(GLOBAL), { ...typed, "spendLimit.perSession": own("") });

      expect(registry.get(limitsForm.dirty(GLOBAL))).toBe(true);
      registry.dispose();
    }),
  );

  it("puts the defaults' own fields in the draft for Reset to defaults", () => {
    expect(modelsForm.defaults).toEqual({
      model: own(DEFAULT_SETTINGS.model),
      thinkingLevel: own(DEFAULT_SETTINGS.thinkingLevel),
      "roles.small": own(DEFAULT_SETTINGS.roles.small),
      "roles.medium": own(DEFAULT_SETTINGS.roles.medium),
      "roles.large": own(DEFAULT_SETTINGS.roles.large),
      "roles.xlarge": own(DEFAULT_SETTINGS.roles.xlarge),
    });
    expect(limitsForm.defaults).toEqual({
      "spendLimit.perSession": own(""),
      "extensions.subagents.maxSubagentDepth": own("2"),
      "extensions.subagents.maxSubagentWorkspaces": own("1"),
      maxInstance: own(DEFAULT_CONTAINER_SETTINGS.maxInstance),
    });
    expect(instructionsForm.defaults).toEqual({ instructions: own("") });
    expect(environmentNameForm.defaults).toBeUndefined();
    // A save of the defaults would reset every Global variable, so there is no such button.
    expect(globalVariablesForm.defaults).toBeUndefined();
  });
});

/** Environment `work`'s Settings with Overrides `overrides` over Global's `global` (overrides of the defaults). */
const overridesStateOf = (global: Settings, overrides: Schema.Json): SettingsOverridesState => ({
  environment: "work",
  settings: Result.getOrThrow(resolveOverrides(overridesFrom(global), overrides)),
  global,
  overrides,
  instructions: "",
});

/** A Registry holding Global's Settings `global` and Environment `work`'s Overrides, keeping each change saved. */
const holdingOverrides = (
  global: Settings,
  overrides: Schema.Json,
  more: Partial<RegistryHandlers> = {},
) => {
  const held = { global, overrides };
  const saved: unknown[] = [];

  const registry = registryWith({
    getSettingsOverrides: () => Effect.sync(() => overridesStateOf(held.global, held.overrides)),
    updateSettingsOverrides: ({ environment, set, reset }) =>
      Effect.sync(() => {
        saved.push({ environment, set, reset });

        const current = overridesStateOf(held.global, held.overrides).settings;

        held.overrides = Result.getOrThrow(withOverrides(held.overrides, { set, reset }, current));

        return overridesStateOf(held.global, held.overrides);
      }),
    ...more,
  });

  return { registry, saved, held };
};

describe("a Settings section at an Environment", () => {
  const GLOBAL_SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: SONNET };
  const SMALL = { model: OPUS, hint: "Only for the hard ones." };

  it.effect("shows each field Inherited with Global's value, or Overridden with its own", () =>
    Effect.gen(function* () {
      const { registry } = holdingOverrides(GLOBAL_SETTINGS, { roles: { small: SMALL } });

      yield* opened(registry, modelsForm, "work");

      expect(registry.get(modelsForm.fields("work"))).toEqual({
        model: inherited(SONNET),
        thinkingLevel: inherited(DEFAULT_SETTINGS.thinkingLevel),
        "roles.small": own(SMALL),
        "roles.medium": inherited(DEFAULT_SETTINGS.roles.medium),
        "roles.large": inherited(DEFAULT_SETTINGS.roles.large),
        "roles.xlarge": inherited(DEFAULT_SETTINGS.roles.xlarge),
      });
      expect(registry.get(modelsForm.dirty("work"))).toBe(false);
      registry.dispose();
    }),
  );

  it.effect(
    "sends only Overrides: a field edited set, a Role reset to Global reset, the inherited ones never",
    () =>
      Effect.gen(function* () {
        const { registry, saved } = holdingOverrides(GLOBAL_SETTINGS, {
          roles: { small: SMALL },
          thinkingLevel: "low",
        });

        yield* opened(registry, modelsForm, "work");

        const shown = registry.get(modelsForm.fields("work"));

        if (shown === null) throw new Error("the Models did not load");

        registry.set(modelsForm.draft("work"), {
          ...shown,
          model: own(HAIKU),
          "roles.small": inherited(DEFAULT_SETTINGS.roles.small),
        });
        yield* save(registry, modelsForm, "work");

        expect(saved).toEqual([
          { environment: "work", set: { model: HAIKU }, reset: ["roles.small"] },
        ]);
        expect(registry.get(modelsForm.fields("work"))).toMatchObject({
          model: own(HAIKU),
          thinkingLevel: own("low"),
          "roles.small": inherited(DEFAULT_SETTINGS.roles.small),
        });
        expect(registry.get(modelsForm.dirty("work"))).toBe(false);
        registry.dispose();
      }),
  );

  it.effect("pins an Override equal to Global's value, as an explicit Override", () =>
    Effect.gen(function* () {
      const { registry, saved } = holdingOverrides(GLOBAL_SETTINGS, {});

      yield* opened(registry, generalForm, "work");
      registry.set(generalForm.draft("work"), { "branchSummary.skipPrompt": own(false) });

      expect(registry.get(generalForm.dirty("work"))).toBe(true);

      yield* save(registry, generalForm, "work");

      expect(saved).toEqual([
        { environment: "work", set: { branchSummary: { skipPrompt: false } } },
      ]);
      expect(registry.get(generalForm.fields("work"))).toEqual({
        "branchSummary.skipPrompt": own(false),
      });
      registry.dispose();
    }),
  );

  it.effect("keeps a field the agent overrode meanwhile, sending only what the owner changed", () =>
    Effect.gen(function* () {
      const { registry, saved, held } = holdingOverrides(GLOBAL_SETTINGS, {});

      yield* opened(registry, modelsForm, "work");

      const shown = registry.get(modelsForm.fields("work"));

      if (shown === null) throw new Error("the Models did not load");

      // The agent overrides the thinking level after the page read the Overrides.
      held.overrides = { thinkingLevel: "minimal" };
      registry.set(modelsForm.draft("work"), { ...shown, model: own(OPUS) });
      yield* save(registry, modelsForm, "work");

      expect(saved).toEqual([{ environment: "work", set: { model: OPUS } }]);
      expect(held.overrides).toEqual({ thinkingLevel: "minimal", model: OPUS });
      registry.dispose();
    }),
  );

  it.effect(
    "saves the spend limit and the size limit of its Limits, each to its own Scope's RPC",
    () =>
      Effect.gen(function* () {
        const containerSaved: unknown[] = [];

        const { registry, saved } = holdingOverrides(
          GLOBAL_SETTINGS,
          {},
          {
            getEnvironmentSettings: () => Effect.succeed(containerStateOf({})),
            updateEnvironmentSettings: (patch) =>
              Effect.sync(() => {
                containerSaved.push(patch);

                return containerStateOf({ maxInstance: "cpu-3" });
              }),
          },
        );

        yield* opened(registry, limitsForm, "work");

        const shown = registry.get(limitsForm.fields("work"));

        if (shown === null) throw new Error("the Limits did not load");

        expect(shown).toEqual({
          "spendLimit.perSession": inherited(""),
          "extensions.subagents.maxSubagentDepth": inherited("2"),
          "extensions.subagents.maxSubagentWorkspaces": inherited("1"),
          maxInstance: inherited(DEFAULT_CONTAINER_SETTINGS.maxInstance),
        });

        registry.set(limitsForm.draft("work"), {
          ...shown,
          "spendLimit.perSession": own("5"),
          "extensions.subagents.maxSubagentDepth": own("1"),
          maxInstance: own("cpu-3"),
        });
        yield* save(registry, limitsForm, "work");

        expect(saved).toEqual([
          {
            environment: "work",
            set: {
              spendLimit: { perSession: 5 },
              extensions: { subagents: { maxSubagentDepth: 1 } },
            },
          },
        ]);
        expect(containerSaved).toEqual([{ environment: "work", set: { maxInstance: "cpu-3" } }]);
        registry.dispose();
      }),
  );

  it.effect("saves an emptied spend limit as no limit, its own or the one it inherits", () =>
    Effect.gen(function* () {
      const container = { getEnvironmentSettings: () => Effect.succeed(containerStateOf({})) };
      const own5 = holdingOverrides(GLOBAL_SETTINGS, { spendLimit: { perSession: 5 } }, container);

      const inherited5 = holdingOverrides(
        { ...GLOBAL_SETTINGS, spendLimit: { perSession: 5 } },
        {},
        container,
      );

      for (const { registry, saved, held } of [own5, inherited5]) {
        yield* opened(registry, limitsForm, "work");

        const shown = registry.get(limitsForm.fields("work"));

        if (shown === null) throw new Error("the Limits did not load");

        registry.set(limitsForm.draft("work"), { ...shown, "spendLimit.perSession": own("") });
        yield* save(registry, limitsForm, "work");

        expect(saved).toEqual([{ environment: "work", set: { spendLimit: { perSession: null } } }]);
        expect(held.overrides).toEqual({ spendLimit: { perSession: null } });
        expect(registry.get(limitsForm.fields("work"))?.["spendLimit.perSession"]).toEqual(own(""));
        registry.dispose();
      }
    }),
  );

  it.effect("saves the size limit of its Limits first, and nothing else when it is refused", () =>
    Effect.gen(function* () {
      const { registry, saved } = holdingOverrides(
        GLOBAL_SETTINGS,
        {},
        {
          getEnvironmentSettings: () => Effect.succeed(containerStateOf({})),
          updateEnvironmentSettings: () =>
            Effect.fail(new EnvironmentError({ message: "maxInstance: below the size" })),
        },
      );

      yield* opened(registry, limitsForm, "work");

      const shown = registry.get(limitsForm.fields("work"));

      if (shown === null) throw new Error("the Limits did not load");

      registry.set(limitsForm.draft("work"), {
        ...shown,
        "spendLimit.perSession": own("5"),
        maxInstance: own("lite"),
      });

      expect(failureOf(yield* save(registry, limitsForm, "work"))).toBe(
        "maxInstance: below the size",
      );
      expect(saved).toEqual([]);
      expect(registry.get(limitsForm.dirty("work"))).toBe(true);
      registry.dispose();
    }),
  );
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

      const setup = registry.get(setupForm.fields("work"));
      const container = registry.get(containerSectionForm.fields("work"));

      if (setup === null || container === null) throw new Error("the sections did not load");

      registry.set(setupForm.draft("work"), { ...setup, setupScript: own("echo setup") });
      registry.set(environmentVariablesForm.draft("work"), { variables: "A=1" });
      registry.set(containerSectionForm.draft("work"), {
        ...container,
        idleMinutes: own("30"),
        ignore: own("/data\n\n"),
        spareWorkspace: own(false),
      });

      yield* save(registry, containerSectionForm, "work");

      // The size, left inherited, is not sent: it keeps inheriting Global's.
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

  it.effect("reset a field reset to Global, and set one overridden as it is", () =>
    Effect.gen(function* () {
      const { registry, saved } = holdingContainer({ idleMinutes: 30 });

      yield* opened(registry, containerSectionForm, "work");

      const shown = registry.get(containerSectionForm.fields("work"));

      if (shown === null) throw new Error("the Container did not load");

      expect(shown.idleMinutes).toEqual(own("30"));
      expect(shown.instance).toEqual(inherited(DEFAULT_CONTAINER_SETTINGS.instance));

      registry.set(containerSectionForm.draft("work"), {
        ...shown,
        idleMinutes: inherited(String(DEFAULT_CONTAINER_SETTINGS.idleMinutes)),
        instance: own(DEFAULT_CONTAINER_SETTINGS.instance),
      });
      yield* save(registry, containerSectionForm, "work");

      expect(saved).toEqual([
        {
          environment: "work",
          set: { instance: DEFAULT_CONTAINER_SETTINGS.instance },
          reset: ["idleMinutes"],
        },
      ]);
      registry.dispose();
    }),
  );

  it.effect("keep a draft per Environment", () =>
    Effect.gen(function* () {
      const { registry } = holdingContainer();

      yield* opened(registry, setupForm, "work");
      yield* opened(registry, setupForm, "home");

      const setup = registry.get(setupForm.fields("work"));

      if (setup === null) throw new Error("the Setup did not load");

      registry.set(setupForm.draft("work"), { ...setup, setupScript: own("echo work") });

      expect(registry.get(setupForm.dirty("work"))).toBe(true);
      expect(registry.get(setupForm.dirty("home"))).toBe(false);
      expect(registry.get(setupForm.fields("home"))?.setupScript).toEqual(
        inherited(DEFAULT_CONTAINER_SETTINGS.setupScript),
      );
      registry.dispose();
    }),
  );
});

describe("Global's Container settings sections", () => {
  /** A Registry holding Global's Container overrides `overrides`, keeping each patch saved. */
  const holdingGlobal = (overrides: ContainerSettingsOverrides) => {
    const held = { overrides };
    const saved: unknown[] = [];

    const stateOf = () => ({
      settings: resolveEnvironmentContainerSettings(DEFAULT_CONTAINER_SETTINGS, held.overrides),
      overrides: held.overrides,
      overriddenIn: { idleMinutes: [{ id: "work", name: "Work" }] },
    });

    const registry = registryWith({
      getGlobalContainerSettings: () => Effect.sync(stateOf),
      updateGlobalContainerSettings: ({ set, reset }) =>
        Effect.fromResult(patchContainerOverrides(held.overrides, { set, reset })).pipe(
          Effect.flatMap(Schema.decodeEffect(ContainerOverrides)),
          Effect.orDie,
          Effect.map((next) => {
            saved.push({ set, reset });
            held.overrides = next;

            return stateOf();
          }),
        ),
    });

    return { registry, saved };
  };

  it.effect("save a field changed as set, and one put back to its default as reset", () =>
    Effect.gen(function* () {
      const { registry, saved } = holdingGlobal({ idleMinutes: 30 });

      yield* opened(registry, containerSectionForm, GLOBAL);

      const shown = registry.get(containerSectionForm.fields(GLOBAL));

      if (shown === null) throw new Error("the Container did not load");

      expect(shown.idleMinutes).toEqual(own("30"));
      expect(registry.get(containerSectionForm.scopeView(GLOBAL))?.overriddenIn).toEqual({
        idleMinutes: [{ id: "work", name: "Work" }],
      });

      registry.set(containerSectionForm.draft(GLOBAL), {
        ...shown,
        idleMinutes: own(String(DEFAULT_CONTAINER_SETTINGS.idleMinutes)),
        spareWorkspace: own(false),
      });
      yield* save(registry, containerSectionForm, GLOBAL);

      expect(saved).toEqual([{ set: { spareWorkspace: false }, reset: ["idleMinutes"] }]);
      registry.dispose();
    }),
  );
});

describe("Global's Limits", () => {
  it.effect(
    "save the subagent depth as the subagents extension's option, and drop it at its default",
    () =>
      Effect.gen(function* () {
        const { registry, saved } = holdingSettings({
          ...DEFAULT_SETTINGS,
          extensions: { subagents: { maxSubagentWorkspaces: 3, readToolset: ["read"] } },
        });

        yield* opened(registry, limitsForm, GLOBAL);

        const shown = registry.get(limitsForm.fields(GLOBAL));

        if (shown === null) throw new Error("the Limits did not load");

        expect(shown["extensions.subagents.maxSubagentWorkspaces"]).toEqual(own("3"));

        registry.set(limitsForm.draft(GLOBAL), {
          ...shown,
          "extensions.subagents.maxSubagentDepth": own("3"),
          "extensions.subagents.maxSubagentWorkspaces": own("1"),
        });
        yield* save(registry, limitsForm, GLOBAL);

        // The Subagent Workspace limit back at its default is left out; the extension's other options stay.
        expect(saved).toEqual([
          { extensions: { subagents: { readToolset: ["read"], maxSubagentDepth: 3 } } },
        ]);
        registry.dispose();
      }),
  );

  it.effect("save an emptied spend limit as no limit", () =>
    Effect.gen(function* () {
      const { registry, saved, held } = holdingSettings({
        ...DEFAULT_SETTINGS,
        spendLimit: { perSession: 5 },
      });

      yield* opened(registry, limitsForm, GLOBAL);

      const shown = registry.get(limitsForm.fields(GLOBAL));

      if (shown === null) throw new Error("the Limits did not load");

      expect(shown["spendLimit.perSession"]).toEqual(own("5"));

      registry.set(limitsForm.draft(GLOBAL), { ...shown, "spendLimit.perSession": own("") });
      yield* save(registry, limitsForm, GLOBAL);

      // No limit is the default, so nothing is kept of it.
      expect(saved).toEqual([{}]);
      expect(held.settings.spendLimit.perSession).toBeNull();
      expect(registry.get(limitsForm.fields(GLOBAL))?.["spendLimit.perSession"]).toEqual(own(""));
      registry.dispose();
    }),
  );
});

describe("the form of a section", () => {
  it("is the same at both Scopes for the Settings and the Container settings, and one per Scope for Variables", () => {
    for (const scope of [GLOBAL, "work"]) {
      expect(formOf("general", scope)).toBe(generalForm);
      expect(formOf("models", scope)).toBe(modelsForm);
      expect(formOf("tools", scope)).toBe(toolsForm);
      expect(formOf("limits", scope)).toBe(limitsForm);
      expect(formOf("container", scope)).toBe(containerSectionForm);
      expect(formOf("setup", scope)).toBe(setupForm);
    }

    expect(formOf("variables", GLOBAL)).toBe(globalVariablesForm);
    expect(formOf("variables", "work")).toBe(environmentVariablesForm);
    expect(formOf("environments", GLOBAL)).toBeUndefined();
    expect(formOf("environments", "work")).toBe(environmentNameForm);
    expect(formOf("instructions", GLOBAL)).toBe(instructionsForm);
    expect(formOf("instructions", "work")).toBe(environmentInstructionsForm);
  });
});

describe("an Environment's Instructions", () => {
  it.effect(
    "are saved whole as typed, by their own RPC, leaving the Overrides and Global's alone",
    () =>
      Effect.gen(function* () {
        const written: unknown[] = [];
        const global = { ...DEFAULT_SETTINGS, instructions: "Answer in French." };
        const held = { instructions: "Old." };
        const text = "Run pnpm test.\n\n- Deploy from main.\n";

        const stateOf = (): SettingsOverridesState => ({
          ...overridesStateOf(global, {}),
          instructions: held.instructions,
        });

        const registry = registryWith({
          getSettingsOverrides: () => Effect.sync(stateOf),
          updateEnvironmentInstructions: (input) =>
            Effect.sync(() => {
              written.push(input);
              held.instructions = input.instructions;

              return stateOf();
            }),
        });

        yield* opened(registry, environmentInstructionsForm, "work");

        expect(registry.get(environmentInstructionsForm.fields("work"))).toEqual({
          instructions: "Old.",
        });
        expect(environmentInstructionsForm.defaults).toBeUndefined();

        registry.set(environmentInstructionsForm.draft("work"), { instructions: text });
        yield* save(registry, environmentInstructionsForm, "work");

        expect(written).toEqual([{ environment: "work", instructions: text }]);
        expect(registry.get(environmentInstructionsForm.fields("work"))).toEqual({
          instructions: text,
        });
        // A trailing newline is part of the text the agent reads, so it is a change.
        registry.set(environmentInstructionsForm.draft("work"), { instructions: text.trimEnd() });

        expect(registry.get(environmentInstructionsForm.dirty("work"))).toBe(true);
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
