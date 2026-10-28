// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import { type AgentChange, EnvironmentError } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "@effect/vitest";
import { revertAgentChangeAtom } from "./environments-state.ts";
import { EVERY_ENVIRONMENT } from "./environments.ts";
import { settledFailureOf } from "./registry.ts";
import { registryWith, settled } from "./registry.testing.ts";
import { searchAtom } from "./router.ts";
import {
  environmentSkillsAtom,
  installSkillsAtom,
  keptSkillFilesAtom,
  removeSkillAtom,
  searchSkillsAtom,
  skillChangeFilesAtom,
  skillChangeKey,
  skillKey,
  skillsTabAtom,
  skillSourceAtom,
  skillUpdateDialogAtom,
  updateSkillAtom,
} from "./skills-state.ts";

describe("the Skills page's tab", () => {
  it("is the one the query names, and Installed when it names none it knows", () => {
    const registry = registryWith({});

    expect(registry.get(skillsTabAtom)).toBe("installed");

    registry.set(searchAtom, "?tab=hot");
    expect(registry.get(skillsTabAtom)).toBe("hot");

    registry.set(searchAtom, "?tab=nope&environment=work");
    expect(registry.get(skillsTabAtom)).toBe("installed");
  });
});

describe("the files kept for a Skill with no Skill source", () => {
  it.effect("are asked for by scope and name, once per Skill, and say why they cannot load", () =>
    Effect.gen(function* () {
      const asked: Array<{ environment: string; name: string }> = [];

      const registry = registryWith({
        environmentSkillFiles: (input) =>
          Effect.suspend(() => {
            asked.push(input);

            return input.name === "gone"
              ? Effect.fail(
                  new EnvironmentError({ message: 'The environment keeps no Skill named "gone"' }),
                )
              : Effect.succeed([{ path: "SKILL.md", text: `${input.environment}/${input.name}` }]);
          }),
      });

      const atom = keptSkillFilesAtom(skillKey("*", "release"));

      // Equal keys are the same atom; another Skill or scope is another.
      expect(keptSkillFilesAtom(skillKey("*", "release"))).toBe(atom);
      expect(keptSkillFilesAtom(skillKey("work", "release"))).not.toBe(atom);
      expect(AsyncResult.getOrThrow(yield* settled(registry, atom))).toEqual([
        { path: "SKILL.md", text: "*/release" },
      ]);

      const gone = keptSkillFilesAtom(skillKey("work", "gone"));

      expect(settledFailureOf(yield* settled(registry, gone))).toBe(
        'The environment keeps no Skill named "gone"',
      );
      expect(asked).toEqual([
        { environment: "*", name: "release" },
        { environment: "work", name: "gone" },
      ]);
    }),
  );

  it.effect("are asked for again once the scope's Skills change", () =>
    Effect.gen(function* () {
      let text = "before";

      const registry = registryWith({
        environmentSkillFiles: () => Effect.sync(() => [{ path: "SKILL.md", text }]),
        removeEnvironmentSkill: () =>
          Effect.sync(() => {
            text = "after";
          }),
      });

      const atom = keptSkillFilesAtom(skillKey("work", "release"));

      registry.mount(atom);
      expect(AsyncResult.getOrThrow(yield* settled(registry, atom))).toEqual([
        { path: "SKILL.md", text: "before" },
      ]);

      registry.mount(removeSkillAtom("work"));
      registry.set(removeSkillAtom("work"), "other");
      yield* settled(registry, removeSkillAtom("work"));

      expect(AsyncResult.getOrThrow(yield* settled(registry, atom))).toEqual([
        { path: "SKILL.md", text: "after" },
      ]);
      registry.dispose();
    }),
  );
});

describe("the Skills' Agent changes", () => {
  const change = (id: number, revertedBy: number | null = null): AgentChange => ({
    id,
    scope: "work",
    at: 1,
    actor: "agent",
    session: "s-1",
    conversation: 1,
    tool: "environment_variable_set",
    reason: "The tests read it",
    field: "variables.API_URL",
    before: null,
    after: "https://api.test",
    reverts: null,
    revertedBy,
  });

  it.effect("ask a Skill change's files once per change, keyed by Environment and change", () =>
    Effect.gen(function* () {
      const asked: Array<{ environment: string; change: number }> = [];

      const registry = registryWith({
        skillChangeFiles: (input) =>
          Effect.sync(() => {
            asked.push(input);

            return { before: null, after: [{ path: "SKILL.md", text: `change ${input.change}` }] };
          }),
      });

      const atom = skillChangeFilesAtom(skillChangeKey("work", 3));

      // Equal keys are the same atom; another change of the same Environment is another.
      expect(skillChangeFilesAtom(skillChangeKey("work", 3))).toBe(atom);
      expect(skillChangeFilesAtom(skillChangeKey("work", 4))).not.toBe(atom);
      expect(AsyncResult.getOrThrow(yield* settled(registry, atom))).toEqual({
        before: null,
        after: [{ path: "SKILL.md", text: "change 3" }],
      });
      expect(asked).toEqual([{ environment: "work", change: 3 }]);
    }),
  );

  it.effect(
    "of the Skills kept for every Environment load by the scope *, and a removal or revert loads them again",
    () =>
      Effect.gen(function* () {
        let kept = [
          { name: "release", description: "Cut a release.", savedAt: 1 },
          { name: "review", description: "Review code.", savedAt: 2 },
        ];

        const asked: string[] = [];
        const removed: Array<{ environment: string; name: string }> = [];

        const registry = registryWith({
          listEnvironmentSkills: ({ environment }) =>
            Effect.sync(() => {
              asked.push(environment);

              return environment === "*" ? kept : [];
            }),
          removeEnvironmentSkill: (input) =>
            Effect.sync(() => {
              removed.push(input);
              kept = kept.filter((skill) => skill.name !== input.name);
            }),
          revertAgentChange: () =>
            Effect.sync(() => {
              kept = [{ name: "release", description: "Cut a release.", savedAt: 1 }];

              return {
                ...change(2),
                scope: "*",
                field: "skills.review",
                actor: "owner" as const,
                reverts: 1,
              };
            }),
          listBuilds: () => Effect.succeed([]),
        });

        registry.mount(environmentSkillsAtom(EVERY_ENVIRONMENT));
        expect(
          AsyncResult.getOrThrow(
            yield* settled(registry, environmentSkillsAtom(EVERY_ENVIRONMENT)),
          ),
        ).toHaveLength(2);

        registry.mount(removeSkillAtom(EVERY_ENVIRONMENT));
        registry.set(removeSkillAtom(EVERY_ENVIRONMENT), "review");
        yield* settled(registry, removeSkillAtom(EVERY_ENVIRONMENT));
        yield* settled(registry, environmentSkillsAtom(EVERY_ENVIRONMENT));

        expect(removed).toEqual([{ environment: "*", name: "review" }]);
        expect(
          AsyncResult.getOrThrow(registry.get(environmentSkillsAtom(EVERY_ENVIRONMENT))).map(
            (skill) => skill.name,
          ),
        ).toEqual(["release"]);

        // A revert of a change of the scope * asks for the Skills of the scope again.
        kept = [];
        registry.mount(revertAgentChangeAtom(EVERY_ENVIRONMENT));
        registry.set(revertAgentChangeAtom(EVERY_ENVIRONMENT), 1);
        yield* settled(registry, revertAgentChangeAtom(EVERY_ENVIRONMENT));
        yield* settled(registry, environmentSkillsAtom(EVERY_ENVIRONMENT));

        expect(asked.every((environment) => environment === "*")).toBe(true);
        expect(
          AsyncResult.getOrThrow(registry.get(environmentSkillsAtom(EVERY_ENVIRONMENT))).map(
            (skill) => skill.name,
          ),
        ).toEqual(["release"]);
        registry.dispose();
      }),
  );
});

describe("the Skills an Environment installs from GitHub", () => {
  const COMMIT = "c0ffee0000000000000000000000000000000001";

  it.effect("list a source that holds several, keeping nothing and the form as typed", () =>
    Effect.gen(function* () {
      const asked: unknown[] = [];

      const registry = registryWith({
        installEnvironmentSkills: (input) =>
          Effect.sync(() => {
            asked.push(input);

            return {
              status: "listed" as const,
              repo: "mattpocock/skills",
              ref: null,
              commit: COMMIT,
              available: [
                { name: "grill-me", description: "Interview me.", path: "skills/grill-me" },
              ],
            };
          }),
      });

      registry.mount(skillSourceAtom("work"));
      registry.set(skillSourceAtom("work"), " mattpocock/skills ");
      registry.set(installSkillsAtom("work"), { source: " mattpocock/skills " });

      expect(AsyncResult.getOrThrow(yield* settled(registry, installSkillsAtom("work")))).toEqual({
        status: "listed",
        repo: "mattpocock/skills",
        ref: null,
        commit: COMMIT,
        available: [{ name: "grill-me", description: "Interview me.", path: "skills/grill-me" }],
      });
      // The source goes as typed but trimmed, with no Skills named.
      expect(asked).toEqual([{ environment: "work", source: "mattpocock/skills" }]);
      expect(registry.get(skillSourceAtom("work"))).toBe(" mattpocock/skills ");
    }),
  );

  it.effect(
    "install the Skills ticked, empty the form and list the Environment's Skills again",
    () =>
      Effect.gen(function* () {
        let installed = false;
        const asked: unknown[] = [];

        const registry = registryWith({
          listEnvironmentSkills: () =>
            Effect.succeed(
              installed
                ? [
                    {
                      name: "grill-me",
                      description: "Interview me.",
                      savedAt: 5,
                      source: {
                        repo: "mattpocock/skills",
                        path: "skills/grill-me",
                        ref: null,
                        commit: COMMIT,
                      },
                    },
                  ]
                : [],
            ),
          installEnvironmentSkills: (input) =>
            Effect.sync(() => {
              asked.push(input);
              installed = true;

              return {
                status: "installed" as const,
                repo: "mattpocock/skills",
                ref: null,
                commit: COMMIT,
                skills: [{ name: "grill-me", outcome: "installed" as const }],
              };
            }),
        });

        registry.mount(environmentSkillsAtom("work"));
        registry.mount(skillSourceAtom("work"));
        expect(
          AsyncResult.getOrThrow(yield* settled(registry, environmentSkillsAtom("work"))),
        ).toEqual([]);

        registry.set(skillSourceAtom("work"), "mattpocock/skills");
        registry.set(installSkillsAtom("work"), {
          source: "mattpocock/skills",
          skills: ["grill-me"],
        });

        expect(
          AsyncResult.getOrThrow(yield* settled(registry, installSkillsAtom("work"))),
        ).toMatchObject({ status: "installed", commit: COMMIT });
        expect(asked).toEqual([
          { environment: "work", source: "mattpocock/skills", skills: ["grill-me"] },
        ]);
        expect(registry.get(skillSourceAtom("work"))).toBe("");
        expect(
          AsyncResult.getOrThrow(yield* settled(registry, environmentSkillsAtom("work")))[0]
            ?.source,
        ).toEqual({
          repo: "mattpocock/skills",
          path: "skills/grill-me",
          ref: null,
          commit: COMMIT,
        });
      }),
  );

  it.effect("say why an install failed, keeping what was typed", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        installEnvironmentSkills: () =>
          Effect.fail(
            new EnvironmentError({
              message: "GitHub has no repo gone/gone, or the App cannot read it",
            }),
          ),
      });

      registry.mount(skillSourceAtom("work"));
      registry.set(skillSourceAtom("work"), "gone/gone");
      registry.set(installSkillsAtom("work"), { source: "gone/gone" });

      expect(settledFailureOf(yield* settled(registry, installSkillsAtom("work")))).toBe(
        "GitHub has no repo gone/gone, or the App cannot read it",
      );
      expect(registry.get(skillSourceAtom("work"))).toBe("gone/gone");
    }),
  );

  it.effect(
    "update a Skill on the owner's word, replacing edits only when asked, and list the Skills again",
    () =>
      Effect.gen(function* () {
        let updatedAlready = false;
        const asked: unknown[] = [];

        const registry = registryWith({
          listEnvironmentSkills: () =>
            Effect.sync(() => [
              {
                name: "grill-me",
                description: "Interview me.",
                savedAt: 1,
                source: {
                  repo: "mattpocock/skills",
                  path: "skills/grill-me",
                  ref: null,
                  commit: COMMIT,
                },
                modified: !updatedAlready,
                updateAvailable: !updatedAlready,
              },
            ]),
          updateEnvironmentSkills: (input) =>
            Effect.sync(() => {
              asked.push(input);
              updatedAlready = true;

              return { skills: [{ name: "grill-me", outcome: "updated" as const }] };
            }),
        });

        registry.mount(environmentSkillsAtom("work"));
        expect(
          AsyncResult.getOrThrow(yield* settled(registry, environmentSkillsAtom("work"))),
        ).toMatchObject([{ name: "grill-me", modified: true, updateAvailable: true }]);

        registry.mount(updateSkillAtom("work"));
        registry.set(skillUpdateDialogAtom("work"), "grill-me");
        registry.set(updateSkillAtom("work"), { name: "grill-me", overwrite: true });

        expect(AsyncResult.getOrThrow(yield* settled(registry, updateSkillAtom("work")))).toEqual({
          skills: [{ name: "grill-me", outcome: "updated" }],
        });
        yield* settled(registry, environmentSkillsAtom("work"));

        expect(asked).toEqual([{ environment: "work", names: ["grill-me"], overwrite: true }]);
        // The list is asked for again: the marks are gone.
        expect(AsyncResult.getOrThrow(registry.get(environmentSkillsAtom("work")))).toMatchObject([
          { modified: false, updateAvailable: false },
        ]);
        registry.dispose();
      }),
  );

  it.effect("say why an update failed", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        updateEnvironmentSkills: () =>
          Effect.fail(new EnvironmentError({ message: "The Environment is gone" })),
      });

      registry.mount(updateSkillAtom("work"));
      registry.set(updateSkillAtom("work"), { name: "grill-me", overwrite: false });

      expect(settledFailureOf(yield* settled(registry, updateSkillAtom("work")))).toBe(
        "The Environment is gone",
      );
    }),
  );

  it.effect("search skills.sh with the query trimmed, and say why a search failed", () =>
    Effect.gen(function* () {
      const asked: string[] = [];

      const registry = registryWith({
        searchSkills: ({ query }) =>
          query === "down"
            ? Effect.fail(new EnvironmentError({ message: "skills.sh did not answer" }))
            : Effect.sync(() => {
                asked.push(query);

                return [
                  {
                    id: "mattpocock/skills/grill-me",
                    source: "mattpocock/skills",
                    skillId: "grill-me",
                    name: "grill-me",
                    installs: 12,
                  },
                ];
              }),
      });

      registry.set(searchSkillsAtom("work"), "  grill ");

      expect(
        AsyncResult.getOrThrow(yield* settled(registry, searchSkillsAtom("work")))[0]?.source,
      ).toBe("mattpocock/skills");
      expect(asked).toEqual(["grill"]);

      registry.set(searchSkillsAtom("work"), "down");

      expect(settledFailureOf(yield* settled(registry, searchSkillsAtom("work")))).toBe(
        "skills.sh did not answer",
      );
    }),
  );
});
