// The `environment` extension's tools for an Environment's record (docs/architecture/agent-changes.md): making an Environment,
// renaming it, adding and removing Repos, asking for a Build. Over fake Environments that apply each as the Registry does.
// @effect-diagnostics asyncFunction:off
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { describe, expect, it, vi } from "vitest";
import {
  AgentChangeLog,
  DeployCredentials,
  Environments,
  type EnvironmentsService,
  EnvironmentTools,
  type RunChange,
} from "./environment.ts";
import { Approvals } from "./approvals.ts";
import { unusedApprovals } from "./approvals.fixture.ts";
import { fakeLifecycle } from "./environment-lifecycle.fixture.ts";
import { unusedSecretMarks } from "./environment-secret-marks.fixture.ts";
import { unusedSkills } from "./environment-skills.fixture.ts";
import { Redactions } from "./secrets/redaction.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

const setUp = async (held: Readonly<Record<string, string>> = {}) => {
  const lifecycle = fakeLifecycle();
  const logged: RunChange[] = [];
  const redactions = new Redactions();

  for (const [name, value] of Record.toEntries(held)) redactions.hold(name, value);

  // SAFETY: the tools use only `refresh` and `redact` of the Secrets.
  const secrets = {
    refresh: Effect.void,
    redact: (value: string) => redactions.redact(value),
  } as SecretsService;

  const environments: EnvironmentsService = {
    ...lifecycle.service,
    ...unusedSecretMarks,
    ...unusedSkills,
    current: Effect.succeed("default"),
    list: Effect.succeed([]),
    get: () => Effect.succeed(null),
    global: Effect.succeed({
      settings: DEFAULT_CONTAINER_SETTINGS,
      overriddenIn: {},
      secrets: [],
      skills: [],
    }),
    change: () => Effect.die("not used here"),
  };

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
      Effect.provideService(Secrets, secrets),
      Effect.provideService(Approvals, unusedApprovals),
    ),
  );

  const tool = (name: string): ToolRegistration =>
    Option.getOrThrowWith(
      Arr.findFirst(extension.tools ?? [], (each) => each.name === name),
      () => new Error(`no tool ${name}`),
    );

  return { tool, logged, ...lifecycle };
};

/** A call's API: its conversation, its task, and its memo, which a rerun of the call (the same `memos`) finds again. */
const callApi = (task = 1, memos = new Map<string, unknown>()): ToolExecutionApi =>
  // SAFETY: the tools read only the calling conversation, the call's task and its memo from the invocation's API.
  ({
    conversationId: ROOT_CONVERSATION_ID,
    taskId: task,
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) memos.set(name, rest[0]);

      return memos.get(name);
    },
  }) as ToolExecutionApi;

type Result = Awaited<ReturnType<ToolRegistration["execute"]>>;

const run = (
  tool: ToolRegistration,
  args: Readonly<Record<string, unknown>>,
  api: ToolExecutionApi = callApi(),
  context = BACKGROUND_CONTEXT,
): Promise<Result> =>
  // SAFETY: the arguments are the tool's JSON parameters.
  tool.execute(args as never, api, context);

const text = (result: Result): string =>
  Arr.join(
    Arr.map(result.output ?? [], (part) => (part.type === "text" ? part.text : "")),
    "",
  );

const failure = async (call: Promise<Result>) => {
  const result = await call;

  expect(result.isError).toBe(true);

  return text(result);
};

describe("the lifecycle tools", () => {
  it("are five, each run alone; all but environment_rebuild are kept from a rerun after an eviction", async () => {
    const { tool } = await setUp();

    for (const name of [
      "environment_create",
      "environment_rename",
      "environment_repo_add",
      "environment_repo_remove",
    ]) {
      expect(tool(name).replay).toBe("unsafe");
      expect(tool(name).executionMode).toBe("sequential");
    }

    // A Test Build's wait is found again by the rerun, and a Build of the saved settings is asked for once.
    expect(tool("environment_rebuild").replay).toBe("safe");
    expect(tool("environment_rebuild").executionMode).toBe("sequential");
  });

  it("are the root conversation's only", () => {
    const ceiling = ["bash", "environment_create", "environment_rebuild"];

    expect(resolveTools(undefined, ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      success: { tools: ["bash"] },
    });
    expect(resolveTools(["environment_create"], ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      failure: expect.stringContaining("environment_create is unknown or outside"),
    });
  });
});

describe("environment_create", () => {
  it("makes the Environment, answers its id, and says it is not this Session's", async () => {
    const { tool, held, logged } = await setUp();

    const result = await run(tool("environment_create"), {
      name: "  Billing API ",
      repos: ["o/billing", "o/shared"],
      reason: "The billing work needs its own Repos",
    });

    expect(held.get("0000ff00")).toMatchObject({
      name: "Billing API",
      repos: [
        { name: "billing", url: "https://github.com/o/billing.git" },
        { name: "shared", url: "https://github.com/o/shared.git" },
      ],
    });

    const said = text(result);

    expect(said).toContain('Environment "Billing API" (0000ff00)');
    expect(said).toContain("billing (https://github.com/o/billing.git)");
    expect(said).toContain("Its id is 0000ff00");
    expect(said).toContain("not this Session's Environment");
    expect(said).toContain("you cannot start a Session in it");
    expect(result.details).toMatchObject({
      agentChange: {
        environment: { id: "0000ff00", name: "Billing API" },
        field: "environment",
        before: null,
        after: { name: "Billing API" },
      },
    });
    expect(logged).toEqual([
      { tool: "environment_create", environmentName: "Billing API", field: "environment" },
    ]);
  });

  it("makes one with no Repos", async () => {
    const { tool } = await setUp();

    expect(text(await run(tool("environment_create"), { name: "Empty", reason: "r" }))).toContain(
      "with no repos",
    );
  });

  it("refuses a name another Environment has in any case, passing on the Registry's words", async () => {
    const { tool, logged } = await setUp();

    expect(await failure(run(tool("environment_create"), { name: "OTHER", reason: "r" }))).toBe(
      'Nothing was saved: Another environment is already named "OTHER"',
    );
    expect(logged).toEqual([]);
  });

  it("refuses an empty name and one over 80 characters, passing on the Registry's words", async () => {
    const { tool } = await setUp();

    expect(await failure(run(tool("environment_create"), { name: "   ", reason: "r" }))).toBe(
      "Nothing was saved: Give the environment a name",
    );
    expect(
      await failure(run(tool("environment_create"), { name: "x".repeat(81), reason: "r" })),
    ).toBe("Nothing was saved: Use at most 80 characters");
  });

  it("refuses a name or reason holding a Secret the Session holds, and makes nothing", async () => {
    const { tool, held, calls } = await setUp({ API_KEY: "sk-live-0123456789" });

    expect(
      await failure(run(tool("environment_create"), { name: "sk-live-0123456789", reason: "r" })),
    ).toContain("the name holds the value of a Secret");
    expect(
      await failure(
        run(tool("environment_create"), { name: "Fine", reason: `key ${GITHUB_TOKEN}` }),
      ),
    ).toContain("the reason holds");
    expect(calls).toEqual([]);
    expect(held.size).toBe(2);
  });
});

describe("environment_rename", () => {
  it("renames the Environment id names and records the names before and after", async () => {
    const { tool, held, logged } = await setUp();

    const result = await run(tool("environment_rename"), {
      id: "default",
      name: "Main",
      reason: "Clearer",
    });

    expect(held.get("default")?.name).toBe("Main");
    expect(text(result)).toContain('Renamed "Default" to "Main"');
    expect(result.details).toMatchObject({
      agentChange: {
        environment: { id: "default", name: "Main" },
        field: "name",
        before: "Default",
        after: "Main",
      },
    });
    expect(logged).toEqual([
      { tool: "environment_rename", environmentName: "Main", field: "name" },
    ]);
  });

  it("renames the Environment id names", async () => {
    const { tool, held } = await setUp();

    await run(tool("environment_rename"), { id: "0000abcd", name: "Second", reason: "r" });

    expect(held.get("0000abcd")?.name).toBe("Second");
    expect(held.get("default")?.name).toBe("Default");
  });

  it("refuses a name another Environment has, whatever the case", async () => {
    const { tool, logged } = await setUp();

    expect(
      await failure(run(tool("environment_rename"), { id: "default", name: "other", reason: "r" })),
    ).toBe('Nothing was saved: Another environment is already named "other"');
    expect(logged).toEqual([]);
  });

  it("says so of the name it has already, and records nothing", async () => {
    const { tool, logged } = await setUp();

    const result = await run(tool("environment_rename"), {
      id: "default",
      name: "Default",
      reason: "r",
    });

    expect(result.isError).not.toBe(true);
    expect(text(result)).toContain("already has that name");
    expect(logged).toEqual([]);
  });

  it("refuses an id no Environment has, pointing to environment_list", async () => {
    const { tool } = await setUp();

    expect(
      await failure(run(tool("environment_rename"), { id: "ghost", name: "X", reason: "r" })),
    ).toContain("Call environment_list");
  });
});

describe("environment_repo_add and environment_repo_remove", () => {
  it("add a Repo and say that no Workspace changes while a new one gets it", async () => {
    const { tool, held, logged } = await setUp();

    const result = await run(tool("environment_repo_add"), {
      id: "default",
      url: "o/api",
      reason: "The API lives there",
    });

    expect(held.get("default")?.repos).toContainEqual({
      name: "api",
      url: "https://github.com/o/api.git",
    });

    const said = text(result);

    expect(said).toContain("Added the repo api (https://github.com/o/api.git)");
    expect(said).toContain("no Workspace a Session has gets a clone or loses one");
    expect(said).toContain("this Session's included");
    expect(said).toContain("A new Workspace made from the Environment gets the clone");
    expect(result.details).toMatchObject({
      agentChange: { field: "repos.api", before: null, after: "https://github.com/o/api.git" },
    });
    expect(logged).toEqual([
      { tool: "environment_repo_add", environmentName: "Default", field: "repos.api" },
    ]);
  });

  it("add a Repo to the Environment id names, into the directory name gives", async () => {
    const { tool, held } = await setUp();

    await run(tool("environment_repo_add"), {
      id: "0000abcd",
      url: "o/api",
      name: "backend",
      reason: "r",
    });

    expect(held.get("0000abcd")?.repos).toEqual([
      { name: "backend", url: "https://github.com/o/api.git" },
    ]);
  });

  it("refuse a directory another Repo has, and leave one with the same address alone", async () => {
    const { tool, logged } = await setUp();

    expect(
      await failure(
        run(tool("environment_repo_add"), { id: "default", url: "x/app", reason: "r" }),
      ),
    ).toBe("Nothing was saved: The environment already has a repo in app: name this one");

    const again = await run(tool("environment_repo_add"), {
      id: "default",
      url: "o/app",
      reason: "r",
    });

    expect(text(again)).toContain("has that repo already");
    expect(logged).toEqual([]);
  });

  it("remove a Repo and say that no Workspace loses its clone", async () => {
    const { tool, held, logged } = await setUp();

    const result = await run(tool("environment_repo_remove"), {
      id: "default",
      name: "app",
      reason: "Moved",
    });

    expect(held.get("default")?.repos).toEqual([]);
    expect(text(result)).toContain("Took the repo app (https://github.com/o/app.git) out of");
    expect(text(result)).toContain("no Workspace a Session has gets a clone or loses one");
    expect(text(result)).toContain("A new Workspace made from the Environment does not get");
    expect(result.details).toMatchObject({
      agentChange: { field: "repos.app", before: "https://github.com/o/app.git", after: null },
    });
    expect(logged).toHaveLength(1);
  });

  it("refuse a Repo the Environment does not have, passing on the Registry's words", async () => {
    const { tool, logged } = await setUp();

    expect(
      await failure(
        run(tool("environment_repo_remove"), { id: "default", name: "ghost", reason: "r" }),
      ),
    ).toBe('Nothing was saved: The environment has no repo "ghost"');
    expect(logged).toEqual([]);
  });
});

describe("environment_rebuild", () => {
  it("asks for a Build and says it is under way", async () => {
    const { tool, logged } = await setUp();

    const result = await run(tool("environment_rebuild"), {
      id: "default",
      reason: "The base image moved",
    });

    expect(text(result)).toContain("the Build is under way");
    expect(text(result)).toContain("environment_get");
    expect(result.details).toMatchObject({
      agentChange: { field: "build", before: null, after: "asked for" },
    });
    expect(logged).toEqual([
      { tool: "environment_rebuild", environmentName: "Default", field: "build" },
    ]);
  });

  it("says a Build is under way already, and records nothing a second time", async () => {
    const { tool, logged } = await setUp();

    await run(tool("environment_rebuild"), { id: "default", reason: "The base image moved" });

    const again = await run(tool("environment_rebuild"), {
      id: "default",
      reason: "Once more",
    });

    expect(text(again)).toContain("is already under way");
    expect(text(again)).toContain("nothing was recorded");
    expect(again.details).toMatchObject({ unchanged: { environment: { id: "default" } } });
    expect(logged).toHaveLength(1);
  });

  it("refuses an Environment with nothing to build, saying why, and records nothing", async () => {
    const { tool, logged } = await setUp();

    expect(
      await failure(run(tool("environment_rebuild"), { id: "0000abcd", reason: "r" })),
    ).toContain("there is nothing to build");
    expect(logged).toEqual([]);
  });

  it("asks for nothing again when the call is run again after an eviction", async () => {
    const { tool, calls, logged } = await setUp();
    const api = callApi(4);

    await run(tool("environment_rebuild"), { id: "default", reason: "The base image moved" }, api);

    const rerun = await run(
      tool("environment_rebuild"),
      { id: "default", reason: "The base image moved" },
      api,
    );

    expect(text(rerun)).toContain("asks for nothing again");
    expect(Arr.filter(calls, (call) => call.op === "rebuild")).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });
});

describe("environment_rebuild with proposed changes (a Test Build)", () => {
  it("makes a Test Build of them, waits for it, and says how long it took and which tools save them, recording nothing", async () => {
    const { tool, testBuilds, tests, calls, logged } = await setUp();

    tests.rounds = [
      { status: "building", startedAt: 1_000 },
      { status: "building", startedAt: 1_000 },
      { status: "succeeded", startedAt: 1_000, finishedAt: 151_000 },
    ];

    const result = await run(
      tool("environment_rebuild"),
      {
        id: "default",
        reason: "Check the Postgres client installs",
        proposed: { setup_script: "apt-get install -y postgresql-client", variables: { CI: "1" } },
      },
      callApi(7),
    );

    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain(
      'The Test Build of Environment "Default" (default) with the proposed variables, setup_script succeeded in 2 min 30 s',
    );
    expect(text(result)).toContain("Nothing was saved or recorded");
    expect(text(result)).toContain("setup_script: environment_setup_script_set");
    expect(text(result)).toContain(
      "variables: environment_variable_set and environment_variable_unset",
    );
    expect(result.details).toEqual({
      testBuild: {
        environment: { id: "default", name: "Default" },
        status: "succeeded",
        tookMs: 150_000,
        proposed: ["variables", "setup_script"],
      },
    });
    expect(testBuilds.get("7")).toMatchObject({
      environment: "default",
      proposed: { setupScript: "apt-get install -y postgresql-client", variables: { CI: "1" } },
    });
    expect(tests.roundsAsked).toBe(3);
    // Not an Agent change: nothing is recorded, nor in the Run's Notification.
    expect(calls).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("fails with the failing step and the end of its output", async () => {
    const { tool, tests } = await setUp();

    tests.rounds = [
      {
        status: "failed",
        startedAt: 1_000,
        finishedAt: 41_000,
        reason: "The environment's Setup Script failed (exit 1): apt: not found",
      },
    ];

    const message = await failure(
      run(tool("environment_rebuild"), {
        id: "default",
        reason: "r",
        proposed: { setup_script: "exit 1" },
      }),
    );

    expect(message).toContain(
      "with the proposed setup_script failed after 40 s: The environment's Setup Script failed (exit 1): apt: not found",
    );
    expect(message).toContain("Nothing was saved");
  });

  it("waits for the same Test Build when the call is run again after an eviction", async () => {
    const { tool, tests } = await setUp();

    tests.hold = true;

    const controller = new AbortController();
    const memos = new Map<string, unknown>();

    // The first run is cut off while it waits (the eviction runs no finalizer: here, its wait is left hanging).
    void run(
      tool("environment_rebuild"),
      { id: "default", reason: "r", proposed: { toolchains: '[tools]\nnode = "22"\n' } },
      callApi(9, memos),
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(tests.starts).toBe(1);
    });

    tests.hold = false;

    const rerun = await run(
      tool("environment_rebuild"),
      { id: "default", reason: "r", proposed: { toolchains: '[tools]\nnode = "22"\n' } },
      callApi(9, memos),
    );

    expect(text(rerun)).toContain(
      'The Test Build of Environment "Default" (default) with the proposed toolchains succeeded',
    );
    expect(tests.starts).toBe(1);
    expect(tests.cancelled).toEqual([]);
    controller.abort();
  });

  it("says so when the rerun after an eviction finds its Test Build gone", async () => {
    const { tool, tests } = await setUp();

    tests.hold = true;

    const controller = new AbortController();
    const memos = new Map<string, unknown>();

    void run(
      tool("environment_rebuild"),
      { id: "default", reason: "r", proposed: { setup_script: "make" } },
      callApi(9, memos),
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(tests.starts).toBe(1);
    });

    tests.hold = false;
    tests.rounds = [{ status: "gone" }];

    const message = await failure(
      run(
        tool("environment_rebuild"),
        { id: "default", reason: "r", proposed: { setup_script: "make" } },
        callApi(9, memos),
      ),
    );

    expect(message).toContain(
      'The Test Build of Environment "Default" (default) is no longer known',
    );
    expect(tests.starts).toBe(1);
    controller.abort();
  });

  it("cancels the Test Build when the call is stopped", async () => {
    const { tool, tests, testBuilds } = await setUp();

    tests.hold = true;

    const controller = new AbortController();

    const stopped = run(
      tool("environment_rebuild"),
      { id: "default", reason: "r", proposed: { setup_script: "sleep 600" } },
      callApi(11),
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    ).catch(() => undefined);

    await vi.waitFor(() => {
      expect(tests.starts).toBe(1);
    });
    controller.abort();
    await stopped;

    await vi.waitFor(() => {
      expect(tests.cancelled).toEqual(["11"]);
    });
    expect(testBuilds.get("11")?.progress.status).toBe("cancelled");
  });

  it("is refused while another Test Build of the Environment runs, saying so", async () => {
    const { tool, tests } = await setUp();

    tests.hold = true;

    const controller = new AbortController();

    void run(
      tool("environment_rebuild"),
      { id: "default", reason: "r", proposed: {} },
      callApi(1),
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    ).catch(() => undefined);
    await vi.waitFor(() => {
      expect(tests.starts).toBe(1);
    });

    expect(
      await failure(
        run(tool("environment_rebuild"), { id: "default", reason: "r", proposed: {} }, callApi(2)),
      ),
    ).toBe(
      "Nothing was built: Another Test Build of the environment is under way, and one runs at a time: wait for it to end, then ask again",
    );
    controller.abort();
  });

  it("refuses proposed values the saving tools refuse, saying why", async () => {
    const { tool, tests } = await setUp();

    expect(
      await failure(
        run(tool("environment_rebuild"), {
          id: "default",
          reason: "r",
          proposed: { setup_script: "a\u0000b" },
        }),
      ),
    ).toContain("Nothing was built: The proposed settings are refused: setupScript");
    expect(tests.starts).toBe(0);
  });

  it("refuses a proposal that holds a Secret's value or the GitHub token, building nothing", async () => {
    const { tool, tests } = await setUp({ NPM_TOKEN: "npm_0123456789abcdef" });

    expect(
      await failure(
        run(tool("environment_rebuild"), {
          id: "default",
          reason: "r",
          proposed: { variables: { NPM_TOKEN: "npm_0123456789abcdef" } },
        }),
      ),
    ).toContain("Nothing was built: the value of NPM_TOKEN holds the value of a Secret");
    expect(
      await failure(
        run(tool("environment_rebuild"), {
          id: "default",
          reason: "r",
          proposed: { setup_script: `git clone https://${GITHUB_TOKEN}@github.com/o/x` },
        }),
      ),
    ).toContain("Nothing was built: the Setup Script holds");
    expect(tests.starts).toBe(0);
  });

  it("does not take what a Build does not use: the Start Script, the size, the idle time", async () => {
    const { tool, tests } = await setUp();

    for (const proposed of [{ start_script: "x" }, { size: "cpu-2" }, { idle_minutes: 5 }]) {
      expect(
        (await run(tool("environment_rebuild"), { id: "default", reason: "r", proposed })).isError,
      ).toBe(true);
    }

    expect(tests.starts).toBe(0);
  });

  it("refuses an unknown Environment, pointing to environment_list", async () => {
    const { tool } = await setUp();

    expect(
      await failure(
        run(tool("environment_rebuild"), { id: "0000beef", reason: "r", proposed: {} }),
      ),
    ).toContain("environment_list");
  });
});
