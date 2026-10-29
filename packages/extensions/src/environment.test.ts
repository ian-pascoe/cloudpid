// The `environment` extension (docs/architecture/agent-changes.md), over fake Environments: what each tool shows and changes,
// the refusal of values that hold a Secret, and the Run's record of the changes.
// @effect-diagnostics asyncFunction:off schemaSync:off
import {
  compareInstances,
  type ContainerSettings,
  type ContainerSettingsOverrides,
  containerOverridesFrom,
  DEFAULT_CONTAINER_SETTINGS,
  instanceLimitProblem,
  resolveContainerOverrides,
  resolveContainerSettings,
  resolveEnvironmentContainerSettings,
} from "@cloudpid/config";
import { type AgentChange, fieldVariable } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type JsonObject,
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  AgentChangeLog,
  type AppliedChange,
  DeployCredentials,
  type EnvironmentDetails,
  Environments,
  type EnvironmentsService,
  EnvironmentTools,
  type RunChange,
  type SettingChange,
} from "./environment.ts";
import { Approvals } from "./approvals.ts";
import { unusedApprovals } from "./approvals.fixture.ts";
import { unusedLifecycle } from "./environment-lifecycle.fixture.ts";
import { EnvironmentGetOutput, EnvironmentListOutput } from "./environment-outputs.ts";
import { unusedSecretMarks } from "./environment-secret-marks.fixture.ts";
import { unusedSkills } from "./environment-skills.fixture.ts";
import { EnvironmentChangeOutput } from "./outputs.ts";
import { runProgram, runSized } from "./program.fixture.ts";
import { MAX_NESTED_STRUCTURED_OUTPUT_BYTES } from "./result-bounds.ts";
import { Redactions } from "./secrets/redaction.ts";
import { secretEnvName, secretReference } from "./secrets/references.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

/** The variables kept Global at the start of a test. */
const GLOBAL_VARIABLES = { SHARED: "all", NODE_ENV: "prod" };

/** An Environment as the fake keeps it: its Overrides, from which `get` resolves the settings over Global's. */
type Kept = Omit<EnvironmentDetails, "settings" | "global">;

const DEFAULT: Kept = {
  id: "default",
  name: "Default",
  repos: [{ name: "app", url: "https://github.com/o/app.git" }],
  build: { status: "ready", at: Date.UTC(2026, 9, 20) },
  overrides: { variables: { NODE_ENV: "test" } },
  secrets: [
    { name: "API_KEY", scope: "environment", build: true },
    { name: "NPM_TOKEN", scope: "every", build: false },
  ],
  skills: [],
  globalSkills: [],
};

const OTHER: Kept = {
  id: "0000abcd",
  name: "Other",
  repos: [],
  build: {
    status: "failed",
    reason: `${"x".repeat(2_000)}npm ERR! missing script`,
    at: 0,
    lastGoodAt: null,
  },
  overrides: {},
  secrets: [],
  skills: [],
  globalSkills: [],
};

const GLOBAL = { id: "*", name: "Global" };

/** What `environment_get` with id `*` names of the Environment that overrides a field of Global's. */
const GLOBAL_OVERRIDER = { id: "default", name: "Default" };

const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

/** The value a field has in `settings`: null for a variable that is not set. */
const valueOf = (settings: ContainerSettings, field: string): Schema.Json | null => {
  const variable = fieldVariable(field);

  if (variable !== null) return settings.variables[variable] ?? null;

  // SAFETY: the tests name only fields of the settings.
  return settings[field as keyof ContainerSettings];
};

/** The field paths an Environment's Overrides set: a setting's name, or `variables.<NAME>` for each variable. */
const overriddenPaths = (overrides: ContainerSettingsOverrides): string[] => [
  ...Arr.filter(
    Arr.map(Record.toEntries<string, unknown>(overrides), ([key]) => key),
    (key) => key !== "variables",
  ),
  ...Arr.map(Record.keys(overrides.variables ?? {}), (name) => `variables.${name}`),
];

/**
 * Environments over Global's Container settings and each Environment's Overrides, applying each change as the Registry
 * would. Global's settings are `startingGlobal` (the variables kept Global by default) with any change made to them.
 */
const fakeEnvironments = (
  current: string | null = "default",
  startingGlobal: ContainerSettings = {
    ...DEFAULT_CONTAINER_SETTINGS,
    variables: GLOBAL_VARIABLES,
  },
) => {
  const kept = new Map(Arr.map([DEFAULT, OTHER], (each) => [each.id, each] as const));

  /** Global's Container settings. */
  let globalSettings = startingGlobal;

  /** Environment `id` as `get` shows it: its Overrides resolved over Global's settings. */
  const detailsOf = (each: Kept): EnvironmentDetails => ({
    ...each,
    settings: resolveEnvironmentContainerSettings(globalSettings, each.overrides),
    global: globalSettings,
  });

  const changes: Array<{
    environment: string;
    change: SettingChange;
    tool: string;
    reason: string;
  }> = [];

  let next = 1;

  const service: EnvironmentsService = {
    ...unusedLifecycle,
    ...unusedSecretMarks,
    ...unusedSkills,
    current: Effect.succeed(current),
    list: Effect.sync(() => [...kept.values()]),
    get: (id) =>
      Effect.sync(() => {
        const found = kept.get(id);

        return found === undefined ? null : detailsOf(found);
      }),
    global: Effect.sync(() => {
      const overriddenIn: Record<string, Array<{ id: string; name: string }>> = {};

      for (const each of kept.values()) {
        for (const path of overriddenPaths(each.overrides)) {
          (overriddenIn[path] ??= []).push({ id: each.id, name: each.name });
        }
      }

      return {
        settings: globalSettings,
        overriddenIn,
        secrets: [{ name: "NPM_TOKEN", scope: "every" as const, build: false }],
        skills: [],
      };
    }),
    change: ({ environment, change, author }) =>
      Effect.sync((): AppliedChange => {
        // A setting kept Global: the Environments with an Override of it do not get it.
        if (environment === GLOBAL.id) {
          const variable = fieldVariable(change.field);
          const before = valueOf(globalSettings, change.field);

          if (sameJson(before, change.value)) {
            return { status: "unchanged", environment: GLOBAL, value: before };
          }

          const overrides: Record<string, Schema.Json> = {
            ...containerOverridesFrom(globalSettings),
          };

          if (variable !== null) {
            const { [variable]: _, ...others } = globalSettings.variables;

            overrides.variables =
              change.value === null ? others : { ...others, [variable]: change.value };
          } else if (change.value === null) {
            delete overrides[change.field];
          } else {
            overrides[change.field] = change.value;
          }

          const resolved = resolveContainerSettings(overrides);

          if (Result.isFailure(resolved)) {
            return { status: "rejected", message: resolved.failure.message };
          }

          const limit = instanceLimitProblem(resolved.success);

          if (limit !== undefined) return { status: "rejected", message: limit };

          globalSettings = resolved.success;
          changes.push({ environment, change, tool: author.tool, reason: author.reason });

          const overridesIt = (each: Kept) =>
            Arr.contains(overriddenPaths(each.overrides), change.field);

          const overriding = Arr.filter([...kept.values()], overridesIt);

          const inheriting = Arr.filter(
            [...kept.values()],
            (each) => !overridesIt(each) && each.repos.length > 0,
          );

          return {
            status: "changed",
            environment: GLOBAL,
            change: {
              id: next++,
              scope: "*",
              at: 1_000,
              actor: "agent",
              session: "s-1",
              conversation: author.conversation,
              tool: author.tool,
              reason: author.reason,
              field: change.field,
              before,
              after: valueOf(globalSettings, change.field),
              reverts: null,
              revertedBy: null,
            },
            newBuild: inheriting.length > 0,
            global: {
              overriddenIn: Arr.map(overriding, ({ id, name: each }) => ({ id, name: each })),
              newBuilds: Arr.map(inheriting, ({ id, name: each }) => ({ id, name: each })),
              own: current !== null && !Arr.some(overriding, (each) => each.id === current),
            },
          };
        }

        const found = kept.get(environment);

        if (found === undefined) return { status: "missing" };

        const variable = fieldVariable(change.field);
        const resolvedBefore = detailsOf(found).settings;
        const where = { id: found.id, name: found.name };

        // A variable's own value is its Override; any other field is the value in force.
        const own: Record<string, Schema.Json> = { ...found.overrides };

        const before =
          variable !== null
            ? (found.overrides.variables?.[variable] ?? null)
            : valueOf(resolvedBefore, change.field);

        // Nothing to reset in a field that inherits.
        const inherits = variable === null && own[change.field] === undefined;

        if (sameJson(before, change.value) || (change.value === null && inherits)) {
          return { status: "unchanged", environment: where, value: before };
        }

        // As the Registry saves it: the owner's rules, then the size limit.
        if (variable !== null) {
          const { [variable]: _, ...others } = found.overrides.variables ?? {};

          own.variables = change.value === null ? others : { ...others, [variable]: change.value };
        } else if (change.value === null) {
          delete own[change.field];
        } else {
          own[change.field] = change.value;
        }

        const overrides = resolveContainerOverrides(own);

        if (Result.isFailure(overrides)) {
          return { status: "rejected", message: overrides.failure.message };
        }

        const resolved = {
          ...globalSettings,
          ...overrides.success,
        };

        const limit =
          compareInstances(resolved.instance, resolved.maxInstance) > 0
            ? instanceLimitProblem(resolved)
            : undefined;

        if (limit !== undefined) return { status: "rejected", message: limit };

        const after = resolveEnvironmentContainerSettings(globalSettings, overrides.success);

        kept.set(environment, { ...found, overrides: overrides.success });
        changes.push({ environment, change, tool: author.tool, reason: author.reason });

        const recorded: AgentChange = {
          id: next++,
          scope: environment,
          at: 1_000,
          actor: "agent",
          session: "s-1",
          conversation: author.conversation,
          tool: author.tool,
          reason: author.reason,
          field: change.field,
          before,
          after: variable !== null ? change.value : valueOf(after, change.field),
          reverts: null,
          revertedBy: null,
        };

        return {
          status: "changed",
          environment: where,
          change: recorded,
          newBuild: found.repos.length > 0,
        };
      }),
  };

  return { service, changes };
};

/** Secrets that hold `values` as a Session would, redacting them as written and in their encodings. */
const heldSecrets = (values: Readonly<Record<string, string>>): SecretsService => {
  const redactions = new Redactions();

  for (const [name, value] of Record.toEntries(values)) redactions.hold(name, value);

  const used: Pick<SecretsService, "refresh" | "redact"> = {
    refresh: Effect.void,
    redact: (value) => redactions.redact(value),
  };

  // SAFETY: the tools use only `refresh` and `redact`.
  return used as SecretsService;
};

const extensionOver = (
  environments: EnvironmentsService,
  {
    held = {},
    logged = [],
  }: { held?: Readonly<Record<string, string>>; logged?: RunChange[] } = {},
) =>
  Effect.runPromise(
    EnvironmentTools.pipe(
      Effect.provideService(Environments, environments),
      Effect.provideService(AgentChangeLog, {
        record: (change) =>
          Effect.sync(() => {
            logged.push(change);
          }),
      }),
      Effect.provideService(DeployCredentials, { values: [GITHUB_TOKEN] }),
      Effect.provideService(Secrets, heldSecrets(held)),
      Effect.provideService(Approvals, unusedApprovals),
    ),
  );

const toolsOver = async (
  environments: EnvironmentsService,
  options: { held?: Readonly<Record<string, string>>; logged?: RunChange[] } = {},
) => {
  const extension = await extensionOver(environments, options);

  return (name: string): ToolRegistration => {
    const found = Arr.findFirst(extension.tools ?? [], (tool) => tool.name === name);

    return Option.getOrThrowWith(found, () => new Error(`no tool ${name}`));
  };
};

const conversation: Pick<ToolExecutionApi, "conversationId"> = {
  conversationId: ROOT_CONVERSATION_ID,
};

// SAFETY: the tools read only the calling conversation from the invocation's API.
const api = conversation as ToolExecutionApi;

type Result = Awaited<ReturnType<ToolRegistration["execute"]>>;

const run = (tool: ToolRegistration, args: Readonly<Record<string, unknown>>): Promise<Result> =>
  // SAFETY: the arguments are the tool's JSON parameters.
  tool.execute(args as never, api, BACKGROUND_CONTEXT);

const text = (result: Result): string =>
  Arr.join(
    Arr.map(result.output ?? [], (part) => (part.type === "text" ? part.text : "")),
    "",
  );

/** The message a call fails with: a typed failure is an error result. */
const failure = async (call: Promise<Result>) => {
  const result = await call;

  expect(result.isError).toBe(true);

  return text(result);
};

describe("the environment tools", () => {
  it("are the eleven setting tools, and only the changes are kept from a rerun after an eviction", async () => {
    const tool = await toolsOver(fakeEnvironments().service);

    expect(
      Arr.map(
        [
          "environment_list",
          "environment_get",
          "environment_variable_set",
          "environment_variable_unset",
          "environment_container_resize",
          "environment_idle_time_set",
          "environment_setup_script_set",
          "environment_start_script_set",
          "environment_toolchains_set",
          "environment_ignore_set",
          "environment_spare_workspace_set",
        ],
        (name) => tool(name).replay,
      ),
    ).toEqual([
      "safe",
      "safe",
      "unsafe",
      "unsafe",
      "unsafe",
      "unsafe",
      "unsafe",
      "unsafe",
      "unsafe",
      "unsafe",
      "unsafe",
    ]);
  });

  it("lists each Environment's id, name, Repos and Build, marking this Session's", async () => {
    const tool = await toolsOver(fakeEnvironments().service);
    const listed = text(await run(tool("environment_list"), {}));

    expect(listed).toContain(
      '- default: "Default" (this Session\'s); repos: app (https://github.com/o/app.git); Build: ready',
    );
    expect(listed).toContain('- 0000abcd: "Other"; repos: none; Build: failed');
  });

  it("shows the Environment id names, marking it as this Session's: every setting, the kept Secrets by name, and the Build", async () => {
    const tool = await toolsOver(fakeEnvironments().service);
    const shown = text(await run(tool("environment_get"), { id: "default" }));

    expect(shown).toContain('Environment "Default" (id default, the Environment of this Session)');
    expect(shown).toContain("Container size (inherited from Global): cpu-1");
    expect(shown).toMatch(/Size limit \(.*\): cpu-2/);
    expect(shown).toContain("Idle time (inherited from Global): 2 minutes");
    expect(shown).toContain("Spare Workspace (inherited from Global): on");
    expect(shown).toContain("NODE_ENV=test");
    expect(shown).toContain(
      `API_KEY (kept for this Environment, reaches the Build; commands get it as $${secretEnvName("API_KEY")})`,
    );
    expect(shown).toContain("NPM_TOKEN (kept Global;");
    expect(shown).toContain("Build: ready");
  });

  it("shows the end of the last failed Build's reason", async () => {
    const tool = await toolsOver(fakeEnvironments().service);
    const shown = text(await run(tool("environment_get"), { id: "0000abcd" }));

    expect(shown).toContain("npm ERR! missing script");
    expect(shown.length).toBeLessThan(2_600);
  });

  it("refuses an id no Environment has, pointing to environment_list", async () => {
    const tool = await toolsOver(fakeEnvironments().service);

    expect(await failure(run(tool("environment_get"), { id: "ghost" }))).toContain(
      "Call environment_list",
    );
    expect(
      await failure(
        run(tool("environment_variable_set"), { id: "ghost", name: "A", value: "1", reason: "r" }),
      ),
    ).toContain("Call environment_list");
  });
});

describe("environment_variable_set", () => {
  it("saves the variable in the Environment id names, says when it applies, and records it for the Run", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool("environment_variable_set"), {
      id: "default",
      name: "API_URL",
      value: "https://api.test",
      reason: "The tests read it",
    });

    expect(environments.changes).toEqual([
      {
        environment: "default",
        change: { field: "variables.API_URL", value: "https://api.test" },
        tool: "environment_variable_set",
        reason: "The tests read it",
      },
    ]);
    expect(text(result)).toContain('it was not set, and is "https://api.test" now');
    expect(text(result)).toContain("next Container start");
    expect(text(result)).toContain("container_restart applies it");
    expect(text(result)).toContain("a new Build was asked for");
    expect(result.details).toMatchObject({
      agentChange: { field: "variables.API_URL", before: null, after: "https://api.test" },
      own: true,
    });
    expect(logged).toEqual([
      {
        tool: "environment_variable_set",
        environmentName: "Default",
        field: "variables.API_URL",
      },
    ]);
  });

  it("saves it in the Environment id names, without offering container_restart for it", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    const result = await run(tool("environment_variable_set"), {
      id: "0000abcd",
      name: "A",
      value: "1",
      reason: "r",
    });

    expect(environments.changes[0]?.environment).toBe("0000abcd");
    expect(text(result)).not.toContain("container_restart");
    expect(text(result)).not.toContain("Build was asked for");
    expect(result.details).toMatchObject({ own: false });
  });

  it("says why the Registry refused a variable, and records nothing", async () => {
    const logged: RunChange[] = [];
    const tool = await toolsOver(fakeEnvironments().service, { logged });

    expect(
      await failure(
        run(tool("environment_variable_set"), {
          id: "default",
          name: "PATH",
          value: "/bin",
          reason: "r",
        }),
      ),
    ).toBe('Nothing was saved: variables: "PATH" is reserved: the Container sets it itself');
    expect(logged).toEqual([]);
  });

  it("refuses a value holding a Secret this Session holds, as written or encoded, and saves nothing", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];

    const tool = await toolsOver(environments.service, {
      held: { API_KEY: "sk-live-0123456789" },
      logged,
    });

    for (const value of ["Bearer sk-live-0123456789", btoa("sk-live-0123456789")]) {
      expect(
        await failure(
          run(tool("environment_variable_set"), {
            id: "default",
            name: "AUTH",
            value,
            reason: "r",
          }),
        ),
      ).toContain("Ask the user to keep the value as a Secret for the Environment");
    }

    expect(environments.changes).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("refuses a reason holding a Secret this Session holds, and saves nothing", async () => {
    const environments = fakeEnvironments();

    const tool = await toolsOver(environments.service, {
      held: { API_KEY: "sk-live-0123456789" },
    });

    expect(
      await failure(
        run(tool("environment_variable_set"), {
          id: "default",
          name: "A",
          value: "1",
          reason: "The key is sk-live-0123456789",
        }),
      ),
    ).toContain("the reason holds");
    expect(environments.changes).toEqual([]);
  });

  it("refuses a value holding the GitHub token", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    expect(
      await failure(
        run(tool("environment_variable_set"), {
          id: "default",
          name: "TOKEN",
          value: GITHUB_TOKEN,
          reason: "r",
        }),
      ),
    ).toContain("GitHub token");
    expect(environments.changes).toEqual([]);
  });

  it("refuses a value or reason holding anything shaped like a GitHub token, which the Session never saw", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    for (const token of [
      `ghs_${"a1".repeat(18)}`,
      `gho_${"B2".repeat(18)}`,
      `github_pat_${"c3_".repeat(10)}`,
      // Run on from a name, with no word boundary before it.
      `GH_TOKEN_ghu_${"d4".repeat(18)}`,
    ]) {
      expect(
        await failure(
          run(tool("environment_variable_set"), {
            id: "default",
            name: "TOKEN",
            value: `Bearer ${token}`,
            reason: "r",
          }),
        ),
      ).toContain("GitHub token");
      expect(
        await failure(
          run(tool("environment_variable_set"), {
            id: "default",
            name: "TOKEN",
            value: "x",
            reason: `it is ${token}`,
          }),
        ),
      ).toContain("GitHub token");
    }

    expect(environments.changes).toEqual([]);
  });

  it("refuses a value or reason holding a Secret Reference, held or not, and saves nothing", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service, { held: { API_KEY: "sk-live-0123456789" } });

    // A Secret the Session holds, one it does not (a value scrubbed from a message names one), and one in a longer text.
    for (const value of [
      secretReference("API_KEY"),
      secretReference("NOT_HELD"),
      `Bearer ${secretReference("API_KEY")}`,
    ]) {
      expect(
        await failure(
          run(tool("environment_variable_set"), {
            id: "default",
            name: "KEY",
            value,
            reason: "r",
          }),
        ),
      ).toContain("holds a Secret Reference, which these tools do not resolve");
    }

    expect(
      await failure(
        run(tool("environment_variable_set"), {
          id: "default",
          name: "KEY",
          value: "1",
          reason: `Set from ${secretReference("NOT_HELD")}`,
        }),
      ),
    ).toContain("would hold the reference's text, not the Secret");
    expect(environments.changes).toEqual([]);
  });
});

describe("the variables kept Global", () => {
  it("are counted by environment_list, which points to environment_get with id *", async () => {
    const tool = await toolsOver(fakeEnvironments().service);

    expect(text(await run(tool("environment_list"), {}))).toContain(
      'Variables at Global: 2 (environment_get with id "*" shows them',
    );
  });

  it("are shown by environment_get after the Environment's own, with the ones its own override named", async () => {
    const tool = await toolsOver(fakeEnvironments().service);
    const shown = text(await run(tool("environment_get"), { id: "default" }));

    expect(shown).toContain(
      'Variables at Global (id "*"; the Environment\'s own of the same name win):',
    );
    expect(shown).toContain("SHARED=all");
    expect(shown).toContain("overridden here: NODE_ENV");
    // Its own NODE_ENV is test; the one at Global is not listed as a value it gets.
    expect(shown).toContain("NODE_ENV=test");
    expect(shown).not.toContain("NODE_ENV=prod");

    const other = text(await run(tool("environment_get"), { id: "0000abcd" }));

    expect(other).toContain("SHARED=all");
    expect(other).toContain("NODE_ENV=prod");
    expect(other).not.toContain("\n  overridden here:");
  });

  it("are shown by environment_get with id *, with the names of the Secrets kept Global", async () => {
    const tool = await toolsOver(fakeEnvironments().service);
    const result = await run(tool("environment_get"), { id: "*" });
    const shown = text(result);

    expect(shown).toContain('Kept at Global (id "*")');
    expect(shown).toContain("SHARED=all");
    expect(shown).toContain("NODE_ENV=prod");
    expect(shown).toContain("NPM_TOKEN (kept Global;");
    expect(shown).not.toContain("API_KEY");
    expect(result.details).toMatchObject({ environment: { id: "*" }, current: false });
  });

  it("are set by environment_variable_set with id *, naming the Builds asked for and applying to this Session's Workspace", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool("environment_variable_set"), {
      id: "*",
      name: "API_URL",
      value: "https://api.test",
      reason: "Global reads it",
    });

    expect(environments.changes).toEqual([
      {
        environment: "*",
        change: { field: "variables.API_URL", value: "https://api.test" },
        tool: "environment_variable_set",
        reason: "Global reads it",
      },
    ]);

    const said = text(result);

    expect(said).toContain(
      'Set API_URL for Global: it was not set, and is "https://api.test" now.',
    );
    expect(said).toContain("No Environment overrides it, so it reaches them all");
    expect(said).toContain("next Container start of every Workspace");
    expect(said).toContain("This Session's Workspace has the change already: container_restart");
    expect(said).toContain('a new Build was asked for in Environment "Default" (default)');
    expect(result.details).toMatchObject({
      agentChange: { environment: { id: "*" }, field: "variables.API_URL" },
      own: true,
      newBuild: true,
    });
    expect(logged).toEqual([
      {
        tool: "environment_variable_set",
        environmentName: "Global",
        field: "variables.API_URL",
      },
    ]);
  });

  it("name the Environments that override the variable, which it does not reach, session's own included", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    const said = text(
      await run(tool("environment_variable_set"), {
        id: "*",
        name: "NODE_ENV",
        value: "staging",
        reason: "r",
      }),
    );

    expect(said).toContain('it does not reach Environment "Default" (default)');
    expect(said).not.toContain("container_restart");
    expect(said).not.toContain("Build was asked for");
  });

  it("are unset by environment_variable_unset with id *, and say when one is not set", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const unset = text(
      await run(tool("environment_variable_unset"), { id: "*", name: "SHARED", reason: "r" }),
    );

    expect(environments.changes[0]).toMatchObject({
      environment: "*",
      change: { field: "variables.SHARED", value: null },
    });
    expect(unset).toContain('Unset SHARED for Global: it was "all", and is not set now');

    const again = text(
      await run(tool("environment_variable_unset"), { id: "*", name: "SHARED", reason: "r" }),
    );

    expect(again).toContain("SHARED is not set for Global: nothing changed");
    expect(logged).toHaveLength(1);
  });

  it("are refused a value holding a Secret, the GitHub token or a Secret Reference, saving nothing, and the refusal says to delete a Secret kept only for sharing", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];

    const tool = await toolsOver(environments.service, {
      held: { CLOUDFLARE_EMAIL: "me@example.test" },
      logged,
    });

    for (const value of ["me@example.test", GITHUB_TOKEN]) {
      expect(
        await failure(
          run(tool("environment_variable_set"), { id: "*", name: "EMAIL", value, reason: "r" }),
        ),
      ).toContain("ask the user to delete that Secret first");
    }

    expect(
      await failure(
        run(tool("environment_variable_set"), {
          id: "*",
          name: "EMAIL",
          value: secretReference("CLOUDFLARE_EMAIL"),
          reason: "r",
        }),
      ),
    ).toContain("holds a Secret Reference");
    expect(environments.changes).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("are not the only thing id * names: the tools that change one Environment's own record refuse it, saying which take it", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    for (const [name, args] of [
      ["environment_rename", { name: "New" }],
      ["environment_repo_add", { url: "acme/app" }],
      ["environment_repo_remove", { name: "app" }],
      ["environment_rebuild", { proposed: { variables: { A: "1" } } }],
    ] as const) {
      expect(await failure(run(tool(name), { id: "*", reason: "r", ...args })), name).toContain(
        'The id "*" names what is kept Global (the Container settings, Secrets and Skills)',
      );
    }

    expect(environments.changes).toEqual([]);

    const refusal = await failure(
      run(tool("environment_rename"), { id: "*", reason: "r", name: "New" }),
    );

    for (const taker of [
      "environment_container_resize",
      "environment_idle_time_set",
      "environment_skill_save",
      "environment_skill_install",
      "environment_skill_update",
      "environment_skill_remove",
    ]) {
      expect(refusal, taker).toContain(taker);
    }
  });
});

describe("the Container settings kept Global", () => {
  it("are changed by a setting tool with id *, which says the Environments that override the setting are not reached", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    await run(tool("environment_idle_time_set"), { id: "0000abcd", minutes: 10, reason: "r" });

    const result = await run(tool("environment_idle_time_set"), {
      id: "*",
      minutes: 5,
      reason: "Global default",
    });

    expect(environments.changes[1]).toEqual({
      environment: "*",
      change: { field: "idleMinutes", value: 5 },
      tool: "environment_idle_time_set",
      reason: "Global default",
    });

    const said = text(result);

    expect(said).toContain("Set the idle time of Global: it was 2 minutes, and is 5 now.");
    expect(said).toContain('it does not reach Environment "Other" (0000abcd), which override it');
    expect(said).toContain("This Session's Workspace has the change already: container_restart");
    expect(logged[1]).toEqual({
      tool: "environment_idle_time_set",
      environmentName: "Global",
      field: "idleMinutes",
    });

    // The Environment without an Override inherits it; the one with its own keeps its own.
    expect(text(await run(tool("environment_get"), { id: "default" }))).toContain(
      "Idle time (inherited from Global): 5 minutes",
    );
    expect(text(await run(tool("environment_get"), { id: "0000abcd" }))).toContain(
      "Idle time (overridden here): 10 minutes",
    );
  });

  it("are changed by environment_setup_script_set with id *, saying no Environment overrides it when none does", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    const said = text(
      await run(tool("environment_setup_script_set"), { id: "*", script: SCRIPT, reason: "r" }),
    );

    expect(environments.changes[0]).toMatchObject({
      environment: "*",
      change: { field: "setupScript", value: SCRIPT },
    });
    expect(said).toContain("Set the Setup Script of Global");
    expect(said).toContain("No Environment overrides it, so it reaches them all.");
  });

  it("refuse a size above Global's size limit with environment_container_resize and id *, saving nothing", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const message = await failure(
      run(tool("environment_container_resize"), { id: "*", size: "standard-3", reason: "r" }),
    );

    expect(message).toContain("standard-3 is above the size limit of Global, cpu-2");
    expect(message).toContain("environment_container_size_limit_set");
    expect(environments.changes).toEqual([]);
    expect(logged).toEqual([]);

    const result = await run(tool("environment_container_resize"), {
      id: "*",
      size: "cpu-2",
      reason: "r",
    });

    expect(text(result)).toContain("Set the Container size of Global: it was cpu-1, and is cpu-2");
    expect(environments.changes).toHaveLength(1);
  });

  it("are marked by environment_get as the Environment's own (overridden here) or inherited from Global", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    await run(tool("environment_container_resize"), { id: "default", size: "cpu-2", reason: "r" });

    const shown = text(await run(tool("environment_get"), { id: "default" }));

    expect(shown).toContain("Container size (overridden here): cpu-2");
    expect(shown).toContain("Idle time (inherited from Global): 2 minutes");
    expect(shown).toContain("Setup Script (inherited from Global): none");
  });

  it("are shown by environment_get with id *, noting the Environments that override each", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    await run(tool("environment_idle_time_set"), { id: "0000abcd", minutes: 10, reason: "r" });

    const shown = text(await run(tool("environment_get"), { id: "*" }));

    expect(shown).toContain('Idle time (overridden in Environment "Other" (0000abcd)): 2 minutes');
    expect(shown).toContain("Container size: cpu-1");
    expect(shown).toMatch(/Size limit \(.*\): cpu-2/);
    expect(shown).not.toContain("Container size (overridden");
    // The variable its own value hides in the Environment that sets it.
    expect(shown).toContain('NODE_ENV=prod (overridden in Environment "Default" (default))');
    expect(shown).toContain("SHARED=all\n");
  });
});

describe("a subagent", () => {
  const ceiling = ["bash", "environment_list", "environment_get", "environment_variable_set"];

  it("inherits none of the environment tools from its caller", () => {
    expect(resolveTools(undefined, ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      success: { tools: ["bash"] },
    });
  });

  it("is not granted one even by name", () => {
    expect(resolveTools(["environment_get"], ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      failure: expect.stringContaining(
        "environment_get is unknown or outside your capability ceiling",
      ),
    });
  });
});

describe("environment_variable_unset", () => {
  it("unsets a variable and records the change", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool("environment_variable_unset"), {
      id: "default",
      name: "NODE_ENV",
      reason: "r",
    });

    expect(environments.changes[0]?.change).toEqual({ field: "variables.NODE_ENV", value: null });
    expect(text(result)).toContain('it was "test", and is not set now');
    expect(logged).toHaveLength(1);
  });

  it("says so of a variable that is not set, and records nothing", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool("environment_variable_unset"), {
      id: "default",
      name: "GHOST",
      reason: "r",
    });

    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("GHOST is not set");
    expect(logged).toEqual([]);
  });
});

describe("environment_container_resize", () => {
  it("sets the Environment's size, saying it changes every Workspace's next Container and not the current one", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool("environment_container_resize"), {
      id: "default",
      size: "cpu-2",
      reason: "The tests need 6 GiB",
    });

    expect(environments.changes[0]).toMatchObject({
      environment: "default",
      change: { field: "instance", value: "cpu-2" },
      tool: "environment_container_resize",
    });
    expect(text(result)).toContain("it was cpu-1, and is cpu-2 now");
    expect(text(result)).toContain("every Workspace it reaches");
    expect(text(result)).toContain(
      "container_resize changes only this Workspace's current Container",
    );
    expect(text(result)).toContain("holds through container_restart until the idle stop");
    expect(result.details).toMatchObject({
      agentChange: { field: "instance", before: "cpu-1", after: "cpu-2" },
    });
    expect(logged).toEqual([
      { tool: "environment_container_resize", environmentName: "Default", field: "instance" },
    ]);
  });

  it("says in its description that the size limit is the user's to raise, through environment_container_size_limit_set", async () => {
    const tool = await toolsOver(fakeEnvironments().service);
    const description = tool("environment_container_resize").description;

    expect(description).toContain("environment_container_size_limit_set");
    expect(description).toContain("container_resize");
    expect(description).toContain("- cpu-3: 3 vCPU, 9 GiB memory");
    expect(description).toContain("- mem-12: 2 vCPU, 12 GiB memory");
  });

  it("refuses a size above the size limit, naming it and the tool that raises it, and records nothing", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const message = await failure(
      run(tool("environment_container_resize"), {
        id: "default",
        size: "standard-3",
        reason: "r",
      }),
    );

    expect(message).toContain("size limit");
    expect(message).toContain("cpu-2");
    expect(message).toContain("environment_container_size_limit_set");
    expect(environments.changes).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("takes the size limit itself, and a size below it", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    await run(tool("environment_container_resize"), { id: "default", size: "cpu-2", reason: "r" });
    await run(tool("environment_container_resize"), { id: "default", size: "basic", reason: "r" });

    expect(Arr.map(environments.changes, ({ change }) => change.value)).toEqual(["cpu-2", "basic"]);
  });

  it("says so of the size the Environment has, and records nothing", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    const result = await run(tool("environment_container_resize"), {
      id: "default",
      size: "cpu-1",
      reason: "r",
    });

    expect(text(result)).toContain("cpu-1 already");
    expect(environments.changes).toEqual([]);
  });

  it("changes the Environment id names, without offering container_restart for it", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    const result = await run(tool("environment_container_resize"), {
      id: "0000abcd",
      size: "cpu-2",
      reason: "r",
    });

    expect(environments.changes[0]?.environment).toBe("0000abcd");
    expect(text(result)).not.toContain("container_restart applies");
  });
});

describe("environment_idle_time_set", () => {
  it("saves the minutes and names their memory cost at the Environment's size", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    const result = await run(tool("environment_idle_time_set"), {
      id: "default",
      minutes: 10,
      reason: "r",
    });

    expect(environments.changes[0]?.change).toEqual({ field: "idleMinutes", value: 10 });
    expect(text(result)).toContain("it was 2 minutes, and is 10 now");
    // cpu-1: 3 GiB of memory at $0.0000025 a GiB-second is $0.00045 a minute.
    expect(text(result)).toContain("at cpu-1 (3 GiB) about $0.00045 a minute");
    expect(text(result)).toContain("up to $0.0045 for each idle stretch of 10 minutes");
  });

  it.each([0, 1441, 1.5])(
    "refuses %s as the owner's save does, and records nothing",
    async (minutes) => {
      const environments = fakeEnvironments();
      const logged: RunChange[] = [];
      const tool = await toolsOver(environments.service, { logged });

      const message = await failure(
        run(tool("environment_idle_time_set"), { id: "default", minutes, reason: "r" }),
      );

      expect(message).toMatch(/^Nothing was saved: idleMinutes: /);
      expect(environments.changes).toEqual([]);
      expect(logged).toEqual([]);
    },
  );
});

describe("environment_spare_workspace_set", () => {
  it("turns the spare off, saying it is removed and a new Session waits for its Workspace", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool("environment_spare_workspace_set"), {
      id: "default",
      enabled: false,
      reason: "Rarely used",
    });

    expect(environments.changes).toEqual([
      {
        environment: "default",
        change: { field: "spareWorkspace", value: false },
        tool: "environment_spare_workspace_set",
        reason: "Rarely used",
      },
    ]);
    expect(text(result)).toContain("Turned the Spare Workspace of");
    expect(text(result)).toContain(
      "off: the spare of each Environment it reaches, if it had one, is removed",
    );
    expect(result.details).toMatchObject({
      agentChange: { field: "spareWorkspace", before: true, after: false },
    });
    expect(logged).toEqual([
      {
        tool: "environment_spare_workspace_set",
        environmentName: "Default",
        field: "spareWorkspace",
      },
    ]);
  });

  it("says so of a spare that is on already, and records nothing", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    expect(
      text(
        await run(tool("environment_spare_workspace_set"), {
          id: "default",
          enabled: true,
          reason: "r",
        }),
      ),
    ).toContain("is on already: nothing changed");
    expect(environments.changes).toEqual([]);
  });

  it("describes the trade-off: new Sessions that start fast against the Container time of each spare", async () => {
    const tool = await toolsOver(fakeEnvironments().service);
    const { description } = tool("environment_spare_workspace_set");

    expect(description).toContain("without waiting for the clones and the Setup Scripts");
    expect(description).toContain("runs a Container for a minute or two");
  });
});

const SCRIPT = "#!/usr/bin/env bash\nset -eu\napt-get install -y postgresql\n";

describe.each([
  {
    name: "environment_setup_script_set",
    field: "setupScript",
    what: "Setup Script",
    key: "script",
    value: SCRIPT,
    hint: ".cloudpid/setup.sh",
  },
  {
    name: "environment_start_script_set",
    field: "startScript",
    what: "Start Script",
    key: "script",
    value: SCRIPT,
    hint: ".cloudpid/start.sh",
  },
  {
    name: "environment_toolchains_set",
    field: "toolchains",
    what: "Toolchains",
    key: "mise_toml",
    value: '[tools]\nnode = "22"\n',
    hint: "mise.toml",
  },
])("$name", ({ name, field, what, key, value: content, hint }) => {
  const args = { id: "default", [key]: content };

  it("saves the whole text, with the old and new values for the card, and records it for the Run", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool(name), { ...args, reason: "Needed" });

    expect(environments.changes[0]).toMatchObject({
      environment: "default",
      change: { field, value: content },
      tool: name,
      reason: "Needed",
    });
    expect(text(result)).toContain(`Set the ${what} of Environment "Default" (default)`);
    expect(text(result)).toContain("it was none");
    expect(text(result)).toMatch(/and is [23] lines, \d+ bytes now/);
    expect(text(result)).toContain("a new Build was asked for");
    expect(result.details).toMatchObject({ agentChange: { field, before: "", after: content } });
    expect(logged).toEqual([{ tool: name, environmentName: "Default", field }]);
    // The text itself is not echoed back: the card shows it.
    expect(text(result)).not.toContain(content.trim());
  });

  it("explains itself, pointing a Repo's own step to its .cloudpid directory", async () => {
    const tool = await toolsOver(fakeEnvironments().service);

    expect(tool(name).description).toContain(hint);
  });

  it("removes the setting with an empty text", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    await run(tool(name), { ...args, reason: "r" });

    const result = await run(tool(name), { id: "default", [key]: "", reason: "r" });

    expect(text(result)).toContain(`Removed the ${what}`);
    expect(environments.changes[1]?.change.value).toBe("");
  });

  it("says so of the text it already has, and records nothing", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    await run(tool(name), { ...args, reason: "r" });

    const result = await run(tool(name), { ...args, reason: "r" });

    expect(text(result)).toContain("is that text already");
    expect(environments.changes).toHaveLength(1);
  });

  it("refuses an oversized text as the owner's save does, and records nothing", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const message = await failure(
      run(tool(name), { id: "default", [key]: "x".repeat(65 * 1024), reason: "r" }),
    );

    expect(message).toMatch(new RegExp(`^Nothing was saved: ${field}: .*longer than`));
    expect(environments.changes).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("refuses a text holding a Secret this Session holds or the GitHub token, and saves nothing", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service, { held: { API_KEY: "sk-live-0123456789" } });

    for (const leaked of ["sk-live-0123456789", btoa("sk-live-0123456789"), GITHUB_TOKEN]) {
      expect(
        await failure(run(tool(name), { id: "default", [key]: `echo ${leaked}\n`, reason: "r" })),
      ).toContain("holds the value of a Secret");
    }

    expect(environments.changes).toEqual([]);
  });
});

describe("environment_setup_script_set and environment_start_script_set", () => {
  it("say when each runs: once per content, with a Build, and at every start, detaching services", async () => {
    const tool = await toolsOver(fakeEnvironments().service);

    expect(tool("environment_setup_script_set").description).toContain("once per content");
    expect(tool("environment_setup_script_set").description).toContain("makes a new Build");
    expect(tool("environment_start_script_set").description).toContain("every Container start");
    expect(tool("environment_start_script_set").description).toContain("must detach");
  });

  it("say no new Build was asked for when the Environment has nothing to build, and point to container_restart for its own", async () => {
    const tool = await toolsOver(fakeEnvironments().service);

    const own = await run(tool("environment_start_script_set"), {
      id: "default",
      script: SCRIPT,
      reason: "r",
    });

    const other = await run(tool("environment_setup_script_set"), {
      id: "0000abcd",
      script: SCRIPT,
      reason: "r",
    });

    expect(text(own)).toContain("container_restart applies it");
    expect(text(other)).not.toContain("container_restart applies");
    expect(text(other)).toContain("No new Build was asked for");
  });
});

describe("environment_ignore_set", () => {
  it("saves the whole list, warning that the next Container starts without the Snapshot", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool("environment_ignore_set"), {
      id: "default",
      patterns: ["/data", "**/.gradle-cache"],
      reason: "Large generated data",
    });

    expect(environments.changes[0]?.change).toEqual({
      field: "ignore",
      value: ["/data", "**/.gradle-cache"],
    });
    expect(text(result)).toContain("they were none, and are /data, **/.gradle-cache now");
    expect(text(result)).toContain("without the Workspace's snapshot");
    expect(result.details).toMatchObject({
      agentChange: { field: "ignore", before: [], after: ["/data", "**/.gradle-cache"] },
    });
    expect(logged).toEqual([
      { tool: "environment_ignore_set", environmentName: "Default", field: "ignore" },
    ]);
  });

  it("empties the list, and says so of one that is the same", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    expect(
      text(await run(tool("environment_ignore_set"), { id: "default", patterns: [], reason: "r" })),
    ).toContain("are that list already");
    expect(environments.changes).toEqual([]);
  });

  it("refuses a bad pattern as the owner's save does, and too many", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    expect(
      await failure(
        run(tool("environment_ignore_set"), { id: "default", patterns: ["data"], reason: "r" }),
      ),
    ).toMatch(/^Nothing was saved: ignore\.0: "data" must start with/);
    expect(
      await failure(
        run(tool("environment_ignore_set"), {
          id: "default",
          patterns: Arr.makeBy(51, (index) => `/dir${index}`),
          reason: "r",
        }),
      ),
    ).toContain("Nothing was saved: ignore");
    expect(environments.changes).toEqual([]);
  });

  it("refuses a pattern holding a Secret", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service, { held: { API_KEY: "sk-live-0123456789" } });

    expect(
      await failure(
        run(tool("environment_ignore_set"), {
          id: "default",
          patterns: ["/sk-live-0123456789"],
          reason: "r",
        }),
      ),
    ).toContain("holds the value of a Secret");
    expect(environments.changes).toEqual([]);
  });
});

describe("the environment tools from a program", () => {
  it("gets the Environments, each Environment's settings and the setters' outcomes, as their schemas declare", async () => {
    const reason = "to try it";

    const steps: ReadonlyArray<readonly [string, JsonObject]> = [
      ["environment_list", {}],
      ["environment_get", { id: "default" }],
      ["environment_get", { id: "0000abcd" }],
      ["environment_get", { id: "*" }],
      ["environment_variable_set", { id: "default", name: "API_URL", value: "https://x", reason }],
      ["environment_variable_set", { id: "default", name: "API_URL", value: "https://x", reason }],
      ["environment_variable_unset", { id: "default", name: "API_URL", reason }],
      ["environment_container_resize", { id: "default", size: "cpu-2", reason }],
      ["environment_idle_time_set", { id: "default", minutes: 10, reason }],
      ["environment_setup_script_set", { id: "default", script: "npm ci", reason }],
      ["environment_start_script_set", { id: "default", script: "docker compose up -d", reason }],
      ["environment_toolchains_set", { id: "default", mise_toml: '[tools]\nnode = "22"', reason }],
      ["environment_ignore_set", { id: "default", patterns: ["/data"], reason }],
      ["environment_spare_workspace_set", { id: "default", enabled: false, reason }],
      ["environment_variable_set", { id: "*", name: "NEW_VAR", value: "1", reason }],
    ];

    const called = await runProgram([await extensionOver(fakeEnvironments().service)], steps);

    expect(Arr.map(called, (each) => each.diagnostics)).toEqual(Arr.map(steps, () => []));
    expect(Arr.map(called, (each) => each.isError)).toEqual(Arr.map(steps, () => false));

    const [list, own, other, global, ...setters] = Arr.map(called, (each) => each.structuredOutput);

    expect(Schema.decodeUnknownSync(EnvironmentListOutput)(list)).toMatchObject({
      environments: [
        {
          id: "default",
          name: "Default",
          current: true,
          repos: [{ name: "app", url: "https://github.com/o/app.git" }],
          build: { status: "ready", at: Date.UTC(2026, 9, 20), reason: null },
        },
        { id: "0000abcd", current: false, repos: [], build: { status: "failed" } },
      ],
      environments_truncated: false,
      global_variables: 2,
    });

    // The settings in force, each marked own or inherited; the Secrets by name, never a value.
    expect(Schema.decodeUnknownSync(EnvironmentGetOutput)(own)).toMatchObject({
      scope: { id: "default", name: "Default" },
      current: true,
      build: { status: "ready" },
      settings: {
        instance: { value: "cpu-1", source: "inherited" },
        idle_minutes: { value: 2, source: "inherited" },
        spare_workspace: { value: true, source: "inherited" },
      },
      variables: [
        { name: "NODE_ENV", value: "test", source: "own" },
        { name: "SHARED", value: "all", source: "inherited" },
      ],
      overridden_global_variables: ["NODE_ENV"],
      secrets: [
        { name: "API_KEY", scope: "environment", build: true, env_var: secretEnvName("API_KEY") },
        { name: "NPM_TOKEN", scope: "every", build: false },
      ],
      skills: [],
      problem: null,
    });

    // The end of the failed Build's reason, as the text shows it.
    expect(Schema.decodeUnknownSync(EnvironmentGetOutput)(other)).toMatchObject({
      current: false,
      build: { status: "failed", at: 0, last_good_at: null, reason_truncated: true },
    });
    expect(Schema.decodeUnknownSync(EnvironmentGetOutput)(other).build?.reason).toMatch(
      /^x+npm ERR! missing script$/,
    );

    // Global's settings, with the Environments that override each.
    expect(Schema.decodeUnknownSync(EnvironmentGetOutput)(global)).toMatchObject({
      scope: GLOBAL,
      current: false,
      repos: [],
      build: null,
      settings: { instance: { value: "cpu-1", source: "global", overridden_in: [] } },
      variables: [
        { name: "SHARED", value: "all", source: "global", overridden_in: [] },
        { name: "NODE_ENV", value: "prod", source: "global", overridden_in: [GLOBAL_OVERRIDER] },
      ],
      secrets: [{ name: "NPM_TOKEN", scope: "every" }],
    });

    const [set, again, unset, resize, idle, setup, start, toolchains, ignore, spare, atGlobal] =
      Arr.map(setters, (each) => Schema.decodeUnknownSync(EnvironmentChangeOutput)(each));

    const scope = { id: "default", name: "Default" };

    expect(set).toMatchObject({
      scope,
      changes: [
        { field: "variables.API_URL", before: null, after: "https://x", before_inherited: false },
      ],
      unchanged: [],
      approval: null,
      own: true,
      new_build: true,
      global: null,
    });
    expect(again).toMatchObject({
      scope,
      changes: [],
      unchanged: ["variables.API_URL"],
      own: false,
      new_build: false,
    });
    expect(unset).toMatchObject({ changes: [{ field: "variables.API_URL", after: null }] });
    expect(resize).toMatchObject({
      changes: [{ field: "instance", before: "cpu-1", after: "cpu-2" }],
    });
    expect(idle).toMatchObject({ changes: [{ field: "idleMinutes", before: 2, after: 10 }] });
    expect(setup).toMatchObject({
      changes: [{ field: "setupScript", before: "", after: "npm ci" }],
    });
    expect(start).toMatchObject({ changes: [{ field: "startScript" }] });
    expect(toolchains).toMatchObject({ changes: [{ field: "toolchains" }] });
    expect(ignore).toMatchObject({ changes: [{ field: "ignore", after: ["/data"] }] });
    expect(spare).toMatchObject({
      changes: [{ field: "spareWorkspace", before: true, after: false }],
    });

    // At Global: whom it reached, where a Build was asked for.
    expect(atGlobal).toMatchObject({
      scope: GLOBAL,
      changes: [{ field: "variables.NEW_VAR", before: null, after: "1" }],
      own: true,
      global: { overridden_in: [], new_builds: [scope] },
    });
  });

  it("cuts what can grow: Environments, long scripts, lists of paths and variables", async () => {
    const huge = fakeEnvironments("default", {
      ...DEFAULT_CONTAINER_SETTINGS,
      setupScript: "echo setup\n".repeat(20_000),
      ignore: Arr.makeBy(3_000, (index) => `/${"d".repeat(100)}${index}`),
      variables: Record.fromEntries(
        Arr.makeBy(200, (index) => [`VAR_${index}`, "v".repeat(4_000)] as const),
      ),
    });

    const crowded: EnvironmentsService = {
      ...huge.service,
      list: Effect.succeed(
        Arr.makeBy(4_000, (index) => ({
          id: `env-${index}`,
          name: `${"n".repeat(200)}${index}`,
          repos: [{ name: "app", url: `https://github.com/o/${"a".repeat(100)}.git` }],
          build: { status: "none" as const },
        })),
      ),
    };

    // Called as a program does: a value this big does not fit a tool result's text, so what comes back is how large it
    // is and which of its lists were cut. Each must be a value (no error) under what a nested call holds.
    const sized = await runSized(
      [await extensionOver(crowded)],
      [
        ["environment_list", {}],
        ["environment_get", { id: "*" }],
        ["environment_get", { id: "default" }],
      ],
    );

    expect(Arr.map(sized, (each) => each.isError)).toEqual([false, false, false]);
    // The only diagnostics are of the text, which the Harness cuts for the model.

    for (const each of sized) expect(each.bytes).toBeLessThan(MAX_NESTED_STRUCTURED_OUTPUT_BYTES);

    expect(sized[0]?.truncated).toMatchObject({ environments_truncated: true });
    expect(sized[1]?.truncated).toMatchObject({ variables_truncated: true });
    expect(sized[2]?.truncated).toMatchObject({ variables_truncated: true });

    // The cuts inside the settings, which a script gets as `value_truncated`.
    const tool = await toolsOver(crowded);

    for (const id of ["*", "default"]) {
      const result = await run(tool("environment_get"), { id });

      expect(Schema.decodeUnknownSync(EnvironmentGetOutput)(result.structuredOutput)).toMatchObject(
        {
          settings: { setup_script: { value_truncated: true }, ignore: { value_truncated: true } },
        },
      );
    }
  });
});
