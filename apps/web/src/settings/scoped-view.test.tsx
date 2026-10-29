// The Settings page's sections at both Scopes (ADR-0027), rendered with `react-dom/server` over the fake Registry: at
// an Environment each field is marked Inherited (on a dashed border, with Override) or Overridden (with Reset to
// Global), a Role by itself and a script or the Container-only paths as a whole; Override and Reset to Global change the
// mark, and the save sends only what changed of the Overrides; at Global a field that Environments override names them,
// each a link to the field at its Scope.

import {
  DEFAULT_CONTAINER_SETTINGS,
  DEFAULT_SETTINGS,
  overridesFrom,
  resolveOverrides,
  type Settings,
} from "@cloudpid/config";
import type { SettingsOverridesState, SettingsState } from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type * as Schema from "effect/Schema";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registryWith, settled } from "../registry.testing.ts";
import { SetupSection } from "./container.tsx";
import type { SectionForm } from "./drafts.ts";
import { modelsForm, setupForm } from "./forms.ts";
import { inheriting, overriding } from "./scoped-view.tsx";
import { ModelsSection } from "./settings-sections.tsx";

const GLOBAL = "*";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const SMALL = { model: OPUS, hint: "Only for the hard ones." };
const GLOBAL_SETTINGS: Settings = { ...DEFAULT_SETTINGS, model: SONNET };

/** Environment `work`'s Settings with Overrides `overrides` over Global's `GLOBAL_SETTINGS`. */
const overridesStateOf = (overrides: Schema.Json): SettingsOverridesState => ({
  environment: "work",
  settings: Result.getOrThrow(resolveOverrides(overridesFrom(GLOBAL_SETTINGS), overrides)),
  global: GLOBAL_SETTINGS,
  overrides,
});

/** A Registry with Global's Settings, which Work and Home override as `overriddenIn` says, and Work's `overrides`. */
const holding = (overrides: Schema.Json, overriddenIn: SettingsState["overriddenIn"] = {}) => {
  const saved: unknown[] = [];
  const held = { overrides };

  const registry = registryWith({
    getSettings: () =>
      Effect.succeed({
        settings: GLOBAL_SETTINGS,
        overrides: overridesFrom(GLOBAL_SETTINGS),
        overriddenIn,
      }),
    getSettingsOverrides: () => Effect.sync(() => overridesStateOf(held.overrides)),
    updateSettingsOverrides: ({ environment, set, reset }) =>
      Effect.sync(() => {
        saved.push({ environment, set, reset });

        return overridesStateOf(held.overrides);
      }),
    getEnvironmentSettings: () =>
      Effect.succeed({
        settings: {
          ...DEFAULT_CONTAINER_SETTINGS,
          setupScript: "make deps",
          startScript: "make serve",
        },
        global: { ...DEFAULT_CONTAINER_SETTINGS, startScript: "make serve" },
        overrides: { setupScript: "make deps" },
      }),
    getGlobalContainerSettings: () =>
      Effect.succeed({
        settings: { ...DEFAULT_CONTAINER_SETTINGS, startScript: "make serve" },
        overrides: { startScript: "make serve" },
        overriddenIn: { setupScript: [{ id: "work", name: "Work" }] },
      }),
  });

  return { registry, saved };
};

/** Wait until `form` shows its fields at `scope`, as its section does once its saved value has answered. */
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

const render = (registry: AtomRegistry.AtomRegistry, section: ReactNode) =>
  renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>{section}</RegistryContext.Provider>,
  );

/** The markup of field `path`: from its anchor to the next field's. */
const fieldOf = (markup: string, path: string): string => {
  const start = markup.indexOf(`id="field-${path}"`);

  if (start === -1) return "";

  const next = markup.indexOf('id="field-', start + 1);

  return markup.slice(start, next === -1 ? undefined : next);
};

/** The mark field `path` shows: Inherited or Overridden, with the action beside it, or none. */
const markOf = (markup: string, path: string): string => {
  const field = fieldOf(markup, path);
  const chip = /<span[^>]*>(Inherited|Overridden)<\/span>/.exec(field)?.[1];
  const action = /<button[^>]*>(Override|Reset to Global)<\/button>/.exec(field)?.[1];

  return chip === undefined ? "none" : `${chip}, ${action ?? "no action"}`;
};

describe("a Settings section at an Environment", () => {
  it.effect(
    "marks each field Inherited, with Override, or Overridden, with Reset to Global, a Role by itself",
    () =>
      Effect.gen(function* () {
        const { registry } = holding({ model: OPUS, roles: { small: SMALL } });

        yield* opened(registry, modelsForm, "work");

        const markup = render(registry, <ModelsSection scope="work" />);

        expect(markOf(markup, "model")).toBe("Overridden, Reset to Global");
        expect(markOf(markup, "thinkingLevel")).toBe("Inherited, Override");
        expect(markOf(markup, "roles.small")).toBe("Overridden, Reset to Global");
        expect(markOf(markup, "roles.medium")).toBe("Inherited, Override");
        expect(markOf(markup, "roles.large")).toBe("Inherited, Override");
        expect(markOf(markup, "roles.xlarge")).toBe("Inherited, Override");
        // Each button names its field to assistive technology.
        expect(markup).toContain('aria-label="Override the thinking level"');
        expect(markup).toContain('aria-label="Reset the small role to Global"');
        expect(markup).toContain('aria-label="Override the medium role"');
        registry.dispose();
      }),
  );

  it.effect(
    "shows an inherited field's Global value on a dashed border, an overridden one on a solid one",
    () =>
      Effect.gen(function* () {
        const { registry } = holding({ thinkingLevel: "low" });

        yield* opened(registry, modelsForm, "work");

        const markup = render(registry, <ModelsSection scope="work" />);
        const model = /<select[^>]*id="default-model"[^>]*>/.exec(markup)?.[0] ?? "";
        const thinking = /<select[^>]*id="default-thinking"[^>]*>/.exec(markup)?.[0] ?? "";

        expect(model).not.toBe("");
        expect(model).toContain("border-dashed");
        expect(fieldOf(markup, "model")).toContain(`<option value="${SONNET}" selected="">`);
        expect(thinking).not.toContain("border-dashed");
        expect(fieldOf(markup, "thinkingLevel")).toContain('<option value="low" selected="">');
        expect(markup).not.toContain("Overridden in");
        registry.dispose();
      }),
  );

  it.effect("makes a field an Override on Override, and the save sets only it", () =>
    Effect.gen(function* () {
      const { registry, saved } = holding({ model: OPUS });

      yield* opened(registry, modelsForm, "work");

      const fields = registry.get(modelsForm.fields("work"));

      if (fields === null) return expect.fail("the fields are not loaded");

      registry.set(modelsForm.draft("work"), overriding(fields, "thinkingLevel"));

      const markup = render(registry, <ModelsSection scope="work" />);

      expect(markOf(markup, "thinkingLevel")).toBe("Overridden, Reset to Global");
      expect(/<button[^>]*type="submit"[^>]*>/.exec(markup)?.[0]).not.toContain('disabled=""');

      registry.mount(modelsForm.save("work"));
      registry.set(modelsForm.save("work"), undefined);
      yield* settled(registry, modelsForm.save("work"));

      // Global's thinking level, pinned as the Environment's own; the overridden model is not sent again.
      expect(saved).toEqual([
        {
          environment: "work",
          set: { thinkingLevel: DEFAULT_SETTINGS.thinkingLevel },
          reset: undefined,
        },
      ]);
      registry.dispose();
    }),
  );

  it.effect("makes a field Inherited again on Reset to Global, and the save resets only it", () =>
    Effect.gen(function* () {
      const { registry, saved } = holding({ model: OPUS, roles: { small: SMALL } });

      yield* opened(registry, modelsForm, "work");

      const fields = registry.get(modelsForm.fields("work"));
      const view = registry.get(modelsForm.scopeView("work"));

      if (fields === null || view === null) return expect.fail("the fields are not loaded");

      registry.set(modelsForm.draft("work"), inheriting(fields, "roles.small", view.inherited));

      const markup = render(registry, <ModelsSection scope="work" />);

      expect(markOf(markup, "roles.small")).toBe("Inherited, Override");
      // The Role shows Global's model again.
      expect(fieldOf(markup, "roles.small")).toContain(
        `<option value="${DEFAULT_SETTINGS.roles.small.model}" selected="">`,
      );
      expect(markOf(markup, "model")).toBe("Overridden, Reset to Global");

      registry.mount(modelsForm.save("work"));
      registry.set(modelsForm.save("work"), undefined);
      yield* settled(registry, modelsForm.save("work"));

      expect(saved).toEqual([{ environment: "work", set: undefined, reset: ["roles.small"] }]);
      registry.dispose();
    }),
  );

  it.effect(
    "offers Reset all to Global in place of Reset to defaults, held while nothing is overridden",
    () =>
      Effect.gen(function* () {
        const overriding = holding({ model: OPUS });
        const following = holding({});

        yield* opened(overriding.registry, modelsForm, "work");
        yield* opened(following.registry, modelsForm, "work");

        const reset = (markup: string) =>
          /<button[^>]*>Reset all to Global…<\/button>/.exec(markup)?.[0] ?? "";

        const some = render(overriding.registry, <ModelsSection scope="work" />);
        const none = render(following.registry, <ModelsSection scope="work" />);

        expect(some).not.toContain("Reset to defaults");
        expect(reset(some)).not.toBe("");
        expect(reset(some)).not.toContain('disabled=""');
        expect(reset(none)).toContain('disabled=""');
        overriding.registry.dispose();
        following.registry.dispose();
      }),
  );

  it.effect("marks each script and the Toolchains as a whole", () =>
    Effect.gen(function* () {
      const { registry } = holding({});

      yield* opened(registry, setupForm, "work");

      const markup = render(registry, <SetupSection scope="work" />);

      expect(markOf(markup, "setupScript")).toBe("Overridden, Reset to Global");
      expect(markOf(markup, "startScript")).toBe("Inherited, Override");
      expect(markOf(markup, "toolchains")).toBe("Inherited, Override");
      // The inherited Start Script shows Global's.
      expect(fieldOf(markup, "startScript")).toContain(">make serve</textarea>");
      registry.dispose();
    }),
  );
});

describe("a Settings section at Global", () => {
  it.effect(
    "names the Environments that override a field, each a link to the field at its Scope",
    () =>
      Effect.gen(function* () {
        const { registry } = holding(
          {},
          {
            model: [
              { id: "work", name: "Work" },
              { id: "home", name: "Home" },
            ],
            "roles.small": [{ id: "work", name: "Work" }],
          },
        );

        yield* opened(registry, modelsForm, GLOBAL);

        const markup = render(registry, <ModelsSection scope={GLOBAL} />);

        const text = (path: string) =>
          fieldOf(markup, path)
            .replaceAll(/<[^>]*>/g, "")
            .replaceAll(/\s+/g, " ");

        expect(text("model")).toContain("Overridden in 2 environments: Work, Home");
        expect(fieldOf(markup, "model")).toContain('href="/settings/work/models#field-model"');
        expect(fieldOf(markup, "model")).toContain('href="/settings/home/models#field-model"');
        expect(text("roles.small")).toContain("Overridden in 1 environment: Work");
        expect(fieldOf(markup, "roles.small")).toContain(
          'href="/settings/work/models#field-roles.small"',
        );
        expect(text("thinkingLevel")).not.toContain("Overridden in");
        // Global has no marks: every value there is its own.
        expect(markOf(markup, "model")).toBe("none");
        expect(markup).toContain("Reset to defaults");
        expect(markup).not.toContain("Reset all to Global");
        registry.dispose();
      }),
  );

  it.effect("names the Environments that override a Container setting", () =>
    Effect.gen(function* () {
      const { registry } = holding({});

      yield* opened(registry, setupForm, GLOBAL);

      const markup = render(registry, <SetupSection scope={GLOBAL} />);

      expect(fieldOf(markup, "setupScript")).toContain("Overridden in 1");
      expect(fieldOf(markup, "setupScript")).toContain(
        'href="/settings/work/setup#field-setupScript"',
      );
      expect(fieldOf(markup, "startScript")).not.toContain("Overridden in");
      registry.dispose();
    }),
  );
});
