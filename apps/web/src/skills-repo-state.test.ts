// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

// The repo page's state over the fake Registry: what is asked of it, why there is no listing, what Install selected takes,
// and the badges following an install.

import { type RepoSkill, SkillRepoError, type SkillRepoListing } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { EVERY_ENVIRONMENT } from "./environments.ts";
import { registryWith, settled } from "./registry.testing.ts";
import {
  checkedSkillsAtom,
  installSelected,
  skillRepoAtom,
  skillRepoFailureOf,
  skillRepoKey,
} from "./skills-repo-state.ts";
import { installToTargetAtom } from "./skills-state.ts";

const COMMIT = "c0ffee0000000000000000000000000000000001";

const skill = (name: string, extra: Partial<RepoSkill> = {}): RepoSkill => ({
  name,
  description: `What ${name} does.`,
  path: `skills/${name}`,
  skillId: name,
  ...extra,
});

const listing = (
  skills: ReadonlyArray<RepoSkill>,
  ref: string | null = null,
): SkillRepoListing => ({
  repo: "o/skills",
  ref,
  commit: COMMIT,
  skills,
  unreadable: [],
  omitted: 0,
});

const INSTALLED = { everyEnvironment: true, environments: [], updateAvailable: false };

describe("a repo's Skills", () => {
  it.effect("are asked of the Registry for the owner, the repo and the ref when one is named", () =>
    Effect.gen(function* () {
      const asked: unknown[] = [];

      const registry = registryWith({
        listRepoSkills: (payload) => {
          asked.push(payload);

          return Effect.succeed(listing([skill("tdd", { installs: 12 })], payload.ref ?? null));
        },
      });

      const plain = skillRepoAtom(skillRepoKey("o", "skills"));
      const pinned = skillRepoAtom(skillRepoKey("o", "skills", "v1"));

      registry.mount(plain);
      registry.mount(pinned);

      const first = AsyncResult.getOrThrow(yield* settled(registry, plain));
      const second = AsyncResult.getOrThrow(yield* settled(registry, pinned));

      expect(asked).toEqual([
        { owner: "o", repo: "skills" },
        { owner: "o", repo: "skills", ref: "v1" },
      ]);
      expect(first.skills).toEqual([skill("tdd", { installs: 12 })]);
      expect(second.ref).toBe("v1");
      registry.dispose();
    }),
  );

  it.effect("say why there is no listing, by kind, and call any other failure a plain one", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        listRepoSkills: ({ repo }) => {
          switch (repo) {
            case "gone":
              return Effect.fail(
                SkillRepoError.make({ kind: "not_found", message: "GitHub has no repo o/gone" }),
              );
            case "badref":
              return Effect.fail(SkillRepoError.make({ kind: "bad_ref", message: "no such ref" }));
            case "broken":
              return Effect.die("boom");
            default:
              return Effect.succeed(listing([]));
          }
        },
      });

      const failureOf = (repo: string) => {
        const atom = skillRepoAtom(skillRepoKey("o", repo));

        registry.mount(atom);

        return settled(registry, atom).pipe(Effect.map(skillRepoFailureOf));
      };

      expect(yield* failureOf("gone")).toEqual({
        kind: "not_found",
        message: "GitHub has no repo o/gone",
      });
      expect(yield* failureOf("badref")).toEqual({ kind: "bad_ref", message: "no such ref" });
      expect(yield* failureOf("broken")).toMatchObject({ kind: "failed" });
      // A repo with no Skills is an answer, not a failure.
      expect(yield* failureOf("empty")).toBeNull();
      registry.dispose();
    }),
  );
});

describe("Install selected", () => {
  const repo = listing([skill("grill-me"), skill("tdd"), skill("notes")]);

  it("takes the checked Skills by name, in the repo's order, from the repo itself", () => {
    expect(installSelected(repo, new Set(["skills/tdd", "skills/grill-me"]), undefined)).toEqual({
      source: "o/skills",
      skills: ["grill-me", "tdd"],
      ref: undefined,
    });
  });

  it("pins to the ref the page shows", () => {
    expect(installSelected(repo, new Set(["skills/tdd"]), "v1.2")).toEqual({
      source: "o/skills",
      skills: ["tdd"],
      ref: "v1.2",
    });
  });

  it("takes nothing while nothing is checked, and ignores a check the listing no longer has", () => {
    expect(installSelected(repo, new Set(), undefined)).toBeNull();
    expect(installSelected(repo, new Set(["skills/gone"]), undefined)).toBeNull();
  });

  it("is kept apart for each repo and ref", () => {
    const registry = registryWith({});

    registry.set(checkedSkillsAtom(skillRepoKey("o", "skills")), new Set(["skills/tdd"]));

    expect([...registry.get(checkedSkillsAtom(skillRepoKey("o", "skills")))]).toEqual([
      "skills/tdd",
    ]);
    expect([...registry.get(checkedSkillsAtom(skillRepoKey("o", "skills", "v1")))]).toEqual([]);
    expect([...registry.get(checkedSkillsAtom(skillRepoKey("o", "other")))]).toEqual([]);
    registry.dispose();
  });

  it.effect("installs the checked Skills at the ref and the page's badges follow", () =>
    Effect.gen(function* () {
      const installs: Array<{
        environment: string;
        source: string;
        skills: ReadonlyArray<string>;
      }> = [];

      let asked = 0;

      const registry = registryWith({
        listRepoSkills: () => {
          asked += 1;

          return Effect.succeed(
            listing([skill("tdd", installs.length === 0 ? {} : { installed: INSTALLED })]),
          );
        },
        installEnvironmentSkills: ({ environment, source, skills }) => {
          installs.push({ environment, source, skills: skills ?? [] });

          return Effect.succeed({
            status: "installed" as const,
            environment,
            repo: "o/skills",
            ref: "v1",
            commit: COMMIT,
            skills: [
              { name: "tdd", path: "skills/tdd", outcome: "installed" as const, overriddenIn: [] },
            ],
          });
        },
      });

      const atom = skillRepoAtom(skillRepoKey("o", "skills", "v1"));

      registry.mount(atom);
      registry.mount(installToTargetAtom);

      const before = AsyncResult.getOrThrow(yield* settled(registry, atom));

      expect(before.skills[0]?.installed).toBeUndefined();

      const toInstall = installSelected(before, new Set(["skills/tdd"]), "v1");

      if (toInstall === null) throw new Error("nothing to install");

      registry.set(installToTargetAtom, { target: EVERY_ENVIRONMENT, ...toInstall });
      yield* settled(registry, installToTargetAtom);

      // The install names a ref as an install does: a tree URL, with only the checked Skill.
      expect(installs).toEqual([
        { environment: "*", source: "https://github.com/o/skills/tree/v1", skills: ["tdd"] },
      ]);

      const after = AsyncResult.getOrThrow(yield* settled(registry, atom));

      expect(asked).toBe(2);
      expect(after.skills[0]?.installed).toEqual({
        everyEnvironment: true,
        environments: [],
        updateAvailable: false,
      });
      registry.dispose();
    }),
  );
});
