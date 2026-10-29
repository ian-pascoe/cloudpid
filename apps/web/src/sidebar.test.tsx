// @effect-diagnostics preferEffectArray:off -- lists of links are native arrays.

// The sidebar's links, rendered with `react-dom/server`: the one Settings link at the foot of the Session list and on
// the rail it collapses to, and on the Settings page the way back to the Sessions and the Scope's sections, in the list
// and on the rail.

import { DEFAULT_SETTINGS, overridesFrom } from "@cloudpid/config";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { environmentsAtom } from "./environments-state.ts";
import { registryWith, settled } from "./registry.testing.ts";
import type { SettingsView } from "./router.ts";
import { generalForm, modelsForm } from "./settings/forms.ts";
import { Sidebar, type SettingsShown } from "./sidebar.tsx";
import { sidebarCollapsedAtom } from "./sidebar-state.ts";

const WORK = { id: "work", name: "Work", repos: [], createdAt: 1 };

const fakeRegistry = () =>
  registryWith({
    listSessions: () => Effect.succeed([]),
    listEnvironments: () => Effect.succeed([WORK]),
    listWorkspaces: () => Effect.succeed([]),
    getSettings: () =>
      Effect.succeed({
        settings: DEFAULT_SETTINGS,
        overrides: overridesFrom(DEFAULT_SETTINGS),
        overriddenIn: {},
      }),
  });

/** The sidebar, collapsed or not, showing the Settings page's navigation when `settings` is given. */
const render = (
  collapsed: boolean,
  settings?: SettingsShown,
  registry: ReturnType<typeof fakeRegistry> = fakeRegistry(),
) => {
  registry.set(sidebarCollapsedAtom, collapsed);

  const markup = renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <Sidebar shown={undefined} settings={settings} />
    </RegistryContext.Provider>,
  );

  registry.dispose();

  return markup;
};

/** Each link of `markup`, in order: its address, its name (the label, the text, or the tooltip), and whether it is current. */
const links = (markup: string) =>
  Array.from(markup.matchAll(/<a ([^>]*)>(.*?)<\/a>/g), ([, attributes = "", inside = ""]) => ({
    href: /href="([^"]*)"/.exec(attributes)?.[1],
    name: /aria-label="([^"]*)"/.exec(attributes)?.[1] ?? inside.replaceAll(/<[^>]*>/g, "").trim(),
    current: attributes.includes('aria-current="page"'),
  }));

const MODELS: SettingsView = { kind: "section", section: "models" };

describe("the sidebar's page links", () => {
  it("are one Settings link at the foot of the Session list", () => {
    expect(links(render(false))).toEqual([{ href: "/settings", name: "Settings", current: false }]);
  });

  it("are the same on the rail, as an icon named by its label", () => {
    // The rail, then the list a phone still shows whole.
    expect(links(render(true))[0]).toEqual({ href: "/settings", name: "Settings", current: false });
  });
});

describe("the sidebar on the Settings page", () => {
  it("leads back to the Sessions, then lists Global's sections, the one shown current", () => {
    expect(links(render(false, { scope: "*", view: MODELS }))).toEqual([
      { href: "/", name: "Back to sessions", current: false },
      { href: "/settings/all/general", name: "General", current: false },
      { href: "/settings/all/instructions", name: "Instructions", current: false },
      { href: "/settings/all/models", name: "Models", current: true },
      { href: "/settings/all/tools", name: "Tools", current: false },
      { href: "/settings/all/limits", name: "Limits", current: false },
      { href: "/settings/all/container", name: "Container", current: false },
      { href: "/settings/all/setup", name: "Setup", current: false },
      { href: "/settings/all/environments", name: "Environments", current: false },
      { href: "/settings/all/workspaces", name: "Workspaces", current: false },
      { href: "/settings/all/skills", name: "Skills", current: false },
      { href: "/settings/all/variables", name: "Variables", current: false },
      { href: "/settings/all/secrets", name: "Secrets", current: false },
      { href: "/settings/all/notifications", name: "Notifications", current: false },
      { href: "/settings/all/agent-changes", name: "Agent changes", current: false },
    ]);
  });

  it("lists an Environment's sections, as Global's but Instructions and Notifications, the Skills current below the Skill directory", () => {
    const markup = render(false, { scope: "work", view: { kind: "skillOwner", owner: "acme" } });

    expect(
      links(markup).map(({ name, current }) => (current ? `${name} (current)` : name)),
    ).toEqual([
      "Back to sessions",
      "General",
      "Models",
      "Tools",
      "Limits",
      "Container",
      "Setup",
      "Environment",
      "Workspaces",
      "Skills (current)",
      "Variables",
      "Secrets",
      "Agent changes",
    ]);
    expect(markup).toContain("Work");
  });

  it("shows the sections' icons on the rail, each named", () => {
    const rail = links(render(true, { scope: "*", view: MODELS })).slice(0, 13);

    expect(rail[0]).toEqual({ href: "/", name: "Back to sessions", current: false });
    expect(rail.slice(1, 4)).toEqual([
      { href: "/settings/all/general", name: "General", current: false },
      { href: "/settings/all/instructions", name: "Instructions", current: false },
      { href: "/settings/all/models", name: "Models", current: true },
    ]);
  });

  it.effect("marks a section with unsaved changes, and no other", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      registry.mount(generalForm.fields("*"));
      yield* settled(registry, generalForm.loaded("*"));
      registry.mount(modelsForm.fields("*"));
      registry.set(generalForm.draft("*"), {
        "branchSummary.skipPrompt": { value: true, inherited: false },
      });

      const named = links(render(false, { scope: "*", view: MODELS }, registry)).map(
        ({ name }) => name,
      );

      expect(named.slice(1, 4)).toEqual(["General, unsaved changes", "Instructions", "Models"]);
    }),
  );

  it.effect("lists no sections for an Environment the listing does not have", () =>
    Effect.gen(function* () {
      const registry = fakeRegistry();

      registry.mount(environmentsAtom);
      yield* settled(registry, environmentsAtom);

      const gone = { scope: "gone", view: { kind: "section", section: "container" } } as const;

      // Only the way back to the Sessions, in the list and on the rail.
      expect(links(render(false, gone, registry)).map(({ name }) => name)).toEqual([
        "Back to sessions",
      ]);
    }),
  );
});
