// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- in-memory fakes of the Registry over native arrays.

// The Skills section of the Settings page at a Scope, rendered with `react-dom/server` over the fake Registry: the
// queries a page reads are settled first, so the markup shows what they answered.

import {
  type DirectorySkill,
  type EnvironmentRecord,
  type EnvironmentSkill,
  SkillDirectoryError,
  type SkillDirectoryView,
} from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import type * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { environmentsAtom } from "../environments-state.ts";
import { type RegistryHandlers, registryWith, settled } from "../registry.testing.ts";
import { searchAtom } from "../router.ts";
import { sessionsAtom } from "../sessions.ts";
import { SettingsScope } from "./scope.tsx";
import { SkillsSettingsSection } from "./skills.tsx";
import {
  anySkillInstalledAtom,
  environmentSkillsAtom,
  keptSkillFilesAtom,
  skillDirectoryPageAtom,
  skillDirectoryPageKey,
  skillDirectorySearchAtom,
  skillFilesDialogAtom,
  skillKey,
} from "../skills-state.ts";

const COMMIT = "c0ffee0000000000000000000000000000000001";

const environment = (id: string, name: string): EnvironmentRecord => ({
  id,
  name,
  repos: [],
  createdAt: 1,
});

const ENVIRONMENTS = [environment("default", "Default"), environment("work", "Work")];

const SKILLS = new Map<string, ReadonlyArray<EnvironmentSkill>>(
  Object.entries({
    "*": [
      {
        name: "grill-me",
        description: "Interview me.",
        savedAt: 1,
        source: { repo: "mattpocock/skills", path: "skills/grill-me", ref: null, commit: COMMIT },
        updateAvailable: true,
      },
    ],
    work: [
      { name: "notes", description: "The team's notes.", savedAt: 1 },
      {
        name: "tdd",
        description: "Test first.",
        savedAt: 1,
        source: { repo: "mattpocock/skills", path: "skills/tdd", ref: null, commit: COMMIT },
        modified: true,
      },
    ],
    default: [],
  }),
);

/** The Skill directory's rows, as the Registry answers them. */
const DIRECTORY: Record<SkillDirectoryView, ReadonlyArray<DirectorySkill>> = {
  "all-time": [
    {
      source: "vercel-labs/skills",
      skillId: "find-skills",
      name: "find-skills",
      installs: 4_088_520,
    },
    {
      source: "mattpocock/skills",
      skillId: "grill-me",
      name: "grill-me",
      installs: 1_451_450,
      installed: { global: true, environments: [], updateAvailable: true },
    },
    {
      source: "mattpocock/skills",
      skillId: "tdd",
      name: "tdd",
      installs: 950,
      installed: {
        global: false,
        environments: ["work", "default"],
        updateAvailable: false,
      },
    },
    { source: "uizze.sh", skillId: "ui-taste", name: "ui-taste", installs: 21_547 },
  ],
  trending: [
    { source: "designed-by-ai/skills", skillId: "design", name: "design", installs: 22_670 },
  ],
  hot: [
    {
      source: "okx/onchainos-skills",
      skillId: "okx-guide",
      name: "okx-guide",
      installs: 5,
      installsYesterday: 1,
      change: 4,
    },
  ],
};

const HANDLERS: Partial<RegistryHandlers> = {
  listSessions: () => Effect.succeed([]),
  listEnvironments: () => Effect.succeed(ENVIRONMENTS),
  listEnvironmentSkills: ({ environment }) => Effect.succeed(SKILLS.get(environment) ?? []),
  environmentSkillFiles: ({ name }) =>
    Effect.succeed([
      { path: "SKILL.md", text: `---\nname: ${name}\n---\nKeep notes.` },
      { path: "references/style.md", text: "Short lines." },
    ]),
  listEnvironmentSecrets: () => Effect.succeed([]),
  listWorkspaces: () => Effect.succeed([]),
  listBuilds: () => Effect.succeed([]),
  listSkillDirectory: ({ view, page }) =>
    Effect.succeed(
      page === 0
        ? { total: 201, hasMore: true, skills: DIRECTORY[view] }
        : { total: 201, hasMore: false, skills: [] },
    ),
  searchSkillDirectory: ({ query }) =>
    query === "down"
      ? Effect.fail(
          SkillDirectoryError.make({ message: "skills.sh could not be reached: offline" }),
        )
      : Effect.succeed(DIRECTORY["all-time"].filter((skill) => skill.name.includes(query))),
};

/** Settle each of `atoms` in `registry`, keeping it mounted so the render reads its answer. */
const settle = (
  registry: AtomRegistry.AtomRegistry,
  atoms: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>,
) =>
  Effect.forEach(atoms, (atom) => {
    registry.mount(atom);

    return settled(registry, atom);
  });

/**
 * `page` rendered at the query `search`, once the Environments, the Sessions, the Scope's Skills (and Global's), and
 * the `more` atoms have loaded; `before` sets what the owner has open first.
 */
const render = (
  page: ReactElement,
  {
    search = "",
    more = [],
    before,
    handlers = {},
    scope = "*",
  }: {
    search?: string;
    more?: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>;
    before?: (registry: AtomRegistry.AtomRegistry) => void;
    /** Handlers in place of the fixture's. */
    handlers?: Partial<RegistryHandlers>;
    /** The Scope the Settings page shows. */
    scope?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const registry = registryWith({ ...HANDLERS, ...handlers });

    registry.set(searchAtom, search);
    before?.(registry);
    yield* settle(registry, [
      // The section chooses its default tab from the Scope's Skills.
      anySkillInstalledAtom(scope),
      environmentsAtom,
      sessionsAtom,
      environmentSkillsAtom(scope),
      environmentSkillsAtom("*"),
      ...more,
    ]);

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <SettingsScope.Provider value={scope}>{page}</SettingsScope.Provider>
      </RegistryContext.Provider>,
    );

    registry.dispose();

    return markup;
  });

/** The Skills section at the query `search`, at Scope `scope`. */
const renderSkills = (search: string, scope = "*") =>
  render(<SkillsSettingsSection />, { search, scope });

/** Each link of `markup`: its address (unescaped), its text, and whether it is the current page. */
const links = (markup: string) =>
  Array.from(markup.matchAll(/<a ([^>]*)>([^<]*)<\/a>/g), ([, attributes = "", text]) => ({
    href: /href="([^"]*)"/.exec(attributes)?.[1]?.replaceAll("&amp;", "&"),
    text,
    current: attributes.includes('aria-current="page"'),
  }));

/** The section of `markup` labelled `label`. */
const section = (markup: string, label: string): string | undefined => {
  const start = markup.indexOf(`<section aria-label="${label}"`);

  return start === -1 ? undefined : markup.slice(start, markup.indexOf("</section>", start));
};

describe("the Skills section's tabs", () => {
  it.effect("are Installed, All time, Trending (24h) and Hot, Installed shown by default", () =>
    Effect.gen(function* () {
      const tabs = links(yield* renderSkills("")).filter(({ href }) =>
        href?.startsWith("/settings/all/skills?tab="),
      );

      expect(tabs).toEqual([
        { href: "/settings/all/skills?tab=installed", text: "Installed", current: true },
        { href: "/settings/all/skills?tab=all-time", text: "All time", current: false },
        { href: "/settings/all/skills?tab=trending", text: "Trending (24h)", current: false },
        { href: "/settings/all/skills?tab=hot", text: "Hot", current: false },
      ]);
    }),
  );

  it.effect("link within the Environment's Scope at an Environment, keeping the search", () =>
    Effect.gen(function* () {
      const hrefs = links(yield* renderSkills("?tab=installed&q=grill", "work")).map(
        ({ href }) => href,
      );

      expect(hrefs).toContain("/settings/work/skills?tab=installed&q=grill");
      expect(hrefs).toContain("/settings/work/skills?tab=all-time&q=grill");
      expect(hrefs).toContain("/settings/work/skills?tab=hot&q=grill");
    }),
  );

  it.effect("open on All time when no Skill is installed, and on Installed when any is", () =>
    Effect.gen(function* () {
      const nothing = yield* render(<SkillsSettingsSection />, {
        more: [skillDirectoryPageAtom(skillDirectoryPageKey("all-time", 0))],
        handlers: { listEnvironmentSkills: () => Effect.succeed([]) },
      });

      expect(links(nothing).find(({ current }) => current)?.text).toBe("All time");
      expect(nothing).toContain("find-skills");

      const some = yield* renderSkills("");

      expect(links(some).find(({ current }) => current)?.text).toBe("Installed");
      expect(some).not.toContain("find-skills");

      // The Scope's own Skills decide: an Environment that keeps none opens on All time, though Global keeps one.
      const empty = yield* render(<SkillsSettingsSection />, {
        scope: "default",
        more: [skillDirectoryPageAtom(skillDirectoryPageKey("all-time", 0))],
      });

      expect(links(empty).find(({ current }) => current)?.text).toBe("All time");
    }),
  );
});

/** The directory tab at `search`, once its first page (and any `more`) has loaded. */
const renderDirectory = (
  search: string,
  view: SkillDirectoryView,
  options: Parameters<typeof render>[1] = {},
) =>
  render(<SkillsSettingsSection />, {
    ...options,
    search,
    more: [skillDirectoryPageAtom(skillDirectoryPageKey(view, 0)), ...(options.more ?? [])],
  });

/** The row of the Skill named `name` in `markup`: from its `<li>` to the next row's. */
const rowOf = (markup: string, name: string): string => {
  const row = '<li class="flex items-center';
  const start = markup.lastIndexOf(row, markup.indexOf(`>${name}</`));
  const next = markup.indexOf(row, start + 1);

  return markup.slice(start, next === -1 ? markup.indexOf("</li></ul>", start) + 5 : next);
};

describe("the Skill directory's tabs", () => {
  it.effect("list each Skill with its rank, name, source and compact installs", () =>
    Effect.gen(function* () {
      const markup = yield* renderDirectory("?tab=all-time", "all-time");
      const grill = rowOf(markup, "grill-me");

      expect(links(markup).find(({ current }) => current)?.text).toBe("All time");
      // Ranked in the order skills.sh answers.
      expect(markup.indexOf("find-skills")).toBeLessThan(markup.indexOf("grill-me"));
      expect(markup).toMatch(/>1<\/span>[\s\S]*find-skills[\s\S]*>2<\/span>[\s\S]*grill-me/);
      expect(markup).toContain(">4.1M<");
      expect(markup).toContain(">1.5M<");
      expect(markup).toContain(">950<");
      expect(links(grill)).toEqual([
        {
          href: "/settings/all/skills/mattpocock/skills/grill-me",
          text: "grill-me",
          current: false,
        },
        // The owner links to the owner's page, the repo to its own.
        { href: "/settings/all/skills/mattpocock", text: "mattpocock", current: false },
        { href: "/settings/all/skills/mattpocock/skills", text: "skills", current: false },
      ]);
      expect(grill).toContain('aria-label="Install grill-me from mattpocock/skills"');
      // The Hot tab's change is not on this list.
      expect(markup).not.toContain("Change");
    }),
  );

  it.effect("link to the directory pages of the Environment's Scope at an Environment", () =>
    Effect.gen(function* () {
      const markup = yield* renderDirectory("?tab=all-time", "all-time", { scope: "work" });

      expect(links(rowOf(markup, "grill-me")).map(({ href }) => href)).toEqual([
        "/settings/work/skills/mattpocock/skills/grill-me",
        "/settings/work/skills/mattpocock",
        "/settings/work/skills/mattpocock/skills",
      ]);
    }),
  );

  it.effect("show where a Skill is installed: Global, N environments, update available", () =>
    Effect.gen(function* () {
      const markup = yield* renderDirectory("?tab=all-time", "all-time");

      expect(rowOf(markup, "find-skills")).not.toContain("Installed");
      expect(rowOf(markup, "grill-me")).toContain("Installed · Global");
      expect(rowOf(markup, "grill-me")).toContain("update available");
      expect(rowOf(markup, "tdd")).toContain("Installed · in 2 environments");
      expect(rowOf(markup, "tdd")).not.toContain("update available");
    }),
  );

  it.effect("show the Hot tab's change, and the Trending tab its own list", () =>
    Effect.gen(function* () {
      const hot = yield* renderDirectory("?tab=hot", "hot");
      const trending = yield* renderDirectory("?tab=trending", "trending");

      expect(links(hot).find(({ current }) => current)?.text).toBe("Hot");
      expect(hot).toContain("Change");
      expect(rowOf(hot, "okx-guide")).toContain(">+4<");
      expect(trending).toContain("design");
      expect(trending).not.toContain("okx-guide");
    }),
  );

  it.effect("offer Load more while the page says more follow, and credit skills.sh", () =>
    Effect.gen(function* () {
      const markup = yield* renderDirectory("?tab=all-time", "all-time");

      expect(markup).toContain("Load more");
      expect(links(markup)).toContainEqual({
        href: "https://skills.sh",
        text: "Data from skills.sh",
        current: false,
      });
      expect(markup).not.toContain("Vercel");
    }),
  );

  it.effect("show a source that is not a GitHub repo as text with Install disabled", () =>
    Effect.gen(function* () {
      const markup = yield* renderDirectory("?tab=all-time", "all-time");
      const row = rowOf(markup, "ui-taste");

      expect(row).toContain("uizze.sh");
      expect(links(row)).toEqual([]);
      expect(row).toMatch(/<button[^>]*disabled/);
    }),
  );

  it.effect("say plainly when skills.sh cannot be reached, and Installed still works", () =>
    Effect.gen(function* () {
      const down: Partial<RegistryHandlers> = {
        listSkillDirectory: () =>
          Effect.fail(SkillDirectoryError.make({ message: "skills.sh answered 503" })),
      };

      const hot = yield* renderDirectory("?tab=hot", "hot", { handlers: down });
      const installed = yield* renderSkills("?tab=installed", "work");

      expect(hot).toContain("skills.sh answered 503");
      expect(hot).toContain("Try again");
      expect(hot).toContain("Skills you have installed are not affected.");
      expect(hot).not.toContain("okx-guide");
      expect(links(hot).map(({ text }) => text)).toContain("Installed");
      expect(installed).toContain("notes");
      expect(installed).toContain('aria-label="Update tdd"');
    }),
  );
});

describe("the search", () => {
  it.effect("replaces the tab's list with skills.sh's results, without ranks", () =>
    Effect.gen(function* () {
      const markup = yield* render(<SkillsSettingsSection />, {
        search: "?tab=hot&q=grill",
        more: [skillDirectorySearchAtom("grill")],
      });

      expect(markup).toContain('value="grill"');
      expect(markup).toContain('aria-label="Results for grill"');
      expect(markup).toContain("grill-me");
      expect(markup).not.toContain("okx-guide");
      expect(markup).not.toContain("find-skills");
      // It is a list of results, not a ranking.
      expect(markup).not.toMatch(/>1<\/span>/);
      expect(rowOf(markup, "grill-me")).toContain("Installed · Global");
      // The tab is still the one the query names.
      expect(links(markup).find(({ current }) => current)?.text).toBe("Hot");
    }),
  );

  it.effect("replaces the Installed tab too, and clearing it brings the list back", () =>
    Effect.gen(function* () {
      const searching = yield* render(<SkillsSettingsSection />, {
        search: "?tab=installed&q=tdd",
        more: [skillDirectorySearchAtom("tdd")],
      });

      const cleared = yield* renderSkills("?tab=installed");

      expect(searching).toContain('aria-label="Results for tdd"');
      expect(searching).not.toContain("Add skills from GitHub");
      expect(cleared).toContain("Add skills from GitHub");
    }),
  );

  it.effect("says what a search that finds nothing, is too short, or fails comes to", () =>
    Effect.gen(function* () {
      const nothing = yield* render(<SkillsSettingsSection />, {
        search: "?tab=all-time&q=zzz",
        more: [skillDirectorySearchAtom("zzz")],
      });

      const short = yield* renderSkills("?tab=all-time&q=g");

      const down = yield* render(<SkillsSettingsSection />, {
        search: "?tab=all-time&q=down",
        more: [skillDirectorySearchAtom("down")],
      });

      expect(nothing).toContain("Nothing found for “zzz”.");
      expect(short).toContain("Type at least 2 characters to search skills.sh.");
      expect(down).toContain("skills.sh could not be reached: offline");
      expect(down).toContain("Try again");
    }),
  );

  it.effect("keeps the search in the bar above the tabs", () =>
    Effect.gen(function* () {
      const markup = yield* renderSkills("?tab=installed&q=tdd");

      expect(markup.indexOf('role="search"')).toBeLessThan(
        markup.indexOf('aria-label="Skills lists"'),
      );
      expect(markup).toContain('placeholder="Search skills on skills.sh"');
    }),
  );
});

describe("the Installed tab", () => {
  it.effect("lists only the Skills kept Global at Global", () =>
    Effect.gen(function* () {
      const markup = yield* renderSkills("?tab=installed");
      const globalMarkup = section(markup, "Global");

      expect(globalMarkup).toContain("grill-me");
      expect(globalMarkup).toContain("update available");
      expect(globalMarkup).toContain("Add skills from GitHub at Global");
      expect(section(markup, "Work")).toBeUndefined();
      expect(section(markup, "Default")).toBeUndefined();
      expect(markup).not.toContain("notes");
      expect(markup).not.toContain("Show all environments");
      expect(markup).not.toContain("Showing the skills of");
    }),
  );

  it.effect(
    "lists only the Environment's own Skills at an Environment, and what it gets from Global",
    () =>
      Effect.gen(function* () {
        const markup = yield* renderSkills("?tab=installed", "work");
        const work = section(markup, "Work");

        expect(section(markup, "Global")).toBeUndefined();
        expect(work).toContain("notes");
        expect(work).toContain("modified");
        expect(work).toContain('aria-label="Update tdd"');
        expect(work).toContain('aria-label="Remove notes"');
        expect(work).toContain(">Inherited</span>");
        expect(work).toContain("grill-me");
        expect(work).not.toContain('aria-label="Remove grill-me"');
        expect(work).toContain("Add skills from GitHub");
        expect(work).not.toContain("Add skills from GitHub at Global");
      }),
  );

  it.effect("points to Agent changes instead of listing the Skills' changes", () =>
    Effect.gen(function* () {
      const atWork = yield* renderSkills("?tab=installed", "work");
      const atGlobal = yield* renderSkills("?tab=installed");

      expect(links(atWork)).toContainEqual({
        href: "/settings/work/agent-changes",
        text: "Agent changes",
        current: false,
      });
      expect(links(atGlobal).map(({ href }) => href)).toContain("/settings/all/agent-changes");
      expect(atWork).not.toContain('aria-label="Revert');
      expect(atWork).not.toContain("The agent has changed no skill here.");
    }),
  );

  it.effect(
    "links a Skill with a Skill source to its page, and opens the kept files of one with none",
    () =>
      Effect.gen(function* () {
        const work = section(yield* renderSkills("", "work"), "Work") ?? "";

        // The Skill's page in the Scope, naming its folder and the ref it was installed from.
        expect(work).toContain(
          'href="/settings/work/skills/mattpocock/skills/tdd?path=skills%2Ftdd"',
        );
        expect(work).not.toContain("github.com/mattpocock/skills/tree");
        expect(work).toContain('aria-label="View the files of notes"');
        expect(work).not.toContain('aria-label="View the files of tdd"');
        expect(work).not.toContain('aria-label="Update notes"');

        const viewing = yield* viewer("work", "notes");

        expect(viewing).toContain("The notes skill");
        expect(viewing).toContain("references/style.md");
        expect(viewing).toContain("Short lines.");
        expect(viewing.indexOf("SKILL.md")).toBeLessThan(viewing.indexOf("references/style.md"));
      }),
  );
});

/** The Installed tab with the files viewer of Skill `name` of `scope` open, once its files have loaded. */
const viewer = (scope: string, name: string) =>
  render(<SkillsSettingsSection />, {
    scope,
    more: [keptSkillFilesAtom(skillKey(scope, name))],
    before: (registry) => {
      registry.set(skillFilesDialogAtom(scope), name);
    },
  });
