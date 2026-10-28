// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

// A Skill's page's state over the fake Registry: what is asked of it (owner, repo, Skill, folder and ref), why there is no
// Skill (by kind), the Skills a name could mean, where the Skill is installed (matched by Skill source, in the scopes
// that keep a copy), and Install, Update and Remove from the page with the page following.

import {
  type EnvironmentRecord,
  type EnvironmentSkill,
  SkillRepoError,
  type SkillView,
  type SkillViewAnswer,
} from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { EVERY_ENVIRONMENT } from "./environments.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { skillRepoFailureOf } from "./skills-repo-state.ts";
import {
  installedCopiesAtom,
  skillToInstall,
  skillViewAtom,
  skillViewKey,
} from "./skills-skill-state.ts";
import { installToTargetAtom, removeSkillAtom, updateSkillAtom } from "./skills-state.ts";

const COMMIT = "c0ffee0000000000000000000000000000000001";

const ENVIRONMENTS: ReadonlyArray<EnvironmentRecord> = [
  { id: "default", name: "Default", repos: [], createdAt: 1 },
  { id: "work", name: "Work", repos: [], createdAt: 1 },
];

const view = (over: Partial<SkillView> = {}): SkillView => ({
  repo: "o/skills",
  ref: null,
  commit: COMMIT,
  name: "tdd",
  description: "Test first.",
  path: "skills/tdd",
  skillId: "tdd",
  skillMd: "---\nname: tdd\ndescription: Test first.\n---\nSteps.\n",
  skillMdFile: "SKILL.md",
  files: [{ path: "SKILL.md", size: 50 }],
  ...over,
});

const found = (skill: SkillView): SkillViewAnswer => ({ status: "found", skill });

const kept = (
  name: string,
  path: string,
  over: Partial<EnvironmentSkill> = {},
): EnvironmentSkill => ({
  name,
  description: `What ${name} does.`,
  savedAt: 1,
  source: { repo: "o/skills", path, ref: null, commit: COMMIT },
  ...over,
});

describe("a Skill's page", () => {
  it.effect(
    "is asked of the Registry for the owner, the repo, the Skill, and the folder and ref when named",
    () =>
      Effect.gen(function* () {
        const asked: unknown[] = [];

        const registry = registryWith({
          viewSkill: (payload) => {
            asked.push(payload);

            return Effect.succeed(found(view()));
          },
        });

        const plain = skillViewAtom(skillViewKey("o", "skills", "tdd"));
        const exact = skillViewAtom(skillViewKey("o", "skills", "tdd", "skills/tdd", "v1"));
        const root = skillViewAtom(skillViewKey("o", "skills", "root", ""));

        registry.mount(plain);
        registry.mount(exact);
        registry.mount(root);
        yield* settled(registry, plain);
        yield* settled(registry, exact);
        yield* settled(registry, root);

        expect(asked).toEqual([
          { owner: "o", repo: "skills", skill: "tdd" },
          { owner: "o", repo: "skills", skill: "tdd", path: "skills/tdd", ref: "v1" },
          // The root's folder is an empty path, which is a folder and not none.
          { owner: "o", repo: "skills", skill: "root", path: "" },
        ]);
        registry.dispose();
      }),
  );

  it.effect("answers the Skill, or the Skills its name could mean", () =>
    Effect.gen(function* () {
      const candidates = [
        { name: "twin", description: "One.", path: "a/twin" },
        { name: "twin", description: "Two.", path: "b/twin" },
      ];

      const registry = registryWith({
        viewSkill: ({ skill }) =>
          Effect.succeed(
            skill === "twin"
              ? {
                  status: "ambiguous" as const,
                  repo: "o/skills",
                  ref: null,
                  commit: COMMIT,
                  candidates,
                }
              : found(view()),
          ),
      });

      const one = skillViewAtom(skillViewKey("o", "skills", "tdd"));
      const twins = skillViewAtom(skillViewKey("o", "skills", "twin"));

      registry.mount(one);
      registry.mount(twins);

      expect(AsyncResult.getOrThrow(yield* settled(registry, one))).toEqual(found(view()));
      expect(AsyncResult.getOrThrow(yield* settled(registry, twins))).toMatchObject({
        status: "ambiguous",
        candidates,
      });
      registry.dispose();
    }),
  );

  it.effect("says why there is no Skill, by kind, and calls any other failure a plain one", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        viewSkill: ({ skill }) => {
          switch (skill) {
            case "gone":
              return Effect.fail(SkillRepoError.make({ kind: "not_found", message: "no repo" }));
            case "badref":
              return Effect.fail(SkillRepoError.make({ kind: "bad_ref", message: "no ref" }));
            case "none":
              return Effect.fail(SkillRepoError.make({ kind: "no_skill", message: "no skill" }));
            case "limit":
              return Effect.fail(
                SkillRepoError.make({ kind: "rate_limited", message: "slow down" }),
              );
            case "broken":
              return Effect.die("boom");
            default:
              return Effect.succeed(found(view()));
          }
        },
      });

      const failureOf = (skill: string) => {
        const atom = skillViewAtom(skillViewKey("o", "skills", skill));

        registry.mount(atom);

        return settled(registry, atom).pipe(Effect.map(skillRepoFailureOf));
      };

      expect(yield* failureOf("gone")).toEqual({ kind: "not_found", message: "no repo" });
      expect(yield* failureOf("badref")).toEqual({ kind: "bad_ref", message: "no ref" });
      expect(yield* failureOf("none")).toEqual({ kind: "no_skill", message: "no skill" });
      expect(yield* failureOf("limit")).toEqual({ kind: "rate_limited", message: "slow down" });
      expect(yield* failureOf("broken")).toMatchObject({ kind: "failed" });
      expect(yield* failureOf("tdd")).toBeNull();
      registry.dispose();
    }),
  );

  it("is what Install installs: this Skill of its repo by its folder, at the ref shown", () => {
    expect(skillToInstall(view(), undefined)).toEqual({
      source: "o/skills",
      skills: ["tdd"],
      folders: ["skills/tdd"],
      ref: undefined,
    });
    expect(skillToInstall(view({ path: "" }), "v1")).toEqual({
      source: "o/skills",
      skills: ["tdd"],
      folders: [""],
      ref: "v1",
    });
  });
});

describe("where a Skill is installed", () => {
  it.effect(
    "is each scope that keeps a copy from its Skill source, never another Skill of the name",
    () =>
      Effect.gen(function* () {
        const registry = registryWith({
          listEnvironments: () => Effect.succeed(ENVIRONMENTS),
          listEnvironmentSkills: ({ environment }) =>
            Effect.succeed(
              {
                "*": [kept("tdd", "skills/tdd"), kept("notes", "skills/notes")],
                default: [],
                // The same name from another folder, and the same folder of another repo: not this Skill.
                work: [
                  kept("tdd", "elsewhere/tdd"),
                  kept("tdd", "skills/tdd", {
                    source: { repo: "x/other", path: "skills/tdd", ref: null, commit: COMMIT },
                  }),
                  kept("tdd-copy", "skills/tdd", {
                    source: { repo: "O/Skills", path: "skills/tdd", ref: "dev", commit: COMMIT },
                    updateAvailable: true,
                  }),
                ],
              }[environment] ?? [],
            ),
        });

        const atom = installedCopiesAtom({ repo: "o/skills", path: "skills/tdd" });

        registry.mount(atom);

        // Wait for the scopes' lists to load.
        yield* Effect.callback<void>((resume) => {
          const cancel = registry.subscribe(atom, (state) => {
            if (state.loading) return;

            cancel();
            resume(Effect.void);
          });

          if (!registry.get(atom).loading) {
            cancel();
            resume(Effect.void);
          }
        });

        const { scopes, loading } = registry.get(atom);

        expect(loading).toBe(false);
        expect(scopes.map(({ scope, copies }) => [scope, copies.map(({ name }) => name)])).toEqual([
          [EVERY_ENVIRONMENT, ["tdd"]],
          // GitHub's names ignore case; the copy keeps its own name.
          ["work", ["tdd-copy"]],
        ]);
        // A scope's dialogs look in all its Skills, not only the copies.
        expect(scopes[1]?.skills).toHaveLength(3);
        registry.dispose();
      }),
  );

  it("is loading until the Environments and their Skills are known, and none while nothing is installed", () => {
    const registry = registryWith({ listEnvironments: () => Effect.never });
    const atom = installedCopiesAtom({ repo: "o/skills", path: "skills/tdd" });

    registry.mount(atom);
    expect(registry.get(atom)).toMatchObject({ loading: true, scopes: [] });
    registry.dispose();
  });
});

describe("Install, Update and Remove from a Skill's page", () => {
  it.effect(
    "install into every Environment or one at the ref, and the page's badge and copies follow",
    () =>
      Effect.gen(function* () {
        const installs: Array<{
          environment: string;
          source: string;
          skills: ReadonlyArray<string> | undefined;
          folders: ReadonlyArray<string> | undefined;
        }> = [];

        let copies: EnvironmentSkill[] = [];

        const registry = registryWith({
          listEnvironments: () => Effect.succeed(ENVIRONMENTS),
          viewSkill: () =>
            Effect.succeed(
              found(
                view(
                  copies.length === 0
                    ? {}
                    : {
                        installed: {
                          everyEnvironment: false,
                          environments: ["work"],
                          updateAvailable: false,
                        },
                      },
                ),
              ),
            ),
          listEnvironmentSkills: ({ environment }) =>
            Effect.succeed(environment === "work" ? copies : []),
          installEnvironmentSkills: ({ environment, source, skills, folders }) => {
            installs.push({ environment, source, skills, folders });
            copies = [kept("tdd", "skills/tdd")];

            return Effect.succeed({
              status: "installed" as const,
              environment,
              repo: "o/skills",
              ref: "v1",
              commit: COMMIT,
              skills: [
                {
                  name: "tdd",
                  path: "skills/tdd",
                  outcome: "installed" as const,
                  overriddenIn: [],
                },
              ],
            });
          },
        });

        const atom = skillViewAtom(skillViewKey("o", "skills", "tdd", undefined, "v1"));
        const here = installedCopiesAtom({ repo: "o/skills", path: "skills/tdd" });

        registry.mount(atom);
        registry.mount(here);
        registry.mount(installToTargetAtom);

        const before = AsyncResult.getOrThrow(yield* settled(registry, atom));

        if (before.status !== "found") throw new Error("not found");

        expect(before.skill.installed).toBeUndefined();

        registry.set(installToTargetAtom, {
          target: "work",
          ...skillToInstall(before.skill, "v1"),
        });
        yield* settled(registry, installToTargetAtom);

        expect(installs).toEqual([
          {
            environment: "work",
            source: "https://github.com/o/skills/tree/v1",
            skills: undefined,
            // Exactly this Skill's folder, whatever else the repo holds or calls the same.
            folders: ["skills/tdd"],
          },
        ]);

        const after = AsyncResult.getOrThrow(yield* settled(registry, atom));

        expect(after.status === "found" && after.skill.installed?.environments).toEqual(["work"]);
        registry.dispose();
      }),
  );

  it.effect(
    "update and remove are the Installed tab's atoms, and ask the page for its badge again",
    () =>
      Effect.gen(function* () {
        const calls: string[] = [];
        let asked = 0;
        let copies = [kept("tdd", "skills/tdd", { updateAvailable: true })];

        const registry = registryWith({
          listEnvironments: () => Effect.succeed(ENVIRONMENTS),
          viewSkill: () => {
            asked += 1;

            return Effect.succeed(found(view()));
          },
          listEnvironmentSkills: ({ environment }) =>
            Effect.succeed(environment === EVERY_ENVIRONMENT ? copies : []),
          updateEnvironmentSkills: ({ environment, names, overwrite }) => {
            calls.push(`update ${environment} ${(names ?? []).join(",")} ${String(overwrite)}`);
            copies = [kept("tdd", "skills/tdd")];

            return Effect.succeed({ skills: [{ name: "tdd", outcome: "updated" as const }] });
          },
          removeEnvironmentSkill: ({ environment, name }) =>
            Effect.sync(() => {
              calls.push(`remove ${environment} ${name}`);
              copies = [];
            }),
        });

        const atom = skillViewAtom(skillViewKey("o", "skills", "tdd"));
        const here = installedCopiesAtom({ repo: "o/skills", path: "skills/tdd" });

        registry.mount(atom);
        registry.mount(here);
        registry.mount(updateSkillAtom(EVERY_ENVIRONMENT));
        registry.mount(removeSkillAtom(EVERY_ENVIRONMENT));
        yield* settled(registry, atom);

        registry.set(updateSkillAtom(EVERY_ENVIRONMENT), { name: "tdd", overwrite: false });
        yield* settled(registry, updateSkillAtom(EVERY_ENVIRONMENT));
        yield* settled(registry, atom);

        expect(calls).toEqual(["update * tdd false"]);
        expect(asked).toBe(2);
        expect(registry.get(here).scopes[0]?.copies[0]?.updateAvailable).toBeUndefined();

        registry.set(removeSkillAtom(EVERY_ENVIRONMENT), "tdd");
        yield* settled(registry, removeSkillAtom(EVERY_ENVIRONMENT));
        yield* settled(registry, atom);

        expect(calls).toEqual(["update * tdd false", "remove * tdd"]);
        expect(asked).toBe(3);
        registry.dispose();
      }),
  );
});
