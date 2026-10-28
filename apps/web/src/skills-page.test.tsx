// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- in-memory fakes of the Registry over native arrays.

// The Skills page and the Environments page's Skills line, rendered with `react-dom/server` over the fake Registry: the
// queries a page reads are settled first, so the markup shows what they answered.

import {
  type AgentChange,
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
import { agentChangesAtom, environmentsAtom } from "./environments-state.ts";
import { EnvironmentsPage } from "./environments-page.tsx";
import { type RegistryHandlers, registryWith, settled } from "./registry.testing.ts";
import { searchAtom } from "./router.ts";
import { sessionsAtom } from "./sessions.ts";
import { SkillsPage } from "./skills-page.tsx";
import {
  anySkillInstalledAtom,
  environmentSkillsAtom,
  keptSkillFilesAtom,
  skillDirectoryPageAtom,
  skillDirectoryPageKey,
  skillDirectorySearchAtom,
  skillFilesDialogAtom,
  skillKey,
} from "./skills-state.ts";

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

const change = (id: number, field: string, scope = "work"): AgentChange => ({
  id,
  scope,
  at: 1,
  actor: "agent",
  session: null,
  conversation: 1,
  tool: field.startsWith("skills.") ? "environment_skill_save" : "environment_variable_set",
  reason: `Change ${id}`,
  field,
  before: null,
  after: field.startsWith("skills.") ? { files: {} } : "https://api.test",
  reverts: null,
  revertedBy: null,
});

const CHANGES = new Map([["work", [change(2, "skills.notes"), change(1, "variables.API_URL")]]]);

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
      installed: { everyEnvironment: true, environments: [], updateAvailable: true },
    },
    {
      source: "mattpocock/skills",
      skillId: "tdd",
      name: "tdd",
      installs: 950,
      installed: {
        everyEnvironment: false,
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
  listAgentChanges: ({ environment }) => Effect.succeed(CHANGES.get(environment) ?? []),
  skillChangeFiles: () => Effect.succeed({ before: null, after: [] }),
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

const scopes = ["*", "default", "work"];

/**
 * `page` rendered at the query `search`, once the Environments, the Sessions, every scope's Skills and Agent changes, and
 * the `more` atoms have loaded; `before` sets what the owner has open first.
 */
const render = (
  page: ReactElement,
  {
    search = "",
    more = [],
    before,
    handlers = {},
    loaded = scopes,
  }: {
    search?: string;
    more?: ReadonlyArray<Atom.Atom<AsyncResult.AsyncResult<unknown, unknown>>>;
    before?: (registry: AtomRegistry.AtomRegistry) => void;
    /** Handlers in place of the fixture's. */
    handlers?: Partial<RegistryHandlers>;
    /** The scopes whose Skills are loaded before the render: the others may still be loading. */
    loaded?: ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const registry = registryWith({ ...HANDLERS, ...handlers });

    registry.set(searchAtom, search);
    before?.(registry);
    yield* settle(registry, [
      // The Skills page chooses its default tab from every scope's Skills; the Environments page has no tab.
      ...(page.type === SkillsPage ? [anySkillInstalledAtom] : []),
      environmentsAtom,
      sessionsAtom,
      ...loaded.map((scope) => environmentSkillsAtom(scope)),
      ...scopes.map((scope) => agentChangesAtom(scope)),
      ...more,
    ]);

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>{page}</RegistryContext.Provider>,
    );

    registry.dispose();

    return markup;
  });

/** The Skills page at the query `search`. */
const renderSkills = (search: string) => render(<SkillsPage />, { search });

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

describe("the Skills page's tabs", () => {
  it.effect("are Installed, All time, Trending (24h) and Hot, Installed shown by default", () =>
    Effect.gen(function* () {
      const tabs = links(yield* renderSkills("")).filter(({ href }) => href?.startsWith("/skills"));

      expect(tabs).toEqual([
        { href: "/skills?tab=installed", text: "Installed", current: true },
        { href: "/skills?tab=all-time", text: "All time", current: false },
        { href: "/skills?tab=trending", text: "Trending (24h)", current: false },
        { href: "/skills?tab=hot", text: "Hot", current: false },
      ]);
    }),
  );

  it.effect("keep the search, and the Environment filter for the Installed tab only", () =>
    Effect.gen(function* () {
      const hrefs = links(yield* renderSkills("?tab=installed&q=grill&environment=work")).map(
        ({ href }) => href,
      );

      expect(hrefs).toContain("/skills?tab=installed&q=grill&environment=work");
      expect(hrefs).toContain("/skills?tab=all-time&q=grill");
      expect(hrefs).toContain("/skills?tab=hot&q=grill");
    }),
  );

  it.effect("open on All time when no Skill is installed, and on Installed when any is", () =>
    Effect.gen(function* () {
      const nothing = yield* render(<SkillsPage />, {
        more: [skillDirectoryPageAtom(skillDirectoryPageKey("all-time", 0))],
        handlers: { listEnvironmentSkills: () => Effect.succeed([]) },
      });

      expect(links(nothing).find(({ current }) => current)?.text).toBe("All time");
      expect(nothing).toContain("find-skills");

      const some = yield* renderSkills("");

      expect(links(some).find(({ current }) => current)?.text).toBe("Installed");
      expect(some).not.toContain("find-skills");
    }),
  );
});

/** The directory tab at `search`, once its first page (and any `more`) has loaded. */
const renderDirectory = (
  search: string,
  view: SkillDirectoryView,
  options: Parameters<typeof render>[1] = {},
) =>
  render(<SkillsPage />, {
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
        { href: "/skills/mattpocock/skills/grill-me", text: "grill-me", current: false },
        { href: "/skills/mattpocock/skills", text: "mattpocock/skills", current: false },
      ]);
      expect(grill).toContain('aria-label="Install grill-me from mattpocock/skills"');
      // The Hot tab's change is not on this list.
      expect(markup).not.toContain("Change");
    }),
  );

  it.effect(
    "show where a Skill is installed: every environment, N environments, update available",
    () =>
      Effect.gen(function* () {
        const markup = yield* renderDirectory("?tab=all-time", "all-time");

        expect(rowOf(markup, "find-skills")).not.toContain("Installed");
        expect(rowOf(markup, "grill-me")).toContain("Installed · every environment");
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
      const installed = yield* renderSkills("?tab=installed");

      expect(hot).toContain("skills.sh answered 503");
      expect(hot).toContain("Try again");
      expect(hot).toContain("Skills you have installed are not affected.");
      expect(hot).not.toContain("okx-guide");
      expect(links(hot).map(({ text }) => text)).toContain("Installed");
      expect(installed).toContain("grill-me");
      expect(installed).toContain('aria-label="Update tdd"');
    }),
  );
});

describe("the search", () => {
  it.effect("replaces the tab's list with skills.sh's results, without ranks", () =>
    Effect.gen(function* () {
      const markup = yield* render(<SkillsPage />, {
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
      expect(rowOf(markup, "grill-me")).toContain("Installed · every environment");
      // The tab is still the one the query names.
      expect(links(markup).find(({ current }) => current)?.text).toBe("Hot");
    }),
  );

  it.effect("replaces the Installed tab too, and clearing it brings the list back", () =>
    Effect.gen(function* () {
      const searching = yield* render(<SkillsPage />, {
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
      const nothing = yield* render(<SkillsPage />, {
        search: "?tab=all-time&q=zzz",
        more: [skillDirectorySearchAtom("zzz")],
      });

      const short = yield* renderSkills("?tab=all-time&q=g");

      const down = yield* render(<SkillsPage />, {
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
  it.effect("lists the Skills kept for every Environment, then each Environment's own", () =>
    Effect.gen(function* () {
      const markup = yield* renderSkills("?tab=installed");
      const every = section(markup, "For every environment");
      const work = section(markup, "Work");

      expect(markup.indexOf('aria-label="For every environment"')).toBeLessThan(
        markup.indexOf('aria-label="Default"'),
      );
      expect(markup.indexOf('aria-label="Default"')).toBeLessThan(
        markup.indexOf('aria-label="Work"'),
      );
      expect(every).toContain("grill-me");
      expect(every).toContain("update available");
      expect(every).toContain("Add skills from GitHub for every environment");
      expect(work).toContain("notes");
      expect(work).toContain("modified");
      expect(work).toContain('aria-label="Update tdd"');
      expect(work).toContain('aria-label="Remove notes"');
      expect(work).toContain("Also from every environment");
      expect(section(markup, "Default")).toContain("Add skills from GitHub");
    }),
  );

  it.effect("shows only the Environment ?environment= names, or every Environment's for *", () =>
    Effect.gen(function* () {
      const work = yield* renderSkills("?tab=installed&environment=work");

      expect(section(work, "Work")).toBeDefined();
      expect(section(work, "For every environment")).toBeUndefined();
      expect(section(work, "Default")).toBeUndefined();
      expect(work).toContain("Showing the skills of Work only.");
      expect(links(work)).toContainEqual({
        href: "/skills?tab=installed",
        text: "Show all environments",
        current: false,
      });

      const every = yield* renderSkills("?environment=*");

      expect(section(every, "For every environment")).toBeDefined();
      expect(section(every, "Work")).toBeUndefined();
      expect(every).toContain("Showing the skills of every environment only.");

      const gone = yield* renderSkills("?tab=installed&environment=gone");

      expect(gone).toContain("No environment has the id gone.");
      expect(section(gone, "For every environment")).toBeUndefined();
    }),
  );

  it.effect("says why it cannot name the Environment ?environment= names when the list fails", () =>
    Effect.gen(function* () {
      const markup = yield* render(<SkillsPage />, {
        search: "?tab=installed&environment=work",
        handlers: {
          listEnvironments: () => Effect.die("Registry down"),
        },
      });

      expect(markup).toContain("The environments could not load.");
      expect(markup).toContain("Registry down");
      expect(markup).not.toContain("Loading…");
    }),
  );

  it.effect("lists the Skills' Agent changes with their Revert, and no other change", () =>
    Effect.gen(function* () {
      const work = section(yield* renderSkills("?tab=installed&environment=work"), "Work");

      expect(work).toContain("Skill notes");
      expect(work).toContain('aria-label="Revert change 2: Skill notes"');
      expect(work).not.toContain("Variable API_URL");
    }),
  );

  it.effect(
    "links a Skill with a Skill source to GitHub, and opens the kept files of one with none",
    () =>
      Effect.gen(function* () {
        const work = section(yield* renderSkills("?environment=work"), "Work") ?? "";

        expect(work).toContain(
          `href="https://github.com/mattpocock/skills/tree/${COMMIT}/skills/tdd"`,
        );
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
  render(<SkillsPage />, {
    search: `?environment=${scope}`,
    more: [keptSkillFilesAtom(skillKey(scope, name))],
    before: (registry) => {
      registry.set(skillFilesDialogAtom(scope), name);
    },
  });

describe("the Environments page", () => {
  const renderEnvironments = render(<EnvironmentsPage />);

  it.effect("has one Skills line per Environment, linking to its Installed tab", () =>
    Effect.gen(function* () {
      const markup = yield* renderEnvironments;

      const line = (label: string) => {
        const shown = section(markup, label) ?? "";
        const manage = links(shown).find(({ text }) => text === "Manage");
        const text = /<p[^>]*>([^<]*) · <a [^>]*>Manage<\/a><\/p>/.exec(shown)?.[1];

        return { text, href: manage?.href };
      };

      expect(line("Work")).toEqual({
        text: "3 skills, 1 from every environment",
        href: "/skills?tab=installed&environment=work",
      });
      expect(line("Default")).toEqual({
        text: "1 skill, 1 from every environment",
        href: "/skills?tab=installed&environment=default",
      });
      expect(line("For every environment")).toEqual({
        text: "1 skill",
        href: "/skills?tab=installed&environment=*",
      });
    }),
  );

  it.effect(
    "counts an Environment's Skills only once those for every Environment have loaded",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(<EnvironmentsPage />, {
          handlers: {
            listEnvironmentSkills: ({ environment }) =>
              environment === "*" ? Effect.never : Effect.succeed(SKILLS.get(environment) ?? []),
            // A defect of another call would end the pending one too: the card's settings stay unanswered.
            getEnvironmentSettings: () => Effect.never,
          },
          loaded: ["default", "work"],
        });

        expect(section(markup, "Work")).toMatch(/Loading skills… · <a [^>]*>Manage<\/a>/);
        expect(section(markup, "Work")).not.toContain("2 skills");
      }),
  );

  it.effect("manages no Skill itself, and lists the Agent changes of the settings only", () =>
    Effect.gen(function* () {
      const markup = yield* renderEnvironments;

      expect(markup).not.toContain("Add skills from GitHub");
      expect(markup).not.toContain('aria-label="Remove notes"');
      expect(section(markup, "Work")).toContain("Variable API_URL");
      expect(section(markup, "Work")).not.toContain("Skill notes");
    }),
  );
});
