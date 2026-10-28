// The Session's Environments over a fake Registry: what they read, and what follows a change (the handover to the
// Session's own Workspace, and the Builds' upkeep).
// @effect-diagnostics asyncFunction:off
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import type { AgentChange } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { SecretBuildMark } from "../registry/secret-changes.ts";
import { unusedLifecycle } from "./environments.fixture.ts";
import { type EnvironmentsRegistry, sessionEnvironments } from "./environments.ts";
import { workspacePlacement } from "./workspace.ts";

const DEFAULT = { id: "default", name: "Default", repos: [], createdAt: 0 };
const OTHER = { id: "0000abcd", name: "Other", repos: [], createdAt: 0 };
const EVERY_SCOPE = { id: "*", name: "Global" };
const DEFAULT_SCOPE = { id: "default", name: "Default" };

/** The scopes the fake Registry names in an answer, by id. */
const SCOPES = new Map([
  ["*", EVERY_SCOPE],
  ["default", DEFAULT_SCOPE],
]);

/** The Skills the fake Registry keeps, by scope. */
const SKILLS_KEPT = new Map([
  ["default", [{ name: "release", description: "Cut a release.", savedAt: 9 }]],
  ["*", [{ name: "shared", description: "Shared by all.", savedAt: 5 }]],
]);

const CHANGE: AgentChange = {
  id: 7,
  scope: "default",
  at: 1,
  actor: "agent",
  session: "s-1",
  conversation: 1,
  tool: "environment_variable_set",
  reason: "r",
  field: "variables.A",
  before: null,
  after: "1",
  reverts: null,
  revertedBy: null,
};

/** What the fake Registry answers a mark with. */
type MarkAnswers = { mark: SecretBuildMark };

/** The variables kept Global in the fake Registry. */
const EVERY = { SHARED: "all" };

/**
 * What the Workspace of the Session's Environment is handed: its own `A`, and the variables kept Global.
 */
const MERGED = { variables: { A: "1", ...EVERY } };

/** The scopes the fake Registry names, by id. */
const scopes = new Map([
  ["default", DEFAULT],
  ["*", EVERY_SCOPE],
]);

const open = (
  answer: Effect.Success<
    ReturnType<EnvironmentsRegistry["changeEnvironment"]>
  >["status"] = "changed",
  everyAnswer: Effect.Success<
    ReturnType<EnvironmentsRegistry["changeGlobal"]>
  >["status"] = "changed",
  // Whether the Session's Environment has a variable of its own by the name that changed at Global.
  overridesHere = false,
  // Whether the Registry fails to say what the Session's Workspace is handed.
  overridesUnreadable = false,
) => {
  const handedOver: Array<{ object: string; overrides: Schema.Json }> = [];
  const skillSetsHanded: Array<{ object: string; hash: string }> = [];
  const skillsAsked: unknown[] = [];
  const upkept: string[] = [];
  const sparesKept: string[] = [];
  const asked: unknown[] = [];
  const everyAsked: unknown[] = [];
  const markAsked: unknown[] = [];

  // The mark the fake Registry answers.
  const answers: MarkAnswers = {
    mark: {
      status: "changed",
      environment: { id: "default", name: "Default" },
      change: { ...CHANGE, field: "secrets.API_KEY.build", before: true, after: false },
    },
  };

  // SAFETY: the calls these tests make are answered; the rest are never reached.
  const registry = {
    listEnvironments: () => Effect.succeed([DEFAULT, OTHER]),
    listBuilds: () =>
      Effect.succeed([{ environment: "default", build: { status: "ready", at: 5 } as const }]),
    getEnvironment: ({ id }: { readonly id: string }) =>
      Effect.succeed(
        Arr.findFirst([DEFAULT, OTHER], (each) => each.id === id).pipe(Option.getOrNull),
      ),
    getEnvironmentSettings: ({ environment }: { readonly environment: string }) =>
      Effect.succeed(
        environment === "default" || environment === "0000abcd"
          ? { settings: DEFAULT_CONTAINER_SETTINGS, overrides: {} }
          : null,
      ),
    getGlobalSettings: () =>
      Effect.succeed({ settings: { variables: EVERY }, overrides: { variables: EVERY } }),
    workspaceOverrides: ({ environment }: { readonly environment: string }) =>
      overridesUnreadable
        ? Effect.die("Registry is down")
        : Effect.succeed(environment === "default" ? MERGED : null),
    changeGlobal: (input: Parameters<EnvironmentsRegistry["changeGlobal"]>[0]) =>
      Effect.sync(() => {
        everyAsked.push(input);

        switch (everyAnswer) {
          case "changed":
            return {
              status: "changed" as const,
              change: { ...CHANGE, scope: "*", field: "variables.SHARED" },
              variables: EVERY,
              overriddenIn: overridesHere ? [{ id: "default", name: "Default" }] : [],
              newBuilds: [{ id: "0000abcd", name: "Other" }],
              own: input.environment === undefined ? undefined : !overridesHere,
            };
          case "unchanged":
            return { status: "unchanged" as const, value: "all" };
          case "rejected":
            return { status: "rejected" as const, message: "no" };
        }
      }),
    listEnvironmentSecrets: () =>
      Effect.succeed([
        { environment: "default", name: "API_KEY", build: true, updatedAt: 0 },
        { environment: null, name: "API_KEY", build: false, updatedAt: 0 },
        { environment: null, name: "NPM_TOKEN", build: false, updatedAt: 0 },
        { environment: "0000abcd", name: "OTHER_KEY", build: false, updatedAt: 0 },
      ]),
    getWorkspace: ({ id }: { readonly id: string }) =>
      Effect.succeed({
        id,
        environment: "default",
        branch: "b",
        base: null,
        repos: [],
        directory: "/workspace",
        createdAt: 0,
      }),
    listSkills: ({ environment }: { readonly environment: string }) =>
      Effect.succeed(SKILLS_KEPT.get(environment) ?? []),
    workspaceSkillSet: ({ environment }: { readonly environment: string }) =>
      Effect.succeed({ hash: `set-of-${environment}`, files: {} }),
    agentSaveSkill: (input: Parameters<EnvironmentsRegistry["agentSaveSkill"]>[0]) =>
      Effect.sync(() => {
        skillsAsked.push(input);

        return {
          status: "saved" as const,
          environment: SCOPES.get(input.environment) ?? OTHER,
          change: { ...CHANGE, field: "skills.release", tool: "environment_skill_save" },
          skill: {
            name: "release",
            description: "Cut a release.",
            files: {},
            source: null,
            modified: false,
            folderHash: null,
            updateAvailable: false,
            savedAt: 1,
          },
          inherited: false,
          // The Session's Environment keeps its own Skill of the name, which hides one kept Global.
          overriddenIn:
            input.environment === "*" && overridesHere ? [{ id: "default", name: "Default" }] : [],
        };
      }),
    agentPreviewSkill: (input: Parameters<EnvironmentsRegistry["agentPreviewSkill"]>[0]) =>
      Effect.sync(() => {
        skillsAsked.push(input);

        return {
          status: "ready" as const,
          environment: EVERY_SCOPE,
          name: input.folder,
          description: "Cut a release.",
          current: null,
        };
      }),
    agentRemoveSkill: (input: Parameters<EnvironmentsRegistry["agentRemoveSkill"]>[0]) =>
      Effect.sync(() => {
        skillsAsked.push(input);

        return input.name === "release"
          ? {
              status: "removed" as const,
              environment: input.environment === "*" ? EVERY_SCOPE : DEFAULT_SCOPE,
              change: { ...CHANGE, field: "skills.release", after: null },
              inherited: false,
              overriddenIn:
                input.environment === "*" && overridesHere
                  ? [{ id: "default", name: "Default" }]
                  : [],
            }
          : { status: "absent" as const, environment: DEFAULT_SCOPE };
      }),
    agentInstallSkills: (input: Parameters<EnvironmentsRegistry["agentInstallSkills"]>[0]) =>
      Effect.sync(() => {
        skillsAsked.push(input);

        return input.environment === "ghost"
          ? ({ status: "missing" } as const)
          : ({
              status: "installed" as const,
              environment: scopes.get(input.environment) ?? OTHER,
              repo: "mattpocock/skills",
              ref: null,
              commit: "c0ffee0000000000000000000000000000000001",
              results: [
                {
                  name: "grill-me",
                  path: "skills/grill-me",
                  outcome: "installed" as const,
                  change: {
                    ...CHANGE,
                    field: "skills.grill-me",
                    tool: "environment_skill_install",
                  },
                  overriddenIn:
                    input.environment === "*" && overridesHere
                      ? [{ id: "default", name: "Default" }]
                      : [],
                },
              ],
            } as const);
      }),
    agentUpdateSkills: (input: Parameters<EnvironmentsRegistry["agentUpdateSkills"]>[0]) =>
      Effect.sync(() => {
        skillsAsked.push(input);

        const scope = input.environment === "*" ? EVERY_SCOPE : DEFAULT_SCOPE;

        if (input.environment === "ghost") return { status: "missing" as const };

        if (input.names?.length === 0) return { status: "nothing" as const, environment: scope };

        const from = { repo: "o/skills", path: "skills/grill-me", ref: null, commit: "aaa" };

        return {
          status: "done" as const,
          environment: scope,
          results:
            input.names?.[0] === "same"
              ? [{ name: "same", outcome: "unchanged" as const, message: "its folder is the same" }]
              : [
                  {
                    name: "grill-me",
                    outcome: "updated" as const,
                    from,
                    to: { ...from, commit: "bbb" },
                    overwrote: false,
                    change: {
                      ...CHANGE,
                      field: "skills.grill-me",
                      tool: "environment_skill_update",
                    },
                  },
                ],
        };
      }),
    previewSkillUpdates: (input: Parameters<EnvironmentsRegistry["previewSkillUpdates"]>[0]) =>
      Effect.sync(() => {
        skillsAsked.push(input);

        return { status: "nothing" as const, environment: EVERY_SCOPE };
      }),
    agentPreviewSkillInstall: (
      input: Parameters<EnvironmentsRegistry["agentPreviewSkillInstall"]>[0],
    ) =>
      Effect.sync(() => {
        skillsAsked.push(input);

        return input.environment === "ghost"
          ? ({ status: "missing" } as const)
          : ({
              status: "previewed" as const,
              environment: input.environment === "*" ? EVERY_SCOPE : DEFAULT,
              repo: "mattpocock/skills",
              ref: null,
              commit: "c0ffee0000000000000000000000000000000001",
              skills: [
                {
                  name: "grill-me",
                  path: "skills/grill-me",
                  description: "Interview me.",
                  files: { "SKILL.md": "---\nname: grill-me\n---\n" },
                  unchanged: false,
                  current: null,
                },
              ],
              rejected: [],
            } as const);
      }),
    agentMarkSecretBuild: (input: Parameters<EnvironmentsRegistry["agentMarkSecretBuild"]>[0]) =>
      Effect.sync(() => {
        markAsked.push(input);

        return answers.mark;
      }),
    changeEnvironment: (input: Parameters<EnvironmentsRegistry["changeEnvironment"]>[0]) =>
      Effect.sync(() => {
        asked.push(input);

        const environment = input.environment === "default" ? DEFAULT : OTHER;

        switch (answer) {
          case "changed":
            return {
              status: "changed" as const,
              environment,
              change: CHANGE,
              state: { settings: DEFAULT_CONTAINER_SETTINGS, overrides: { variables: { A: "1" } } },
              newBuild: true,
            };
          case "unchanged":
            return { status: "unchanged" as const, environment, value: null };
          case "rejected":
            return { status: "rejected" as const, message: "no" };
          case "missing":
            return { status: "missing" as const };
        }
      }),
  } as EnvironmentsRegistry;

  const environments = sessionEnvironments({
    registry,
    session: "s-1",
    placement: () => Promise.resolve(workspacePlacement("0a1b2c3d", "/workspace")),
    handOver: (object, overrides) => {
      handedOver.push({ object, overrides });

      return Promise.resolve({ ok: true });
    },
    handSkills: (object, set) => {
      skillSetsHanded.push({ object, hash: set.hash });

      return Promise.resolve({ ok: true });
    },
    builds: {
      of: (environment) =>
        Effect.sync(() => {
          upkept.push(environment);
        }),
    },
    spares: {
      of: (environment) =>
        Effect.sync(() => {
          sparesKept.push(environment);
        }),
    },
    lifecycle: unusedLifecycle,
  });

  return {
    environments,
    handedOver,
    skillSetsHanded,
    skillsAsked,
    upkept,
    sparesKept,
    asked,
    everyAsked,
    markAsked,
    setMark: (next: SecretBuildMark) => {
      answers.mark = next;
    },
  };
};

const author = { conversation: 1, tool: "environment_variable_set", reason: "r" };
const change = { field: "variables.A", value: "1" };

describe("the Session's Environments", () => {
  it("are its Workspace's Environment, and list each one with its Build", async () => {
    const { environments } = open();

    expect(await Effect.runPromise(environments.current)).toBe("default");
    expect(await Effect.runPromise(environments.list)).toEqual([
      { id: "default", name: "Default", repos: [], build: { status: "ready", at: 5 } },
      { id: "0000abcd", name: "Other", repos: [], build: { status: "none" } },
    ]);
  });

  it("show an Environment's own Secrets, then those kept Global that it does not override", async () => {
    const { environments } = open();
    const details = await Effect.runPromise(environments.get("default"));

    expect(details?.secrets).toEqual([
      { name: "API_KEY", scope: "environment", build: true },
      { name: "NPM_TOKEN", scope: "every", build: false },
    ]);
    expect(await Effect.runPromise(environments.get("ghost"))).toBeNull();
  });

  it("list an Environment's own Skills in its details", async () => {
    const { environments } = open();

    expect((await Effect.runPromise(environments.get("default")))?.skills).toEqual([
      { name: "release", description: "Cut a release.", savedAt: 9 },
    ]);
  });

  it("hand the Session's own Workspace its Environment's Skill set after a save, and run no Build's upkeep", async () => {
    const { environments, skillSetsHanded, skillsAsked, upkept } = open();
    const files = { "SKILL.md": "---\nname: release\n---\n" };

    const saved = await Effect.runPromise(
      environments.saveSkill({ environment: "default", folder: "release", files, author }),
    );

    expect(skillsAsked).toEqual([
      { environment: "default", folder: "release", files, author: { session: "s-1", ...author } },
    ]);
    expect(saved).toMatchObject({ status: "saved", name: "release", handed: true });
    expect(skillSetsHanded).toEqual([{ object: "ws:0a1b2c3d", hash: "set-of-default" }]);
    expect(upkept).toEqual([]);
  });

  it("leave the Session's Workspace as it is after a Skill saved for another Environment", async () => {
    const { environments, skillSetsHanded } = open();

    const saved = await Effect.runPromise(
      environments.saveSkill({ environment: "0000abcd", folder: "release", files: {}, author }),
    );

    expect(saved).toMatchObject({ status: "saved", handed: false });
    expect(skillSetsHanded).toEqual([]);
  });

  it("list the Skills kept Global in an Environment's details and in what is kept Global", async () => {
    const { environments } = open();
    const shared = [{ name: "shared", description: "Shared by all.", savedAt: 5 }];

    expect((await Effect.runPromise(environments.get("default")))?.globalSkills).toEqual(shared);
    expect((await Effect.runPromise(environments.every)).skills).toEqual(shared);
  });

  it("hand the Session's own Workspace its Environment's Skill set after a Skill saved at Global", async () => {
    const { environments, skillSetsHanded, skillsAsked, upkept } = open();
    const files = { "SKILL.md": "---\nname: release\n---\n" };
    const expected = { savedAt: null };

    const saved = await Effect.runPromise(
      environments.saveSkill({ environment: "*", folder: "release", files, expected, author }),
    );

    expect(skillsAsked).toEqual([
      {
        environment: "*",
        folder: "release",
        files,
        expected,
        author: { session: "s-1", ...author },
      },
    ]);
    expect(saved).toMatchObject({
      status: "saved",
      environment: { id: "*" },
      overriddenIn: [],
      handed: true,
    });
    // The Session's Environment is the one handed its set: the Skill reaches it through the layers.
    expect(skillSetsHanded).toEqual([{ object: "ws:0a1b2c3d", hash: "set-of-default" }]);
    expect(upkept).toEqual([]);
  });

  it("hand the Session's own Workspace the Skill set after an install, asking the Registry to fetch as the App", async () => {
    const { environments, skillSetsHanded, skillsAsked, upkept } = open();
    const input = { environment: "default", source: "mattpocock/skills@grill-me", author };

    const installed = await Effect.runPromise(environments.installSkills(input));

    // The Session passes the source on; it holds no token and fetches nothing.
    expect(skillsAsked).toEqual([
      {
        environment: "default",
        source: "mattpocock/skills@grill-me",
        author: { session: "s-1", ...author },
      },
    ]);
    expect(installed).toMatchObject({
      status: "installed",
      environment: { id: "default", name: "Default" },
      commit: "c0ffee0000000000000000000000000000000001",
      results: [{ name: "grill-me", outcome: "installed" }],
      handed: true,
    });
    expect(skillSetsHanded).toEqual([{ object: "ws:0a1b2c3d", hash: "set-of-default" }]);
    expect(upkept).toEqual([]);
  });

  it("hand the Session's own Workspace the Skill set after an update, asking the Registry to fetch as the App", async () => {
    const { environments, skillSetsHanded, skillsAsked, upkept } = open();

    const updated = await Effect.runPromise(
      environments.updateSkills({
        environment: "default",
        names: ["grill-me"],
        overwrite: true,
        author,
      }),
    );

    // The Session passes the names on; it holds no token and fetches nothing.
    expect(skillsAsked).toEqual([
      {
        environment: "default",
        names: ["grill-me"],
        overwrite: true,
        author: { session: "s-1", ...author },
      },
    ]);
    expect(updated).toMatchObject({
      status: "done",
      environment: { id: "default" },
      results: [{ name: "grill-me", outcome: "updated", overwrote: false }],
      handed: true,
    });
    expect(skillSetsHanded).toEqual([{ object: "ws:0a1b2c3d", hash: "set-of-default" }]);
    expect(upkept).toEqual([]);
  });

  it("hand nothing after an update that moved no Skill, or that found none to update", async () => {
    const { environments, skillSetsHanded } = open();

    const same = await Effect.runPromise(
      environments.updateSkills({
        environment: "default",
        names: ["same"],
        overwrite: false,
        author,
      }),
    );

    const nothing = await Effect.runPromise(
      environments.updateSkills({ environment: "default", names: [], overwrite: false, author }),
    );

    const missing = await Effect.runPromise(
      environments.updateSkills({ environment: "ghost", overwrite: false, author }),
    );

    expect(same).toMatchObject({ status: "done", handed: false });
    expect(nothing).toMatchObject({ status: "nothing" });
    expect(missing).toEqual({ status: "missing" });
    expect(skillSetsHanded).toEqual([]);
  });

  it("hand nothing when the Session's Environment keeps its own Skill of the name kept Global", async () => {
    const { environments, skillSetsHanded } = open("changed", "changed", true);

    const saved = await Effect.runPromise(
      environments.saveSkill({ environment: "*", folder: "release", files: {}, author }),
    );

    const removed = await Effect.runPromise(
      environments.removeSkill({ environment: "*", name: "release", author }),
    );

    expect(saved).toMatchObject({
      status: "saved",
      overriddenIn: [{ id: "default", name: "Default" }],
      handed: false,
    });
    expect(removed).toMatchObject({ status: "removed", handed: false });
    expect(skillSetsHanded).toEqual([]);
  });

  it("hand the Session's own Workspace its Environment's Skill set after a Skill removed at Global", async () => {
    const { environments, skillSetsHanded, skillsAsked } = open();
    const expected = { savedAt: 5 };

    const removed = await Effect.runPromise(
      environments.removeSkill({ environment: "*", name: "release", expected, author }),
    );

    expect(skillsAsked).toEqual([
      { environment: "*", name: "release", expected, author: { session: "s-1", ...author } },
    ]);
    expect(removed).toMatchObject({ status: "removed", handed: true, inherited: false });
    expect(skillSetsHanded).toEqual([{ object: "ws:0a1b2c3d", hash: "set-of-default" }]);
  });

  it("check a Skill at Global as the Registry does, saving nothing", async () => {
    const { environments, skillsAsked } = open();
    const files = { "SKILL.md": "x" };

    const checked = await Effect.runPromise(
      environments.previewSkill({ environment: "*", folder: "release", files }),
    );

    expect(checked).toMatchObject({ status: "ready", name: "release", current: null });
    expect(skillsAsked).toEqual([{ environment: "*", folder: "release", files }]);
  });

  it("hand the Session's own Workspace the set after an install at Global, unless its own Skills hide all of them, and pass the Approval's pin on", async () => {
    const pin = {
      commit: "c0ffee0000000000000000000000000000000001",
      skills: [{ name: "grill-me", path: "skills/grill-me", digest: "d1", savedAt: null }],
    };

    const everywhere = open();

    const installed = await Effect.runPromise(
      everywhere.environments.installSkills({
        environment: "*",
        source: "mattpocock/skills",
        skills: ["grill-me"],
        author: { ...author, approved: true },
        pin,
      }),
    );

    expect(everywhere.skillsAsked).toEqual([
      {
        environment: "*",
        source: "mattpocock/skills",
        skills: ["grill-me"],
        author: { session: "s-1", ...author, approved: true },
        pin,
      },
    ]);
    expect(installed).toMatchObject({
      status: "installed",
      environment: EVERY_SCOPE,
      handed: true,
    });
    expect(everywhere.skillSetsHanded).toEqual([{ object: "ws:0a1b2c3d", hash: "set-of-default" }]);

    // The Session's Environment keeps its own Skill of the name: the Skill does not reach it.
    const hidden = open("changed", "changed", true);

    const kept = await Effect.runPromise(
      hidden.environments.installSkills({ environment: "*", source: "o/r", author }),
    );

    expect(kept).toMatchObject({ status: "installed", handed: false });
    expect(hidden.skillSetsHanded).toEqual([]);
  });

  it("preview an install at Global through the Registry, naming the scope", async () => {
    const { environments, skillsAsked } = open();

    const previewed = await Effect.runPromise(
      environments.previewInstall({ environment: "*", source: "mattpocock/skills" }),
    );

    expect(skillsAsked).toEqual([{ environment: "*", source: "mattpocock/skills" }]);
    expect(previewed).toMatchObject({
      status: "previewed",
      environment: EVERY_SCOPE,
      skills: [{ name: "grill-me", unchanged: false, current: null }],
    });
    expect(
      await Effect.runPromise(environments.previewInstall({ environment: "ghost", source: "o/r" })),
    ).toEqual({ status: "missing" });
  });

  it("leave the Session's Workspace as it is after an install for another Environment, or for none", async () => {
    const { environments, skillSetsHanded } = open();

    const other = await Effect.runPromise(
      environments.installSkills({ environment: "0000abcd", source: "o/r", author }),
    );

    const missing = await Effect.runPromise(
      environments.installSkills({ environment: "ghost", source: "o/r", author }),
    );

    expect(other).toMatchObject({ status: "installed", handed: false });
    expect(missing).toEqual({ status: "missing" });
    expect(skillSetsHanded).toEqual([]);
  });

  it("hand nothing after removing a Skill the Environment does not keep", async () => {
    const { environments, skillSetsHanded } = open();

    const removed = await Effect.runPromise(
      environments.removeSkill({ environment: "default", name: "nope", author }),
    );

    expect(removed).toEqual({ status: "absent", environment: { id: "default", name: "Default" } });
    expect(skillSetsHanded).toEqual([]);
  });

  it("carry the variables kept Global in an Environment's details", async () => {
    const { environments } = open();

    expect((await Effect.runPromise(environments.get("default")))?.globalVariables).toEqual(EVERY);
  });

  it("show what is kept Global: its variables, and its Secrets by name", async () => {
    const { environments } = open();

    expect(await Effect.runPromise(environments.every)).toEqual({
      variables: EVERY,
      secrets: [
        { name: "API_KEY", scope: "every", build: false },
        { name: "NPM_TOKEN", scope: "every", build: false },
      ],
      skills: [{ name: "shared", description: "Shared by all.", savedAt: 5 }],
    });
  });

  it("hand a change of the Session's own Environment to its Workspace, and keep its Build current", async () => {
    const { environments, handedOver, upkept, asked } = open();

    const applied = await Effect.runPromise(
      environments.change({ environment: "default", change, author }),
    );

    expect(asked).toEqual([
      { environment: "default", change, author: { session: "s-1", ...author } },
    ]);
    expect(applied).toEqual({
      status: "changed",
      environment: { id: "default", name: "Default" },
      change: CHANGE,
      newBuild: true,
    });
    // What the Registry says its Workspaces are handed, with the variables kept Global merged in, not
    // the Environment's own overrides alone.
    expect(handedOver).toEqual([{ object: "ws:0a1b2c3d", overrides: MERGED }]);
    expect(upkept).toEqual(["default"]);
  });

  it("hand a change of a variable kept Global to the Session's Workspace, and keep each Environment's Build current", async () => {
    const { environments, handedOver, upkept, everyAsked, asked } = open();

    const applied = await Effect.runPromise(
      environments.change({ environment: "*", change, author }),
    );

    expect(asked).toEqual([]);
    expect(everyAsked).toEqual([
      { change, author: { session: "s-1", ...author }, environment: "default" },
    ]);
    expect(applied).toEqual({
      status: "changed",
      environment: { id: "*", name: "Global" },
      change: { ...CHANGE, scope: "*", field: "variables.SHARED" },
      newBuild: true,
      every: {
        overriddenIn: [],
        newBuilds: [{ id: "0000abcd", name: "Other" }],
        own: true,
      },
    });
    expect(handedOver).toEqual([{ object: "ws:0a1b2c3d", overrides: MERGED }]);
    expect(upkept).toEqual(["default", "0000abcd"]);
  });

  it("only log a failure to read what the Session's Workspace is handed after a change that was recorded", async () => {
    for (const environment of ["default", "*"]) {
      const { environments, handedOver, upkept } = open("changed", "changed", false, true);

      const applied = await Effect.runPromise(environments.change({ environment, change, author }));

      expect(applied).toMatchObject({ status: "changed" });
      expect(handedOver).toEqual([]);
      expect(upkept).toEqual(environment === "*" ? ["default", "0000abcd"] : ["default"]);
    }
  });

  it("leave the Session's Workspace as it is for a variable at Global that its Environment overrides", async () => {
    const { environments, handedOver, upkept } = open("changed", "changed", true);

    const applied = await Effect.runPromise(
      environments.change({ environment: "*", change, author }),
    );

    expect(applied).toMatchObject({
      status: "changed",
      every: { overriddenIn: [{ id: "default", name: "Default" }], own: false },
    });
    expect(handedOver).toEqual([]);
    expect(upkept).toEqual(["default", "0000abcd"]);
  });

  it("do nothing after a change at Global that changed nothing or was refused", async () => {
    for (const status of ["unchanged", "rejected"] as const) {
      const { environments, handedOver, upkept } = open("changed", status);

      expect(
        (await Effect.runPromise(environments.change({ environment: "*", change, author }))).status,
      ).toBe(status);
      expect(handedOver).toEqual([]);
      expect(upkept).toEqual([]);
    }
  });

  it("keep the Environment's spare Workspace current after a change of its Spare Workspace setting only", async () => {
    const { environments, sparesKept, upkept } = open();

    await Effect.runPromise(environments.change({ environment: "default", change, author }));
    expect(sparesKept).toEqual([]);

    await Effect.runPromise(
      environments.change({
        environment: "0000abcd",
        change: { field: "spareWorkspace", value: false },
        author: { ...author, tool: "environment_spare_workspace_set" },
      }),
    );
    expect(sparesKept).toEqual(["0000abcd"]);
    expect(upkept).toEqual(["default", "0000abcd"]);
  });

  it("leave the Session's Workspace as it is for a change of another Environment", async () => {
    const { environments, handedOver, upkept } = open();

    await Effect.runPromise(environments.change({ environment: "0000abcd", change, author }));

    expect(handedOver).toEqual([]);
    expect(upkept).toEqual(["0000abcd"]);
  });

  it("mark a kept Secret for the Build, with the Session as the author, and keep the Environment's Build current", async () => {
    const { environments, upkept, markAsked } = open();

    const marked = await Effect.runPromise(
      environments.markSecret({
        environment: "default",
        name: "API_KEY",
        build: false,
        author: { conversation: 1, tool: "environment_secret_build", reason: "r" },
      }),
    );

    expect(marked).toMatchObject({ status: "changed", change: { field: "secrets.API_KEY.build" } });
    expect(markAsked).toEqual([
      {
        environment: "default",
        name: "API_KEY",
        build: false,
        author: { session: "s-1", conversation: 1, tool: "environment_secret_build", reason: "r" },
      },
    ]);
    expect(upkept).toEqual(["default"]);
  });

  it("keep each Environment's Build current after the mark of a Secret kept Global", async () => {
    const { environments, upkept } = open();

    await Effect.runPromise(
      environments.markSecret({
        environment: "*",
        name: "NPM_TOKEN",
        build: true,
        author: { conversation: 1, tool: "environment_secret_build", reason: "r" },
      }),
    );

    expect(upkept).toEqual(["default", "0000abcd"]);
  });

  it("run no upkeep after a mark that changed nothing", async () => {
    const { environments, upkept, setMark } = open();

    setMark({
      status: "unchanged",
      environment: { id: "default", name: "Default" },
      build: true,
    });

    const marked = await Effect.runPromise(
      environments.markSecret({
        environment: "default",
        name: "API_KEY",
        build: true,
        author: { conversation: 1, tool: "environment_secret_build", reason: "r" },
      }),
    );

    expect(marked.status).toBe("unchanged");
    expect(upkept).toEqual([]);
  });

  it("do nothing after a change that changed nothing or was refused", async () => {
    for (const status of ["unchanged", "rejected", "missing"] as const) {
      const { environments, handedOver, upkept } = open(status);

      expect(
        (await Effect.runPromise(environments.change({ environment: "default", change, author })))
          .status,
      ).toBe(status);
      expect(handedOver).toEqual([]);
      expect(upkept).toEqual([]);
    }
  });
});
