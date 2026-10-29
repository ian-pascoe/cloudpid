// @effect-diagnostics preferEffectArray:off -- the test table is a native array.

// The Settings page, rendered with `react-dom/server` over the fake Registry: the breadcrumb with its Scope picker,
// what an Environment that is not listed shows, sections at both Scopes with their Save bar, and a smoke render of every
// section at each Scope.

import {
  type ContainerSettings,
  containerOverridesFrom,
  DEFAULT_CONTAINER_SETTINGS,
  DEFAULT_SETTINGS,
  overridesFrom,
} from "@cloudpid/config";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { renderToStaticMarkup } from "react-dom/server";
import { environmentsAtom, globalSettingsAtom } from "../environments-state.ts";
import { registryWith, settled } from "../registry.testing.ts";
import type { SettingsView } from "../router.ts";
import {
  containerSectionForm,
  environmentInstructionsForm,
  instructionsForm,
  modelsForm,
} from "./forms.ts";
import { SettingsPage } from "./page.tsx";
import { withOverride } from "./scoped-view.tsx";
import { sectionLabel, sectionsAt } from "./sections.ts";

const WORK = { id: "work", name: "Work", repos: [], createdAt: 1 };
const HOME = { id: "home", name: "Home", repos: [], createdAt: 2 };

/** The Instructions a fake Registry holds: Global's, and Work's own. */
type HeldInstructions = { readonly global: string; readonly work: string };

/**
 * A Registry holding Environments Work and Home, the Settings, Work's Container settings `container`, and the
 * Instructions `instructions`.
 */
const fakeRegistry = (
  container: ContainerSettings = DEFAULT_CONTAINER_SETTINGS,
  instructions: HeldInstructions = { global: "", work: "" },
) => {
  const settings = { ...DEFAULT_SETTINGS, instructions: instructions.global };

  return registryWith({
    listEnvironments: () => Effect.succeed([WORK, HOME]),
    listSessions: () => Effect.succeed([]),
    listWorkspaces: () => Effect.succeed([]),
    getSettings: () =>
      Effect.succeed({ settings, overrides: overridesFrom(settings), overriddenIn: {} }),
    getEnvironmentSettings: () =>
      Effect.succeed({
        settings: container,
        global: DEFAULT_CONTAINER_SETTINGS,
        overrides: containerOverridesFrom(container),
      }),
    getGlobalContainerSettings: () =>
      Effect.succeed({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {}, overriddenIn: {} }),
    getSettingsOverrides: ({ environment }) =>
      Effect.succeed({
        environment,
        settings,
        global: settings,
        overrides: {},
        instructions: environment === "work" ? instructions.work : "",
      }),
  });
};

/** Wait for what the page reads first: the Environments, the Settings, and Work's Container settings. */
const loaded = (registry: AtomRegistry.AtomRegistry) =>
  Effect.gen(function* () {
    registry.mount(environmentsAtom);
    registry.mount(globalSettingsAtom);
    registry.mount(modelsForm.fields("*"));
    registry.mount(containerSectionForm.fields("work"));
    yield* settled(registry, environmentsAtom);
    yield* settled(registry, globalSettingsAtom);
    yield* settled(registry, modelsForm.loaded("*"));
    yield* settled(registry, containerSectionForm.loaded("work"));
  });

const section = (slug: string): SettingsView => ({ kind: "section", section: slug });

const render = (registry: AtomRegistry.AtomRegistry, scope: string, view: SettingsView) => {
  const markup = renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <SettingsPage scope={scope} view={view} />
    </RegistryContext.Provider>,
  );

  return markup;
};

/** The breadcrumb's text, its items joined by " / " as the page shows them. */
const breadcrumb = (markup: string): string =>
  (/<nav aria-label="Breadcrumb"[^>]*>(.*?)<\/nav>/.exec(markup)?.[1] ?? "")
    // The Scope picker's menu, which closes its item.
    .replaceAll(/<div[^>]*role="menu".*?<\/div><\/li>/g, "</li>")
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

/** The Scope picker's items: each one's text, and whether it is the one checked. */
const scopeItems = (markup: string) =>
  Array.from(
    markup.matchAll(
      /<button[^>]*role="menuitemradio" aria-checked="(true|false)"[^>]*>(.*?)<\/button>/g,
    ),
    ([, checked, inside = ""]) =>
      `${inside.replaceAll(/<[^>]*>/g, "").trim()}${checked === "true" ? " ✓" : ""}`,
  );

describe("the Settings page's breadcrumb", () => {
  it.effect("names Settings, the Scope and the section shown", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      yield* loaded(registry);

      const markup = render(registry, "*", section("models"));

      expect(breadcrumb(markup)).toBe("Settings / Global / Models");
      expect(markup).toContain('<span aria-current="page" class="font-medium">Models</span>');
      expect(markup).toContain('aria-label="Scope: Global"');
      registry.dispose();
    }),
  );

  it.effect("offers Global, then the Environments by name, in its Scope picker", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      yield* loaded(registry);

      const markup = render(registry, "work", section("container"));

      expect(scopeItems(markup)).toEqual(["Global", "Home", "Work ✓"]);
      expect(markup).toContain(">Environments<");
      expect(breadcrumb(markup)).toBe("Settings / Work / Container");
      registry.dispose();
    }),
  );
});

describe("the Settings page at an Environment that is not listed", () => {
  it.effect("says no environment has the id, with a way to Global", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      yield* loaded(registry);

      const markup = render(registry, "gone", section("container"));

      expect(markup).toContain("No environment has the id");
      expect(markup).toContain(">gone<");
      expect(markup).toContain('href="/settings/all"');
      expect(markup).not.toContain("Keep a Spare Workspace ready");
      registry.dispose();
    }),
  );
});

/** The Save button's own tag in `markup`. */
const saveButton = (markup: string): string =>
  /<button[^>]*type="submit"[^>]*>Save<\/button>/.exec(markup)?.[0] ?? "";

/** The Spare Workspace checkbox's own tag in `markup`. */
const spareBox = (markup: string): string =>
  /<input id="spare-workspace"[^>]*>/.exec(markup)?.[0] ?? "";

describe("an Environment's Container section", () => {
  it.effect(
    "shows the Spare Workspace as saved, with its trade-off, nothing to save, and no defaults",
    () =>
      Effect.gen(function* () {
        const registry = fakeRegistry({ ...DEFAULT_CONTAINER_SETTINGS, spareWorkspace: false });

        yield* loaded(registry);

        const markup = render(registry, "work", section("container"));

        expect(spareBox(markup)).not.toBe("");
        expect(spareBox(markup)).not.toContain("checked");
        expect(markup).toContain("Container time each spare takes to prepare");
        expect(saveButton(markup)).toContain('disabled=""');
        // A field the Environment does not override inherits Global's, so there are no defaults to reset to.
        expect(markup).not.toContain("Reset to defaults");
        expect(markup).toContain("Reset all to Global…");
        registry.dispose();
      }),
  );

  it.effect("can save once the Spare Workspace is switched", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      yield* loaded(registry);

      const fields = registry.get(containerSectionForm.fields("work"));

      if (fields === null) return expect.fail("the fields are not loaded");

      registry.set(
        containerSectionForm.draft("work"),
        withOverride(fields, "spareWorkspace", false),
      );

      const markup = render(registry, "work", section("container"));

      expect(spareBox(markup)).not.toContain("checked");
      expect(saveButton(markup)).not.toBe("");
      expect(saveButton(markup)).not.toContain('disabled=""');
      registry.dispose();
    }),
  );
});

describe("Global's Models section", () => {
  it.effect("shows the default model, and the Save bar", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      yield* loaded(registry);

      const markup = render(registry, "*", section("models"));

      expect(markup).toContain("<h1");
      expect(markup).toContain("Default model");
      expect(markup).toContain("Model roles");
      expect(saveButton(markup)).toContain('disabled=""');
      registry.dispose();
    }),
  );
});

/** The Instructions' text area's own tag in `markup`. */
const instructionsArea = (markup: string): string =>
  /<textarea id="instructions"[^>]*>/.exec(markup)?.[0] ?? "";

describe("Global's Instructions section", () => {
  it.effect(
    "shows the saved Instructions in a monospace box, their size against 64 KiB, and when an edit applies",
    () =>
      Effect.gen(function* () {
        const registry = fakeRegistry();

        yield* loaded(registry);
        registry.mount(instructionsForm.fields("*"));
        registry.set(instructionsForm.draft("*"), {
          instructions: { value: "Answer in British English.", inherited: false },
        });

        const markup = render(registry, "*", section("instructions"));

        expect(breadcrumb(markup)).toBe("Settings / Global / Instructions");
        expect(instructionsArea(markup)).toContain("font-mono");
        expect(instructionsArea(markup)).toContain(
          'aria-describedby="instructions-size instructions-note"',
        );
        expect(markup).toContain('<p id="instructions-note"');
        expect(markup).toContain(">Answer in British English.</textarea>");
        expect(markup).toContain("26 / 65,536 bytes");
        expect(markup).toContain("applies from each session&#x27;s next context");
        expect(saveButton(markup)).not.toContain('disabled=""');
        expect(markup).toContain("Reset to defaults");
        registry.dispose();
      }),
  );

  it.effect("holds Save while the Instructions are over 64 KiB of UTF-8, and says why", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      yield* loaded(registry);
      registry.mount(instructionsForm.fields("*"));
      // Each "é" is two bytes of UTF-8: 32,769 of them are 65,538 bytes.
      registry.set(instructionsForm.draft("*"), {
        instructions: { value: "é".repeat(32_769), inherited: false },
      });

      const markup = render(registry, "*", section("instructions"));

      expect(markup).toContain("65,538 / 65,536 bytes");
      expect(instructionsArea(markup)).toContain('aria-invalid="true"');
      expect(markup).toContain("2 bytes too long");
      expect(saveButton(markup)).toContain('disabled=""');
      registry.dispose();
    }),
  );
});

/** Work's own Instructions' text area's own tag in `markup`. */
const workInstructionsArea = (markup: string): string =>
  /<textarea id="instructions-work"[^>]*>/.exec(markup)?.[0] ?? "";

/** Global's Instructions as an Environment's section shows them, read-only. */
const fromGlobal = (markup: string): string =>
  /<pre role="region" aria-labelledby="instructions-global-label"[^>]*>(.*?)<\/pre>/s.exec(
    markup,
  )?.[1] ?? "";

describe("an Environment's Instructions section", () => {
  it.effect(
    "shows Global's Instructions read-only with a link to edit them at Global, above the Environment's own box",
    () =>
      Effect.gen(function* () {
        const registry = fakeRegistry(DEFAULT_CONTAINER_SETTINGS, {
          global: "Answer in British English.",
          work: "Run the tests with pnpm test.",
        });

        yield* loaded(registry);
        registry.mount(environmentInstructionsForm.fields("work"));
        yield* settled(registry, environmentInstructionsForm.loaded("work"));

        const markup = render(registry, "work", section("instructions"));

        expect(breadcrumb(markup)).toBe("Settings / Work / Instructions");
        expect(fromGlobal(markup)).toBe("Answer in British English.");
        expect(markup).toContain('href="/settings/all/instructions"');
        expect(markup).toContain(">Edit at Global</a>");
        // Global's text comes first, then the Environment's own box.
        expect(markup.indexOf("Answer in British English.")).toBeLessThan(
          markup.indexOf(workInstructionsArea(markup)),
        );
        expect(workInstructionsArea(markup)).toContain("font-mono");
        expect(markup).toContain(">Run the tests with pnpm test.</textarea>");
        expect(markup).toContain("29 / 65,536 bytes");
        expect(markup).toContain("Shown after the global ones");
        // Instructions add up: nothing is Inherited or Overridden, and nothing resets to Global.
        expect(markup).not.toContain("Inherited");
        expect(markup).not.toContain("Overridden");
        expect(markup).not.toContain("Reset");
        expect(saveButton(markup)).toContain('disabled=""');
        registry.dispose();
      }),
  );

  it.effect(
    "says Global has none, and holds Save while the Environment's are over 64 KiB, saying why",
    () =>
      Effect.gen(function* () {
        const registry = fakeRegistry();

        yield* loaded(registry);
        registry.mount(environmentInstructionsForm.fields("work"));
        yield* settled(registry, environmentInstructionsForm.loaded("work"));

        expect(render(registry, "work", section("instructions"))).toContain("None at Global.");

        registry.set(environmentInstructionsForm.draft("work"), {
          instructions: "é".repeat(32_769),
        });

        const markup = render(registry, "work", section("instructions"));

        expect(markup).toContain("65,538 / 65,536 bytes");
        expect(workInstructionsArea(markup)).toContain('aria-invalid="true"');
        expect(markup).toContain("2 bytes too long");
        expect(saveButton(markup)).toContain('disabled=""');

        registry.set(environmentInstructionsForm.draft("work"), { instructions: "Mine." });

        expect(saveButton(render(registry, "work", section("instructions")))).not.toContain(
          'disabled=""',
        );
        registry.dispose();
      }),
  );
});

describe("every section", () => {
  /** The fake Registry, with every list a section asks for empty. */
  const everything = () =>
    registryWith({
      listEnvironments: () => Effect.succeed([WORK, HOME]),
      listSessions: () => Effect.succeed([]),
      listWorkspaces: () => Effect.succeed([]),
      listBuilds: () => Effect.succeed([]),
      listEnvironmentSecrets: () => Effect.succeed([]),
      listAgentChanges: () => Effect.succeed([]),
      listSettingsChanges: () => Effect.succeed([]),
      listEnvironmentSkills: () => Effect.succeed([]),
      listSkillDirectory: () => Effect.succeed({ total: 0, hasMore: false, skills: [] }),
      getSettings: () =>
        Effect.succeed({
          settings: DEFAULT_SETTINGS,
          overrides: overridesFrom(DEFAULT_SETTINGS),
          overriddenIn: {},
        }),
      getEnvironmentSettings: () =>
        Effect.succeed({
          settings: DEFAULT_CONTAINER_SETTINGS,
          global: DEFAULT_CONTAINER_SETTINGS,
          overrides: {},
        }),
      getGlobalContainerSettings: () =>
        Effect.succeed({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {}, overriddenIn: {} }),
      getSettingsOverrides: ({ environment }) =>
        Effect.succeed({
          environment,
          settings: DEFAULT_SETTINGS,
          global: DEFAULT_SETTINGS,
          overrides: {},
          instructions: "",
        }),
    });

  it.effect.each([
    ...sectionsAt("*").map((slug) => ["*", slug] as const),
    ...sectionsAt("work").map((slug) => ["work", slug] as const),
  ])("renders %s's %s section under its heading", ([scope, slug]) =>
    Effect.gen(function* () {
      const registry = everything();

      yield* loaded(registry);

      const markup = render(registry, scope, section(slug));

      const heading =
        slug === "environments" && scope === "work" ? "Work" : sectionLabel(slug, scope);

      expect(markup).toContain(`>${heading}</h1>`);
      expect(markup).not.toContain("unexpected Registry call");
      registry.dispose();
    }),
  );
});
