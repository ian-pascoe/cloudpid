// The Settings page, rendered with `react-dom/server` over the fake Registry: the breadcrumb with its Scope picker,
// what an Environment that is not listed shows, and sections at both Scopes with their Save bar.

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
import { containerSectionForm, modelsForm } from "./forms.ts";
import { SettingsPage } from "./page.tsx";

const WORK = { id: "work", name: "Work", repos: [], createdAt: 1 };
const HOME = { id: "home", name: "Home", repos: [], createdAt: 2 };

/** A Registry holding Environments Work and Home, the Settings, and Work's Container settings `container`. */
const fakeRegistry = (container: ContainerSettings = DEFAULT_CONTAINER_SETTINGS) =>
  registryWith({
    listEnvironments: () => Effect.succeed([WORK, HOME]),
    listSessions: () => Effect.succeed([]),
    listWorkspaces: () => Effect.succeed([]),
    getSettings: () =>
      Effect.succeed({ settings: DEFAULT_SETTINGS, overrides: overridesFrom(DEFAULT_SETTINGS) }),
    getEnvironmentSettings: () =>
      Effect.succeed({
        settings: container,
        global: DEFAULT_CONTAINER_SETTINGS,
        overrides: containerOverridesFrom(container),
      }),
    getGlobalContainerSettings: () =>
      Effect.succeed({ settings: DEFAULT_CONTAINER_SETTINGS, overrides: {}, overriddenIn: {} }),
  });

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

  it.effect("offers Global, then each Environment, in its Scope picker", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      yield* loaded(registry);

      const markup = render(registry, "work", section("container"));

      expect(scopeItems(markup)).toEqual(["Global", "Work ✓", "Home"]);
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
const spareBox = (markup: string): string => /<input id="spare-work"[^>]*>/.exec(markup)?.[0] ?? "";

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
        registry.dispose();
      }),
  );

  it.effect("can save once the Spare Workspace is switched", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      yield* loaded(registry);
      registry.set(containerSectionForm.draft("work"), {
        instance: DEFAULT_CONTAINER_SETTINGS.instance,
        idle: String(DEFAULT_CONTAINER_SETTINGS.idleMinutes),
        ignore: "",
        spareWorkspace: false,
      });

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
