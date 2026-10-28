// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

// The repo page rendered with `react-dom/server` over the fake Registry: the listing is settled first, so the markup shows
// what it answered. Its rows (description, installs, badges, links), its checks, and its states for a repo that is not
// found or not readable, a ref it does not have, a repo with no Skills and a GitHub failure.

import { type RepoSkill, SkillRepoError, type SkillRepoListing } from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { type RegistryHandlers, registryWith, settled } from "./registry.testing.ts";
import { searchAtom } from "./router.ts";
import { SkillRepoPage } from "./skills-repo.tsx";
import { checkedSkillsAtom, skillRepoAtom, skillRepoKey } from "./skills-repo-state.ts";

const COMMIT = "c0ffee0000000000000000000000000000000001";

const SKILLS: ReadonlyArray<RepoSkill> = [
  {
    name: "tdd",
    description: "Test first.",
    path: "skills/engineering/tdd",
    skillId: "tdd",
    installs: 1_450_000,
    installed: { global: true, environments: [], updateAvailable: true },
  },
  {
    name: "grill-me",
    description: "Interview me.",
    path: "skills/productivity/grill-me",
    skillId: "grill-me",
    installed: {
      global: false,
      environments: ["work", "default"],
      updateAvailable: false,
    },
  },
  { name: "root", description: "A Skill at the root.", path: "", skillId: "root" },
];

const listing = (over: Partial<SkillRepoListing> = {}): SkillRepoListing => ({
  repo: "mattpocock/skills",
  ref: null,
  commit: COMMIT,
  skills: SKILLS,
  unreadable: [],
  internal: 0,
  omitted: 0,
  ...over,
});

/** The repo page of `mattpocock/skills` at the query `search`, once its listing (as `listRepoSkills` answers) has loaded. */
const render = (
  listRepoSkills: RegistryHandlers["listRepoSkills"],
  { search = "", checked = [] }: { search?: string; checked?: ReadonlyArray<string> } = {},
) =>
  Effect.gen(function* () {
    const registry = registryWith({ listRepoSkills, listEnvironments: () => Effect.succeed([]) });
    const ref = new URLSearchParams(search).get("ref") ?? undefined;
    const key = skillRepoKey("mattpocock", "skills", ref);

    registry.set(searchAtom, search);
    registry.mount(skillRepoAtom(key));
    registry.set(checkedSkillsAtom(key), new Set(checked));
    yield* settled(registry, skillRepoAtom(key));

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <SkillRepoPage owner="mattpocock" repo="skills" />
      </RegistryContext.Provider>,
    );

    registry.dispose();

    return markup;
  });

const links = (markup: string) =>
  Array.from(markup.matchAll(/<a ([^>]*)>(.*?)<\/a>/g), ([, attributes = "", text = ""]) => ({
    href: /href="([^"]*)"/.exec(attributes)?.[1]?.replaceAll("&amp;", "&"),
    text: text.replace(/<[^>]*>/g, ""),
  }));

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("the repo page", () => {
  it.effect(
    "lists every Skill with its description, installs and badges, and links its owner",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(() => Effect.succeed(listing()));

        expect(markup).toContain("<h1");
        expect(text(markup)).toContain("mattpocock/skills");
        expect(markup).toContain('aria-label="Skills in mattpocock/skills"');

        const names = Array.from(
          markup.matchAll(/aria-label="Select ([^"]*)"/g),
          ([, name]) => name,
        );

        expect(names).toEqual(["tdd", "grill-me", "root"]);

        const body = text(markup);

        expect(body).toContain("Test first.");
        expect(body).toContain("Interview me.");
        // Installs are compact, and blank when skills.sh does not know them.
        expect(body).toContain("1.5M");
        expect(body).toContain("Installed · Global");
        expect(body).toContain("update available");
        expect(body).toContain("Installed · in 2 environments");
        expect(markup.match(/title="[\d,]+ installs"/g)).toHaveLength(1);
        expect(body).toContain("Data from skills.sh");

        const hrefs = links(markup).map(({ href }) => href);

        expect(hrefs).toContain("/settings/all/skills/mattpocock");
        // A row's name is the route of the Skill's page; its folder is on GitHub at the commit that was listed.
        // Always with its folder, so a Skill whose name in the path is not unique still opens the one that was listed.
        expect(hrefs).toContain(
          "/settings/all/skills/mattpocock/skills/tdd?path=skills%2Fengineering%2Ftdd",
        );
        expect(hrefs).toContain("/settings/all/skills/mattpocock/skills/root?path=");
        expect(hrefs).toContain(
          `https://github.com/mattpocock/skills/tree/${COMMIT}/skills/engineering/tdd`,
        );
        expect(hrefs).toContain(`https://github.com/mattpocock/skills/tree/${COMMIT}`);
      }),
  );

  it.effect("has Install selected, off until a Skill is checked, then counting them", () =>
    Effect.gen(function* () {
      const none = yield* render(() => Effect.succeed(listing()));

      const some = yield* render(() => Effect.succeed(listing()), {
        checked: ["skills/engineering/tdd", "skills/productivity/grill-me"],
      });

      expect(none).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Install selected<\/button>/);
      expect(none).not.toContain("checked");
      expect(some).toContain("Install selected (2)");
      expect(some).not.toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Install selected/);
      expect(some.match(/checked=""/g)).toHaveLength(2);
    }),
  );

  it.effect("lists at the ref named, keeps it on its Skills' links, and shows it", () =>
    Effect.gen(function* () {
      const asked: unknown[] = [];

      const markup = yield* render(
        (payload) => {
          asked.push(payload);

          return Effect.succeed(listing({ ref: "feature/x" }));
        },
        { search: "?ref=feature%2Fx" },
      );

      expect(asked).toEqual([{ owner: "mattpocock", repo: "skills", ref: "feature/x" }]);
      expect(text(markup)).toContain("feature/x");
      expect(links(markup).map(({ href }) => href)).toContain(
        "/settings/all/skills/mattpocock/skills/tdd?ref=feature%2Fx&path=skills%2Fengineering%2Ftdd",
      );
    }),
  );

  it.effect("says a repo is not found, or not readable by the GitHub App, in one state", () =>
    Effect.gen(function* () {
      const markup = yield* render(() =>
        Effect.fail(
          SkillRepoError.make({
            kind: "not_found",
            message: "GitHub has no repo mattpocock/skills, or it is private.",
          }),
        ),
      );

      expect(markup).toContain('role="alert"');
      expect(text(markup)).toContain(
        "mattpocock/skills was not found, or the GitHub App cannot read it.",
      );
      expect(text(markup)).toContain("GitHub has no repo mattpocock/skills, or it is private.");
      expect(markup).not.toContain("Install selected");
    }),
  );

  it.effect("says a ref the repo does not have, and links the default branch", () =>
    Effect.gen(function* () {
      const markup = yield* render(
        () => Effect.fail(SkillRepoError.make({ kind: "bad_ref", message: "no such ref" })),
        { search: "?ref=nope" },
      );

      expect(text(markup)).toContain("has no branch, tag or commit “nope”");
      expect(links(markup)).toContainEqual({
        href: "/settings/all/skills/mattpocock/skills",
        text: "Show its default branch",
      });
    }),
  );

  it.effect("says a repo holds no Skills, and why a SKILL.md in it is not one", () =>
    Effect.gen(function* () {
      const markup = yield* render(() =>
        Effect.succeed(
          listing({
            skills: [],
            unreadable: [{ path: "docs", message: "frontmatter sets no name" }],
          }),
        ),
      );

      expect(text(markup)).toContain("mattpocock/skills holds no skills");
      expect(text(markup)).toContain("docs/SKILL.md: frontmatter sets no name");
      expect(markup).not.toContain("Install selected");
    }),
  );

  it.effect("says why GitHub failed, with Try again, and counts Skills the walk left out", () =>
    Effect.gen(function* () {
      const failed = yield* render(() =>
        Effect.fail(
          SkillRepoError.make({ kind: "rate_limited", message: "The limit is used up." }),
        ),
      );

      expect(text(failed)).toContain("GitHub did not list the skills in mattpocock/skills.");
      expect(text(failed)).toContain("The limit is used up.");
      expect(failed).toContain("Try again");

      const many = yield* render(() => Effect.succeed(listing({ omitted: 5, internal: 2 })));

      expect(text(many)).toContain("5 more SKILL.md files in the repo were not read");
      expect(text(many)).toContain("2 more skills are left out: the repo marks them internal.");
      expect(text(yield* render(() => Effect.succeed(listing())))).not.toContain("internal");
    }),
  );
});
