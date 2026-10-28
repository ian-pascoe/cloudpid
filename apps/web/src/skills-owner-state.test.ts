// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

// The owner page's state over the fake Registry: what is asked of it, why there is no list, and what "Open a repo" opens.

import { SkillDirectoryError, type SkillOwnerListing } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { failureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { openRepoPath, skillOwnerAtom } from "./skills-owner-state.ts";

const listing = (owner: string): SkillOwnerListing => ({
  owner,
  repos: [{ repo: "skills", skills: 3, installs: 12_000 }],
  capped: false,
});

describe("an owner's repos", () => {
  it.effect("are asked of the Registry by the owner's name, each owner apart", () =>
    Effect.gen(function* () {
      const asked: unknown[] = [];

      const registry = registryWith({
        listOwnerRepos: (payload) => {
          asked.push(payload);

          return Effect.succeed(listing(payload.owner));
        },
      });

      const first = skillOwnerAtom("mattpocock");
      const second = skillOwnerAtom("vercel-labs");

      registry.mount(first);
      registry.mount(second);

      const one = AsyncResult.getOrThrow(yield* settled(registry, first));
      const two = AsyncResult.getOrThrow(yield* settled(registry, second));

      expect(asked).toEqual([{ owner: "mattpocock" }, { owner: "vercel-labs" }]);
      expect(one).toEqual(listing("mattpocock"));
      expect(two.owner).toBe("vercel-labs");
      registry.dispose();
    }),
  );

  it.effect("are an empty answer, not a failure, for an owner the directory lists nothing of", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        listOwnerRepos: ({ owner }) =>
          Effect.succeed({ owner, repos: [], capped: false } satisfies SkillOwnerListing),
      });

      const atom = skillOwnerAtom("nobody");

      registry.mount(atom);

      const answer = yield* settled(registry, atom);

      expect(failureOf(answer)).toBeNull();
      expect(AsyncResult.getOrThrow(answer).repos).toEqual([]);
      registry.dispose();
    }),
  );

  it.effect("fail with skills.sh's own words when it does not answer", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        listOwnerRepos: () =>
          Effect.fail(SkillDirectoryError.make({ message: "skills.sh answered 503" })),
      });

      const atom = skillOwnerAtom("mattpocock");

      registry.mount(atom);
      expect(failureOf(yield* settled(registry, atom))).toBe("skills.sh answered 503");
      registry.dispose();
    }),
  );
});

describe("Open a repo", () => {
  it("opens the repo page of the owner for the repo's name, or for owner/repo as GitHub shows it", () => {
    expect(openRepoPath("*", "mattpocock", "skills")).toEqual({
      ok: true,
      path: "/settings/all/skills/mattpocock/skills",
    });
    expect(openRepoPath("*", "mattpocock", "  skills ")).toEqual({
      ok: true,
      path: "/settings/all/skills/mattpocock/skills",
    });
    expect(openRepoPath("*", "mattpocock", "MattPocock/Skills")).toEqual({
      ok: true,
      path: "/settings/all/skills/mattpocock/Skills",
    });
    expect(openRepoPath("*", "o", "r.js")).toEqual({
      ok: true,
      path: "/settings/all/skills/o/r.js",
    });
    expect(openRepoPath("work", "o", "r")).toEqual({ ok: true, path: "/settings/work/skills/o/r" });
  });

  it("refuses an empty name, another owner's repo, . and .., and anything GitHub cannot name a repo", () => {
    for (const typed of [
      "",
      "   ",
      "other/skills",
      "o/",
      "/skills",
      "a b",
      "o/a/b",
      "o/a b",
      ".",
      "..",
      "o/..",
      "a?b",
      "a#b",
      "a%2Fb",
      "x".repeat(101),
    ]) {
      const opened = openRepoPath("*", "o", typed);

      expect(opened.ok, typed).toBe(false);
    }

    expect(openRepoPath("*", "o", "")).toEqual({
      ok: false,
      message: "Type the name of a repo of o.",
    });
  });
});
