// The `environment` extension (docs/spec.md → Agent changes), over fake Environments: what each tool shows and changes,
// the refusal of values that hold a Secret, and the Run's record of the changes.
// @effect-diagnostics asyncFunction:off
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
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
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
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

/** Environments over a map of variables per Environment, applying each change as the Registry would. */
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

        const name = fieldVariable(change.field) ?? change.field;

        if (name === "PATH") {
          return {
            status: "rejected",
            message: 'variables: "PATH" is reserved: the Container sets it itself',
          };
        }

        const before = found.settings.variables[name] ?? null;
        const where = { id: found.id, name: found.name };

        if (before === change.value) {
          return { status: "unchanged", environment: where, value: before };
        }

        const { [name]: _, ...others } = found.settings.variables;

        const variables = Predicate.isString(change.value)
          ? { ...others, [name]: change.value }
          : others;

        details.set(environment, { ...found, settings: { ...found.settings, variables } });
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
          after: change.value,
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

const run = (tool: ToolRegistration, args: Readonly<Record<string, string>>): Promise<Result> =>
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
  it("are four, and only the changes are kept from a rerun after an eviction", async () => {
    const tool = await toolsOver(fakeEnvironments().service);

    expect(
      Arr.map(
        [
          "environment_list",
          "environment_get",
          "environment_variable_set",
          "environment_variable_unset",
        ],
        (name) => tool(name).replay,
      ),
    ).toEqual(["safe", "safe", "unsafe", "unsafe"]);
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

  it("refuses a value holding a Secret Reference, held or not, and saves nothing", async () => {
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
      ).toContain("the value holds a Secret Reference");
    }

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
