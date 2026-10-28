// The sidebar's links to the app's pages, rendered with `react-dom/server`: Environments, Skills and Settings, in that
// order, in the expanded list and in the rail it collapses to.

import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { registryWith } from "./registry.testing.ts";
import { Sidebar } from "./sidebar.tsx";
import { sidebarCollapsedAtom } from "./sidebar-state.ts";

/** The sidebar with the Skills page shown, collapsed or not. */
const render = (collapsed: boolean) => {
  const registry = registryWith({
    listSessions: () => Effect.succeed([]),
    listEnvironments: () => Effect.succeed([]),
    listWorkspaces: () => Effect.succeed([]),
  });

  registry.set(sidebarCollapsedAtom, collapsed);

  const markup = renderToStaticMarkup(
    <RegistryContext.Provider value={registry}>
      <Sidebar shown={undefined} settingsActive={false} environmentsActive={false} skillsActive />
    </RegistryContext.Provider>,
  );

  registry.dispose();

  return markup;
};

/** Each page link of `markup`, in order: its address, its name (the text, or the label of an icon alone), and whether it is current. */
const pageLinks = (markup: string) =>
  Array.from(markup.matchAll(/<a ([^>]*)>(.*?)<\/a>/g), ([, attributes = "", inside = ""]) => ({
    href: /href="([^"]*)"/.exec(attributes)?.[1],
    name: /aria-label="([^"]*)"/.exec(attributes)?.[1] ?? inside.replaceAll(/<[^>]*>/g, "").trim(),
    current: attributes.includes('aria-current="page"'),
  }));

describe("the sidebar's page links", () => {
  it("are Environments, Skills and Settings, Skills current on the Skills page", () => {
    expect(pageLinks(render(false))).toEqual([
      { href: "/environments", name: "Environments", current: false },
      { href: "/skills", name: "Skills", current: true },
      { href: "/settings", name: "Settings", current: false },
    ]);
  });

  it("are the same in the rail, as icons named by their labels", () => {
    const links = pageLinks(render(true));

    // The rail, then the list a phone still shows whole.
    expect(links.slice(0, 3)).toEqual([
      { href: "/environments", name: "Environments", current: false },
      { href: "/skills", name: "Skills", current: true },
      { href: "/settings", name: "Settings", current: false },
    ]);
  });
});
