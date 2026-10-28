// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

// A Skill's page rendered with `react-dom/server` over the fake Registry: the Skill is settled first, so the markup shows
// what it answered. Its SKILL.md rendered without its frontmatter, its files, the commit read, installs, Install, where it
// is installed with the marks, Update and Remove of the Installed tab, and its states for an unknown Skill or repo, a ref
// the repo lacks, a name that means several Skills and a GitHub failure.

import {
  type EnvironmentRecord,
  type EnvironmentSkill,
  SkillRepoError,
  type SkillView,
  type SkillViewAnswer,
} from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { environmentListAtom } from "./environments-state.ts";
import { type RegistryHandlers, registryWith, settled } from "./registry.testing.ts";
import { searchAtom } from "./router.ts";
import { SkillPage } from "./skills-skill.tsx";
import { installedCopiesAtom, skillViewAtom, skillViewKey } from "./skills-skill-state.ts";
import { environmentSkillsAtom } from "./skills-state.ts";

const COMMIT = "c0ffee0000000000000000000000000000000001";

const ENVIRONMENTS: ReadonlyArray<EnvironmentRecord> = [
  { id: "default", name: "Default", repos: [], createdAt: 1 },
  { id: "work", name: "Work", repos: [], createdAt: 1 },
];

const SKILL_MD = `---
name: tdd
description: Test first.
---

# Test-driven development

Write the **test** first. See [the reference](references/red-green.md) and ![a diagram](https://tracker.test/pixel.png).

<script>alert(1)</script>

\`\`\`
pnpm test
\`\`\`
`;

/** A Skill the directory knows nothing of. */
const unknown = (over: Partial<SkillView> = {}): SkillView => ({
  repo: "mattpocock/skills",
  ref: null,
  commit: COMMIT,
  name: "tdd",
  description: "Test first.",
  path: "skills/engineering/tdd",
  skillId: "tdd",
  skillMd: SKILL_MD,
  files: [
    { path: "SKILL.md", size: 400 },
    { path: "references/red-green.md", size: 2048 },
    { path: "run.sh" },
  ],
  ...over,
});

const view = (over: Partial<SkillView> = {}): SkillView =>
  unknown({ installs: 1_450_000, ...over });

const kept = (over: Partial<EnvironmentSkill> = {}): EnvironmentSkill => ({
  name: "tdd",
  description: "Test first.",
  savedAt: 1,
  source: { repo: "mattpocock/skills", path: "skills/engineering/tdd", ref: null, commit: COMMIT },
  ...over,
});

/** The Skill's page at the query `search` (`?ref=`, `?path=`), once what it shows has loaded. */
const render = (
  viewSkill: RegistryHandlers["viewSkill"],
  {
    search = "",
    skill = "tdd",
    keptBy = {},
  }: {
    search?: string;
    skill?: string;
    keptBy?: Record<string, ReadonlyArray<EnvironmentSkill>>;
  } = {},
) =>
  Effect.gen(function* () {
    const registry = registryWith({
      viewSkill,
      listEnvironments: () => Effect.succeed(ENVIRONMENTS),
      listEnvironmentSkills: ({ environment }) => Effect.succeed(keptBy[environment] ?? []),
    });

    const params = new URLSearchParams(search);

    const key = skillViewKey(
      "mattpocock",
      "skills",
      skill,
      params.get("path") ?? undefined,
      params.get("ref") ?? undefined,
    );

    registry.set(searchAtom, search);
    registry.mount(skillViewAtom(key));
    registry.mount(environmentListAtom);
    registry.mount(
      installedCopiesAtom({ repo: "mattpocock/skills", path: "skills/engineering/tdd" }),
    );
    yield* settled(registry, skillViewAtom(key));

    for (const scope of ["*", "default", "work"]) {
      registry.mount(environmentSkillsAtom(scope));
      yield* settled(registry, environmentSkillsAtom(scope));
    }

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <SkillPage owner="mattpocock" repo="skills" skill={skill} />
      </RegistryContext.Provider>,
    );

    registry.dispose();

    return markup;
  });

const found = (skill: SkillView): SkillViewAnswer => ({ status: "found", skill });

const links = (markup: string) =>
  Array.from(markup.matchAll(/<a ([^>]*)>(.*?)<\/a>/g), ([, attributes = "", text = ""]) => ({
    href: /href="([^"]*)"/.exec(attributes)?.[1]?.replaceAll("&amp;", "&"),
    text: text.replace(/<[^>]*>/g, ""),
  }));

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("a Skill's page", () => {
  it.effect(
    "renders the SKILL.md without its frontmatter, and shows the name, description, installs and commit",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(() => Effect.succeed(found(view())));
        const body = text(markup);

        expect(markup).toContain("<h1");
        expect(body).toContain("tdd");
        expect(body).toContain("Test first.");
        // Rendered, not shown as source.
        expect(markup).toContain('data-streamdown="strong"');
        expect(body).toContain("Test-driven development");
        expect(body).toContain("pnpm test");
        // The frontmatter is the name and the description above, not part of the text.
        expect(body).not.toContain("description: Test first.");
        // Compact installs with the exact count on hover; the credit for skills.sh's data.
        expect(body).toContain("1.5M installs");
        expect(markup).toContain('title="1,450,000 installs"');
        expect(body).toContain("Data from skills.sh");
        // The commit it was read at, linking to it.
        expect(links(markup)).toContainEqual({
          href: `https://github.com/mattpocock/skills/commit/${COMMIT}`,
          text: "c0ffee0",
        });
        expect(body).toContain("Read at c0ffee0 (the default branch)");
      }),
  );

  it.effect(
    "leaves out what a repo's markdown would load or run, and sends a relative link to the file on GitHub",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(() => Effect.succeed(found(view())));

        expect(markup).not.toContain("<img");
        expect(markup).not.toContain("tracker.test");
        expect(markup).not.toContain("<script");
        expect(text(markup)).toContain("a diagram");
        expect(links(markup).map(({ href }) => href)).toContain(
          `https://github.com/mattpocock/skills/blob/${COMMIT}/skills/engineering/tdd/references/red-green.md`,
        );
      }),
  );

  it.effect(
    "lists the files an install takes, with sizes and links to them on GitHub at the commit",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(() => Effect.succeed(found(view())));

        const files = links(markup).filter(
          ({ href }) =>
            (href?.includes("/blob/") && href.endsWith(".md")) || href?.endsWith("run.sh"),
        );

        expect(text(markup)).toContain("3 files");
        expect(markup).toContain('aria-label="Files"');
        expect(files.map(({ text: name }) => name)).toEqual([
          "SKILL.md",
          "references/red-green.md",
          "run.sh",
        ]);
        expect(files[0]?.href).toBe(
          `https://github.com/mattpocock/skills/blob/${COMMIT}/skills/engineering/tdd/SKILL.md`,
        );
        expect(text(markup)).toContain("2 kB");
      }),
  );

  it.effect(
    "has an Install button, and leaves the installs blank when the directory does not know them",
    () =>
      Effect.gen(function* () {
        const known = yield* render(() => Effect.succeed(found(view())));
        const blank = yield* render(() => Effect.succeed(found(unknown())));

        expect(known).toMatch(/<button[^>]*>[^]*?Install<\/button>/);
        expect(text(blank)).not.toContain("installs");
        expect(text(blank)).not.toContain("Data from skills.sh");
      }),
  );

  it.effect(
    "tells an install would refuse the Skill for its size, with the files still listed",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(() =>
          Effect.succeed(found(view({ refused: "the folder holds 501 files, more than 500" }))),
        );

        expect(text(markup)).toContain(
          "An install would refuse this skill: the folder holds 501 files, more than 500.",
        );
        expect(text(markup)).toContain("3 files");
      }),
  );

  it.effect(
    "shows a root Skill's folder as the repo's root, and a SKILL.md with only frontmatter",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(() =>
          Effect.succeed(
            found(view({ path: "", skillMd: "---\nname: tdd\ndescription: d\n---\n" })),
          ),
        );

        expect(text(markup)).toContain("Repo root");
        expect(text(markup)).toContain("SKILL.md has no text below its frontmatter.");
      }),
  );

  it.effect(
    "keeps the ref and the folder it was asked for, shows the ref, and links the repo at the ref",
    () =>
      Effect.gen(function* () {
        const asked: unknown[] = [];

        const markup = yield* render(
          (payload) => {
            asked.push(payload);

            return Effect.succeed(found(view({ ref: "feature/x" })));
          },
          { search: "?ref=feature%2Fx&path=skills%2Fengineering%2Ftdd" },
        );

        expect(asked).toEqual([
          {
            owner: "mattpocock",
            repo: "skills",
            skill: "tdd",
            path: "skills/engineering/tdd",
            ref: "feature/x",
          },
        ]);
        expect(text(markup)).toContain("feature/x");
        expect(links(markup).map(({ href }) => href)).toContain(
          "/skills/mattpocock/skills?ref=feature%2Fx",
        );
      }),
  );

  it.effect("links its breadcrumb to the Skills page, its owner and its repo", () =>
    Effect.gen(function* () {
      const markup = yield* render(() => Effect.succeed(found(view())));
      const hrefs = links(markup).map(({ href }) => href);

      expect(hrefs).toContain("/skills");
      expect(hrefs).toContain("/skills/mattpocock");
      expect(hrefs).toContain("/skills/mattpocock/skills");
    }),
  );
});

describe("where a Skill's page says it is installed", () => {
  it.effect("is nowhere, said plainly", () =>
    Effect.gen(function* () {
      const markup = yield* render(() => Effect.succeed(found(view())));

      expect(text(markup)).toContain("Not installed in any environment.");
      expect(markup).not.toContain('aria-label="Update tdd"');
    }),
  );

  it.effect(
    "is every Environment and each Environment that keeps a copy, with its marks, Update and Remove",
    () =>
      Effect.gen(function* () {
        const markup = yield* render(
          () =>
            Effect.succeed(
              found(
                view({
                  installed: {
                    everyEnvironment: true,
                    environments: ["work"],
                    updateAvailable: true,
                  },
                }),
              ),
            ),
          {
            keptBy: {
              "*": [kept({ updateAvailable: true })],
              work: [
                kept({ modified: true }),
                kept({
                  name: "other",
                  source: { repo: "x/y", path: "z", ref: null, commit: COMMIT },
                }),
              ],
            },
          },
        );

        const body = text(markup);

        // The header's badges, and a section for each scope with a copy.
        expect(body).toContain("Installed · every environment");
        expect(body).toContain("Every environment");
        expect(body).toContain("Work");
        expect(body).not.toContain("Default");
        expect(body).toContain("update available");
        expect(body).toContain("modified");
        // Update and Remove are the Installed tab's, one pair for each copy.
        expect(markup.match(/aria-label="Update tdd"/g)).toHaveLength(2);
        expect(markup.match(/aria-label="Remove tdd"/g)).toHaveLength(2);
        // A Skill of another source that is kept in the scope is not this Skill.
        expect(markup).not.toContain('aria-label="Remove other"');
      }),
  );
});

describe("a Skill's page that has no Skill to show", () => {
  it.effect("says a Skill the repo does not hold, and links the repo's Skills", () =>
    Effect.gen(function* () {
      const markup = yield* render(
        () =>
          Effect.fail(
            SkillRepoError.make({ kind: "no_skill", message: "It holds none by that name." }),
          ),
        { skill: "nope" },
      );

      expect(markup).toContain('role="alert"');
      expect(text(markup)).toContain("mattpocock/skills has no skill “nope”");
      expect(links(markup)).toContainEqual({
        href: "/skills/mattpocock/skills",
        text: "See the skills in mattpocock/skills",
      });
      expect(markup).not.toContain("Install</button>");
    }),
  );

  it.effect("says a repo is not found, or not readable by the GitHub App, in one state", () =>
    Effect.gen(function* () {
      const markup = yield* render(() =>
        Effect.fail(SkillRepoError.make({ kind: "not_found", message: "GitHub has no repo." })),
      );

      expect(text(markup)).toContain(
        "mattpocock/skills was not found, or the GitHub App cannot read it.",
      );
      expect(text(markup)).toContain("GitHub has no repo.");
    }),
  );

  it.effect("says a ref the repo does not have, and links the Skill on the default branch", () =>
    Effect.gen(function* () {
      const markup = yield* render(
        () => Effect.fail(SkillRepoError.make({ kind: "bad_ref", message: "no ref" })),
        { search: "?ref=nope&path=skills%2Ftdd" },
      );

      expect(text(markup)).toContain("has no branch, tag or commit “nope”");
      expect(links(markup)).toContainEqual({
        href: "/skills/mattpocock/skills/tdd?path=skills%2Ftdd",
        text: "Show the Skill on its default branch",
      });
    }),
  );

  it.effect("says why GitHub failed, with Try again", () =>
    Effect.gen(function* () {
      const markup = yield* render(() =>
        Effect.fail(
          SkillRepoError.make({ kind: "rate_limited", message: "The limit is used up." }),
        ),
      );

      expect(text(markup)).toContain("GitHub did not give the skill tdd.");
      expect(text(markup)).toContain("The limit is used up.");
      expect(markup).toContain("Try again");
    }),
  );

  it.effect("lists the Skills a name could mean, each linking to its own folder", () =>
    Effect.gen(function* () {
      const markup = yield* render(
        () =>
          Effect.succeed({
            status: "ambiguous" as const,
            repo: "mattpocock/skills",
            ref: null,
            commit: COMMIT,
            candidates: [
              { name: "twin", description: "One.", path: "a/twin" },
              { name: "twin", description: "Two.", path: "" },
            ],
          }),
        { skill: "twin", search: "?ref=v1" },
      );

      expect(text(markup)).toContain("2 skills in mattpocock/skills are called “twin”");
      expect(links(markup).map(({ href }) => href)).toEqual(
        expect.arrayContaining([
          "/skills/mattpocock/skills/twin?ref=v1&path=a%2Ftwin",
          "/skills/mattpocock/skills/twin?ref=v1&path=",
        ]),
      );
      expect(markup).not.toContain("Install</button>");
    }),
  );
});
