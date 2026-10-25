// The `environment` extension (docs/spec.md → Agent changes), over fake Environments: what each tool shows and changes,
// the refusal of values that hold a Secret, and the Run's record of the changes.
// @effect-diagnostics asyncFunction:off
import {
  type ContainerSettings,
  containerOverridesFrom,
  DEFAULT_CONTAINER_SETTINGS,
  instanceLimitProblem,
  resolveContainerSettings,
} from "@cloudpid/config";
import { type AgentChange, fieldVariable } from "@cloudpid/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
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
import { Redactions } from "./secrets/redaction.ts";
import { secretEnvName, secretReference } from "./secrets/references.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

const DEFAULT: EnvironmentDetails = {
  id: "default",
  name: "Default",
  repos: [{ name: "app", url: "https://github.com/o/app.git" }],
  build: { status: "ready", at: Date.UTC(2026, 9, 20) },
  settings: { ...DEFAULT_CONTAINER_SETTINGS, variables: { NODE_ENV: "test" } },
  secrets: [
    { name: "API_KEY", scope: "environment", build: true },
    { name: "NPM_TOKEN", scope: "every", build: false },
  ],
};

const OTHER: EnvironmentDetails = {
  id: "0000abcd",
  name: "Other",
  repos: [],
  build: {
    status: "failed",
    reason: `${"x".repeat(2_000)}npm ERR! missing script`,
    at: 0,
    lastGoodAt: null,
  },
  settings: DEFAULT_CONTAINER_SETTINGS,
  secrets: [],
};

const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

/** The value a field has in `settings`: null for a variable that is not set. */
const valueOf = (settings: ContainerSettings, field: string): Schema.Json | null => {
  const variable = fieldVariable(field);

  if (variable !== null) return settings.variables[variable] ?? null;

  // SAFETY: the tests name only fields of the settings.
  return settings[field as keyof ContainerSettings];
};

/** Environments over a map of settings per Environment, applying each change as the Registry would. */
const fakeEnvironments = (current: string | null = "default") => {
  const details = new Map(Arr.map([DEFAULT, OTHER], (each) => [each.id, each] as const));

  const changes: Array<{
    environment: string;
    change: SettingChange;
    tool: string;
    reason: string;
  }> = [];

  let next = 1;

  const service: EnvironmentsService = {
    current: Effect.succeed(current),
    list: Effect.sync(() => [...details.values()]),
    get: (id) => Effect.sync(() => details.get(id) ?? null),
    change: ({ environment, change, author }) =>
      Effect.sync((): AppliedChange => {
        const found = details.get(environment);

        if (found === undefined) return { status: "missing" };

        const variable = fieldVariable(change.field);
        const before = valueOf(found.settings, change.field);
        const where = { id: found.id, name: found.name };

        if (sameJson(before, change.value)) {
          return { status: "unchanged", environment: where, value: before };
        }

        // As the Registry saves it: the owner's rules, then the size limit.
        const overrides: Record<string, Schema.Json> = {
          ...containerOverridesFrom(found.settings),
        };

        if (variable !== null) {
          const { [variable]: _, ...others } = found.settings.variables;

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

        details.set(environment, { ...found, settings: resolved.success });
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
          after: valueOf(resolved.success, change.field),
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

const toolsOver = async (
  environments: EnvironmentsService,
  {
    held = {},
    logged = [],
  }: { held?: Readonly<Record<string, string>>; logged?: RunChange[] } = {},
) => {
  const extension = await Effect.runPromise(
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
    ),
  );

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
  it("are ten, and only the changes are kept from a rerun after an eviction", async () => {
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

  it("shows this Session's Environment by default: every setting, the kept Secrets by name, and the Build", async () => {
    const tool = await toolsOver(fakeEnvironments().service);
    const shown = text(await run(tool("environment_get"), {}));

    expect(shown).toContain('Environment "Default" (id default, the Environment of this Session)');
    expect(shown).toContain("Container size: custom-1");
    expect(shown).toMatch(/Size limit \(.*\): custom-2/);
    expect(shown).toContain("Idle time: 2 minutes");
    expect(shown).toContain("NODE_ENV=test");
    expect(shown).toContain(
      `API_KEY (kept for this Environment, reaches the Build; commands get it as $${secretEnvName("API_KEY")})`,
    );
    expect(shown).toContain("NPM_TOKEN (kept for every Environment;");
    expect(shown).toContain("Build: ready");
  });

  it("shows the end of the last failed Build's reason", async () => {
    const tool = await toolsOver(fakeEnvironments().service);
    const shown = text(await run(tool("environment_get"), { id: "0000abcd" }));

    expect(shown).toContain("npm ERR! missing script");
    expect(shown.length).toBeLessThan(2_000);
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
  it("saves the variable in this Session's Environment, says when it applies, and records it for the Run", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool("environment_variable_set"), {
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
        run(tool("environment_variable_set"), { name: "PATH", value: "/bin", reason: "r" }),
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
        await failure(run(tool("environment_variable_set"), { name: "AUTH", value, reason: "r" })),
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
        run(tool("environment_variable_set"), { name: "TOKEN", value: GITHUB_TOKEN, reason: "r" }),
      ),
    ).toContain("GitHub token");
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
        await failure(run(tool("environment_variable_set"), { name: "KEY", value, reason: "r" })),
      ).toContain("holds a Secret Reference, which these tools do not resolve");
    }

    expect(
      await failure(
        run(tool("environment_variable_set"), {
          name: "KEY",
          value: "1",
          reason: `Set from ${secretReference("NOT_HELD")}`,
        }),
      ),
    ).toContain("would hold the reference's text, not the Secret");
    expect(environments.changes).toEqual([]);
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

    const result = await run(tool("environment_variable_unset"), { name: "NODE_ENV", reason: "r" });

    expect(environments.changes[0]?.change).toEqual({ field: "variables.NODE_ENV", value: null });
    expect(text(result)).toContain('it was "test", and is not set now');
    expect(logged).toHaveLength(1);
  });

  it("says so of a variable that is not set, and records nothing", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool("environment_variable_unset"), { name: "GHOST", reason: "r" });

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
      size: "custom-2",
      reason: "The tests need 6 GiB",
    });

    expect(environments.changes[0]).toMatchObject({
      environment: "default",
      change: { field: "instance", value: "custom-2" },
      tool: "environment_container_resize",
    });
    expect(text(result)).toContain("it was custom-1, and is custom-2 now");
    expect(text(result)).toContain("every Workspace of the Environment");
    expect(text(result)).toContain(
      "container_resize changes only this Workspace's current Container",
    );
    expect(result.details).toMatchObject({
      agentChange: { field: "instance", before: "custom-1", after: "custom-2" },
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
    expect(description).toContain("- custom-3: 3 vCPU, 9 GiB memory");
  });

  it("refuses a size above the size limit, naming it and the tool that raises it, and records nothing", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const message = await failure(
      run(tool("environment_container_resize"), { size: "standard-3", reason: "r" }),
    );

    expect(message).toContain("size limit");
    expect(message).toContain("custom-2");
    expect(message).toContain("environment_container_size_limit_set");
    expect(environments.changes).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("takes the size limit itself, and a size below it", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    await run(tool("environment_container_resize"), { size: "custom-2", reason: "r" });
    await run(tool("environment_container_resize"), { size: "basic", reason: "r" });

    expect(Arr.map(environments.changes, ({ change }) => change.value)).toEqual([
      "custom-2",
      "basic",
    ]);
  });

  it("says so of the size the Environment has, and records nothing", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    const result = await run(tool("environment_container_resize"), {
      size: "custom-1",
      reason: "r",
    });

    expect(text(result)).toContain("custom-1 already");
    expect(environments.changes).toEqual([]);
  });

  it("changes the Environment id names, without offering container_restart for it", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    const result = await run(tool("environment_container_resize"), {
      id: "0000abcd",
      size: "custom-2",
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

    const result = await run(tool("environment_idle_time_set"), { minutes: 10, reason: "r" });

    expect(environments.changes[0]?.change).toEqual({ field: "idleMinutes", value: 10 });
    expect(text(result)).toContain("it was 2 minutes, and is 10 now");
    // custom-1: 3 GiB of memory at $0.0000025 a GiB-second is $0.00045 a minute.
    expect(text(result)).toContain("at custom-1 (3 GiB) about $0.00045 a minute");
    expect(text(result)).toContain("up to $0.0045 for each idle stretch of 10 minutes");
  });

  it.each([0, 1441, 1.5])(
    "refuses %s as the owner's save does, and records nothing",
    async (minutes) => {
      const environments = fakeEnvironments();
      const logged: RunChange[] = [];
      const tool = await toolsOver(environments.service, { logged });

      const message = await failure(
        run(tool("environment_idle_time_set"), { minutes, reason: "r" }),
      );

      expect(message).toMatch(/^Nothing was saved: idleMinutes: /);
      expect(environments.changes).toEqual([]);
      expect(logged).toEqual([]);
    },
  );
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
])("$name", ({ name, field, what, key, value: text_, hint }) => {
  const args = { [key]: text_ };

  it("saves the whole text, with the old and new values for the card, and records it for the Run", async () => {
    const environments = fakeEnvironments();
    const logged: RunChange[] = [];
    const tool = await toolsOver(environments.service, { logged });

    const result = await run(tool(name), { ...args, reason: "Needed" });

    expect(environments.changes[0]).toMatchObject({
      environment: "default",
      change: { field, value: text_ },
      tool: name,
      reason: "Needed",
    });
    expect(text(result)).toContain(`Set the ${what} of Environment "Default" (default)`);
    expect(text(result)).toContain("it was none");
    expect(text(result)).toContain("a new Build was asked for");
    expect(result.details).toMatchObject({ agentChange: { field, before: "", after: text_ } });
    expect(logged).toEqual([{ tool: name, environmentName: "Default", field }]);
    // The text itself is not echoed back: the card shows it.
    expect(text(result)).not.toContain(String(text_).trim());
  });

  it("explains itself, pointing a Repo's own step to its .cloudpid directory", async () => {
    const tool = await toolsOver(fakeEnvironments().service);

    expect(tool(name).description).toContain(hint);
  });

  it("removes the setting with an empty text", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    await run(tool(name), { ...args, reason: "r" });

    const result = await run(tool(name), { [key]: "", reason: "r" });

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

    const message = await failure(run(tool(name), { [key]: "x".repeat(65 * 1024), reason: "r" }));

    expect(message).toMatch(new RegExp(`^Nothing was saved: ${field}: .*longer than`));
    expect(environments.changes).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("refuses a text holding a Secret this Session holds or the GitHub token, and saves nothing", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service, { held: { API_KEY: "sk-live-0123456789" } });

    for (const leaked of ["sk-live-0123456789", btoa("sk-live-0123456789"), GITHUB_TOKEN]) {
      expect(await failure(run(tool(name), { [key]: `echo ${leaked}\n`, reason: "r" }))).toContain(
        "holds the value of a Secret",
      );
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

    const own = await run(tool("environment_start_script_set"), { script: SCRIPT, reason: "r" });

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
      text(await run(tool("environment_ignore_set"), { patterns: [], reason: "r" })),
    ).toContain("are that list already");
    expect(environments.changes).toEqual([]);
  });

  it("refuses a bad pattern as the owner's save does, and too many", async () => {
    const environments = fakeEnvironments();
    const tool = await toolsOver(environments.service);

    expect(
      await failure(run(tool("environment_ignore_set"), { patterns: ["data"], reason: "r" })),
    ).toMatch(/^Nothing was saved: ignore\.0: "data" must start with/);
    expect(
      await failure(
        run(tool("environment_ignore_set"), {
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
        run(tool("environment_ignore_set"), { patterns: ["/sk-live-0123456789"], reason: "r" }),
      ),
    ).toContain("holds the value of a Secret");
    expect(environments.changes).toEqual([]);
  });
});
