// @effect-diagnostics preferEffectArray:off newSchemaClass:off -- in-memory fakes of the Registry over native arrays.

import {
  type AgentChange,
  type DirectorySkill,
  EnvironmentError,
  type EnvironmentRecord,
  SkillDirectoryError,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "@effect/vitest";
import { revertAgentChangeAtom } from "./environments-state.ts";
import { EVERY_ENVIRONMENT } from "./environments.ts";
import { settledFailureOf } from "./registry.ts";
import { type RegistryHandlers, registryWith, settled } from "./registry.testing.ts";
import { searchAtom } from "./router.ts";
import {
  anySkillInstalledAtom,
  environmentSkillsAtom,
  installSkillsAtom,
  installToTargetAtom,
  keptSkillFilesAtom,
  removeSkillAtom,
  searchSkillsAtom,
  skillChangeFilesAtom,
  skillDirectoryPageAtom,
  skillDirectoryPageKey,
  skillDirectoryPagesAtom,
  skillDirectorySearchAtom,
  skillChangeKey,
  skillKey,
  skillsTabAtom,
  skillSourceAtom,
  skillUpdateDialogAtom,
  updateSkillAtom,
} from "./skills-state.ts";

const ENVIRONMENTS: ReadonlyArray<EnvironmentRecord> = [
  { id: "default", name: "Default", repos: [], createdAt: 1 },
  { id: "work", name: "Work", repos: [], createdAt: 1 },
];

describe("the Skills page's tab", () => {
  it("is the one the query names, without asking the Registry", () => {
    // No handler: asking for the Skills would fail the test.
    const registry = registryWith({});

    registry.set(searchAtom, "?tab=hot");
    expect(registry.get(skillsTabAtom)).toBe("hot");

    registry.set(searchAtom, "?tab=installed&environment=work");
    expect(registry.get(skillsTabAtom)).toBe("installed");
  });

  it.effect("is Installed by default when any Skill is installed, in any scope", () =>
    Effect.gen(function* () {
      const asked: string[] = [];

      const registry = registryWith({
        listEnvironments: () => Effect.succeed(ENVIRONMENTS),
        listEnvironmentSkills: ({ environment }) =>
          Effect.sync(() => {
            asked.push(environment);

            return environment === "work"
              ? [{ name: "notes", description: "Notes.", savedAt: 1 }]
              : [];
          }),
      });

      registry.mount(skillsTabAtom);

      yield* settled(registry, anySkillInstalledAtom);

      expect(registry.get(skillsTabAtom)).toBe("installed");
      expect(asked.toSorted()).toEqual(["*", "default", "work"]);
      registry.dispose();
    }),
  );

  it("has no tab while it is being asked, so that the page does not flash the wrong one", () => {
    const registry = registryWith({ listEnvironments: () => Effect.never });

    registry.mount(skillsTabAtom);

    expect(registry.get(skillsTabAtom)).toBeNull();
    registry.dispose();
  });

  it.effect("is All time by default when no Skill is installed", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        listEnvironments: () => Effect.succeed(ENVIRONMENTS),
        listEnvironmentSkills: () => Effect.succeed([]),
      });

      registry.mount(skillsTabAtom);
      yield* settled(registry, anySkillInstalledAtom);

      expect(registry.get(skillsTabAtom)).toBe("all-time");
      registry.dispose();
    }),
  );

  it.effect("is Installed by default when the Registry cannot say, where the page says why", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        listEnvironments: () => Effect.die("the Registry is down"),
      });

      registry.mount(skillsTabAtom);
      yield* settled(registry, anySkillInstalledAtom);

      expect(registry.get(skillsTabAtom)).toBe("installed");
      registry.dispose();
    }),
  );

  it.effect("does not change once chosen, when the owner installs from All time", () =>
    Effect.gen(function* () {
      let kept = false;

      const registry = registryWith({
        listEnvironments: () => Effect.succeed(ENVIRONMENTS),
        listEnvironmentSkills: () =>
          Effect.sync(() =>
            kept ? [{ name: "grill-me", description: "Interview.", savedAt: 1 }] : [],
          ),
        installEnvironmentSkills: ({ skills }) =>
          Effect.sync(() => {
            kept = true;

            return {
              status: "installed" as const,
              repo: "mattpocock/skills",
              ref: null,
              commit: "c0ffee0",
              skills: (skills ?? []).map((name) => ({ name, outcome: "installed" as const })),
            };
          }),
      });

      registry.mount(skillsTabAtom);
      yield* settled(registry, anySkillInstalledAtom);
      expect(registry.get(skillsTabAtom)).toBe("all-time");

      registry.mount(installToTargetAtom);
      registry.set(installToTargetAtom, {
        target: "*",
        source: "mattpocock/skills",
        skills: ["grill-me"],
      });
      yield* settled(registry, installToTargetAtom);

      expect(kept).toBe(true);
      expect(registry.get(skillsTabAtom)).toBe("all-time");
      registry.dispose();
    }),
  );
});

/** The Skill directory as a fake Registry answers it: an all-time list of two pages, and a Skill installed once it is. */
const directory = () => {
  const installs: Array<{ environment: string; source: string; skills: ReadonlyArray<string> }> =
    [];

  const asked: string[] = [];

  const skills = (page: number): ReadonlyArray<DirectorySkill> =>
    page === 0
      ? [
          {
            source: "mattpocock/skills",
            skillId: "grill-me",
            name: "grill-me",
            installs: 1_450_000,
          },
          { source: "mattpocock/skills", skillId: "tdd", name: "tdd", installs: 900_000 },
        ].map((row) => {
          const where = installs.filter(
            ({ source, skills: named }) => source === row.source && named.includes(row.skillId),
          );

          return where.length === 0
            ? row
            : {
                ...row,
                installed: {
                  everyEnvironment: where.some(({ environment }) => environment === "*"),
                  environments: where.flatMap(({ environment }) =>
                    environment === "*" ? [] : [environment],
                  ),
                  updateAvailable: false,
                },
              };
        })
      : [{ source: "o/other", skillId: "other", name: "other", installs: 3 }];

  const handlers = {
    listSkillDirectory: ({ view, page }: { view: string; page: number }) =>
      Effect.suspend(() => {
        asked.push(`${view}/${page}`);

        return view === "hot"
          ? Effect.fail(SkillDirectoryError.make({ message: "skills.sh answered 503" }))
          : Effect.succeed({ total: 3, hasMore: page === 0, skills: skills(page) });
      }),
    searchSkillDirectory: ({ query }: { query: string }) =>
      Effect.sync(() => skills(0).filter(({ name }) => name.includes(query))),
    installEnvironmentSkills: ({
      environment,
      source,
      skills: named = [],
    }: {
      environment: string;
      source: string;
      skills?: ReadonlyArray<string> | undefined;
    }) =>
      Effect.sync(() => {
        installs.push({ environment, source, skills: named });

        return {
          status: "installed" as const,
          repo: source,
          ref: null,
          commit: "c0ffee0",
          skills: named.map((name) => ({ name, outcome: "installed" as const })),
        };
      }),
  } satisfies Partial<RegistryHandlers>;

  return { handlers, installs, asked };
};

describe("the Skill directory's lists", () => {
  it.effect("are asked a page at a time, from page 0, and Load more asks the next", () =>
    Effect.gen(function* () {
      const { handlers, asked } = directory();
      const registry = registryWith(handlers);
      const first = skillDirectoryPageAtom(skillDirectoryPageKey("all-time", 0));
      const second = skillDirectoryPageAtom(skillDirectoryPageKey("all-time", 1));

      expect(registry.get(skillDirectoryPagesAtom("all-time"))).toBe(1);

      registry.mount(first);

      const page = AsyncResult.getOrThrow(yield* settled(registry, first));

      expect(page.hasMore).toBe(true);
      expect(page.skills.map(({ skillId }) => skillId)).toEqual(["grill-me", "tdd"]);

      // Load more.
      registry.set(skillDirectoryPagesAtom("all-time"), 2);
      registry.mount(second);

      const more = AsyncResult.getOrThrow(yield* settled(registry, second));

      expect(more.hasMore).toBe(false);
      expect(more.skills.map(({ skillId }) => skillId)).toEqual(["other"]);
      // Another list is another count of pages and other pages.
      expect(registry.get(skillDirectoryPagesAtom("hot"))).toBe(1);
      expect(skillDirectoryPageAtom(skillDirectoryPageKey("all-time", 0))).toBe(first);
      expect(skillDirectoryPageAtom(skillDirectoryPageKey("trending", 0))).not.toBe(first);
      expect(asked).toEqual(["all-time/0", "all-time/1"]);
      registry.dispose();
    }),
  );

  it.effect("say why a list could not load", () =>
    Effect.gen(function* () {
      const registry = registryWith(directory().handlers);
      const hot = skillDirectoryPageAtom(skillDirectoryPageKey("hot", 0));

      registry.mount(hot);

      expect(settledFailureOf(yield* settled(registry, hot))).toBe("skills.sh answered 503");
      registry.dispose();
    }),
  );

  it.effect("are searched by query, each query apart, and say why a search failed", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        ...directory().handlers,
        searchSkillDirectory: ({ query }) =>
          query === "down"
            ? Effect.fail(
                SkillDirectoryError.make({ message: "skills.sh could not be reached: offline" }),
              )
            : Effect.succeed([
                { source: "mattpocock/skills", skillId: "tdd", name: "tdd", installs: 9 },
              ]),
      });

      const found = skillDirectorySearchAtom("tdd");
      const down = skillDirectorySearchAtom("down");

      registry.mount(found);
      registry.mount(down);

      expect(skillDirectorySearchAtom("tdd")).toBe(found);
      expect(AsyncResult.getOrThrow(yield* settled(registry, found))).toHaveLength(1);
      expect(settledFailureOf(yield* settled(registry, down))).toBe(
        "skills.sh could not be reached: offline",
      );
      registry.dispose();
    }),
  );
});

describe("installing from the Skill directory", () => {
  it.effect(
    "sends `*` for every Environment, and the picked Skill only, and the row's badge follows",
    () =>
      Effect.gen(function* () {
        const { handlers, installs } = directory();
        const registry = registryWith(handlers);
        const first = skillDirectoryPageAtom(skillDirectoryPageKey("all-time", 0));

        registry.mount(first);
        registry.mount(installToTargetAtom);

        const before = AsyncResult.getOrThrow(yield* settled(registry, first));

        expect(before.skills.every((skill) => skill.installed === undefined)).toBe(true);

        registry.set(installToTargetAtom, {
          target: EVERY_ENVIRONMENT,
          source: "mattpocock/skills",
          skills: ["grill-me"],
        });

        const answer = AsyncResult.getOrThrow(yield* settled(registry, installToTargetAtom));

        expect(answer).toMatchObject({ status: "installed", skills: [{ name: "grill-me" }] });
        // The source holds more Skills; only the picked one is named.
        expect(installs).toEqual([
          { environment: "*", source: "mattpocock/skills", skills: ["grill-me"] },
        ]);

        // The list asks again, so the badge updates.
        const after = AsyncResult.getOrThrow(yield* settled(registry, first));

        expect(after.skills.find(({ skillId }) => skillId === "grill-me")?.installed).toEqual({
          everyEnvironment: true,
          environments: [],
          updateAvailable: false,
        });
        expect(after.skills.find(({ skillId }) => skillId === "tdd")?.installed).toBeUndefined();
        registry.dispose();
      }),
  );

  it.effect("sends the Environment's id for one Environment, and the row says in how many", () =>
    Effect.gen(function* () {
      const { handlers, installs } = directory();
      const registry = registryWith(handlers);
      const first = skillDirectoryPageAtom(skillDirectoryPageKey("all-time", 0));

      registry.mount(first);
      registry.mount(installToTargetAtom);
      yield* settled(registry, first);

      registry.set(installToTargetAtom, {
        target: "work",
        source: "mattpocock/skills",
        skills: ["tdd"],
      });
      yield* settled(registry, installToTargetAtom);

      const after = AsyncResult.getOrThrow(yield* settled(registry, first));

      expect(installs).toEqual([
        { environment: "work", source: "mattpocock/skills", skills: ["tdd"] },
      ]);
      expect(after.skills.find(({ skillId }) => skillId === "tdd")?.installed).toEqual({
        everyEnvironment: false,
        environments: ["work"],
        updateAvailable: false,
      });
      registry.dispose();
    }),
  );

  it.effect("says why an install failed", () =>
    Effect.gen(function* () {
      const registry = registryWith({
        installEnvironmentSkills: () =>
          Effect.fail(new EnvironmentError({ message: 'o/skills has no Skill named "x"' })),
      });

      registry.mount(installToTargetAtom);
      registry.set(installToTargetAtom, { target: "*", source: "o/skills", skills: ["x"] });

      expect(settledFailureOf(yield* settled(registry, installToTargetAtom))).toBe(
        'o/skills has no Skill named "x"',
      );
      registry.dispose();
    }),
  );
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
