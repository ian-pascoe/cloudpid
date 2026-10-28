// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

// The owner page rendered with `react-dom/server` over the fake Registry: the owner's list is settled first, so the markup
// shows what it answered. Its rows (Skills, installs, the link to each repo's page), "Open a repo", the honest note on
// the search's limit, the "not in the Skill directory" state, and skills.sh's error.

import { SkillDirectoryError, type SkillOwnerListing } from "@cloudpid/protocol";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { renderToStaticMarkup } from "react-dom/server";
import { type RegistryHandlers, registryWith, settled } from "./registry.testing.ts";
import { SkillOwnerPage } from "./skills-owner.tsx";
import { skillOwnerAtom } from "./skills-owner-state.ts";

const LISTING: SkillOwnerListing = {
  owner: "mattpocock",
  repos: [
    { repo: "skills", skills: 52, installs: 21_400_000 },
    { repo: "sandcastle", skills: 1, installs: 950 },
  ],
  capped: false,
};

/** The owner page of `mattpocock`, once its list (as `listOwnerRepos` answers) has loaded. */
const render = (listOwnerRepos: RegistryHandlers["listOwnerRepos"]) =>
  Effect.gen(function* () {
    const registry = registryWith({ listOwnerRepos, listEnvironments: () => Effect.succeed([]) });

    registry.mount(skillOwnerAtom("mattpocock"));
    yield* settled(registry, skillOwnerAtom("mattpocock"));

    const markup = renderToStaticMarkup(
      <RegistryContext.Provider value={registry}>
        <SkillOwnerPage owner="mattpocock" />
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

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replaceAll("&#x27;", "'");

describe("the owner page", () => {
  it.effect("lists the owner's repos with Skills and installs, each opening its repo page", () =>
    Effect.gen(function* () {
      const markup = yield* render(() => Effect.succeed(LISTING));
      const body = text(markup);

      expect(markup).toContain("<h1");
      expect(markup).toContain('aria-label="Repos of mattpocock"');
      expect(markup.indexOf("sandcastle")).toBeGreaterThan(markup.indexOf(">skills<"));
      expect(body).toContain("52 skills");
      expect(body).toContain("1 skill ");
      expect(body).toContain("21.4M");
      expect(body).toContain("950");
      expect(markup).toContain('title="21,400,000 installs"');

      const hrefs = links(markup).map(({ href }) => href);

      expect(hrefs).toContain("/skills/mattpocock/skills");
      expect(hrefs).toContain("/skills/mattpocock/sandcastle");
      // Back to the Skills page; the owner on GitHub.
      expect(hrefs).toContain("/skills");
      expect(hrefs).toContain("https://github.com/mattpocock");
      expect(body).toContain("Data from skills.sh");
      expect(body).not.toContain("not in the Skill directory");
    }),
  );

  it.effect(
    "says the list comes from a fuzzy search of at most 200 results, and when it hit that",
    () =>
      Effect.gen(function* () {
        const below = text(yield* render(() => Effect.succeed(LISTING)));
        const capped = text(yield* render(() => Effect.succeed({ ...LISTING, capped: true })));

        expect(below).toContain("fuzzy and answers at most 200 results");
        expect(below).toContain("may not show every repo or Skill");
        expect(capped).toContain("hit its limit of 200 results");
        expect(capped).toContain("probably missing");
        expect(capped).toContain("A repo's page lists what GitHub has in it.");
      }),
  );

  it.effect("always offers Open a repo, for a repo skills.sh does not list", () =>
    Effect.gen(function* () {
      const markup = yield* render(() => Effect.succeed(LISTING));

      expect(markup).toContain('<form aria-label="Open a repo"');
      expect(markup).toContain(
        '<label for="skills-open-repo" class="sr-only">Repo of mattpocock</label>',
      );
      expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>Open a repo<\/button>/);
    }),
  );

  it.effect("says the owner is not in the Skill directory, and still offers Open a repo", () =>
    Effect.gen(function* () {
      const markup = yield* render(({ owner }) =>
        Effect.succeed({ owner, repos: [], capped: false }),
      );

      expect(text(markup)).toContain("mattpocock is not in the Skill directory.");
      expect(markup).toContain('role="status"');
      expect(markup).not.toContain("Repos of mattpocock");
      expect(markup).toContain('<form aria-label="Open a repo"');
      expect(text(markup)).toContain("Data from skills.sh");
    }),
  );

  it.effect("shows skills.sh's error plainly with Try again, and Open a repo still there", () =>
    Effect.gen(function* () {
      const markup = yield* render(() =>
        Effect.fail(SkillDirectoryError.make({ message: "skills.sh answered 503" })),
      );

      expect(markup).toContain('role="alert"');
      expect(text(markup)).toContain("skills.sh answered 503");
      expect(text(markup)).toContain("Try again");
      expect(text(markup)).not.toContain("not in the Skill directory");
      expect(markup).toContain('<form aria-label="Open a repo"');
    }),
  );
});
