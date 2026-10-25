// The `environment` extension's tools for an Environment's record (docs/spec.md → Agent changes): making an Environment,
// renaming it, adding and removing Repos, asking for a Build. Over fake Environments that apply each as the Registry does.
// @effect-diagnostics asyncFunction:off
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
import { describe, expect, it } from "vitest";
import {
  AgentChangeLog,
  DeployCredentials,
  Environments,
  type EnvironmentsService,
  EnvironmentTools,
  type RunChange,
} from "./environment.ts";
import { fakeLifecycle } from "./environment-lifecycle.fixture.ts";
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
    current: Effect.succeed("default"),
    list: Effect.succeed([]),
    get: () => Effect.succeed(null),
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
    ),
  );

  const tool = (name: string): ToolRegistration =>
    Option.getOrThrowWith(
      Arr.findFirst(extension.tools ?? [], (each) => each.name === name),
      () => new Error(`no tool ${name}`),
    );

  return { tool, logged, ...lifecycle };
};

// SAFETY: the tools read only the calling conversation from the invocation's API.
const api = { conversationId: ROOT_CONVERSATION_ID } as ToolExecutionApi;

type Result = Awaited<ReturnType<ToolRegistration["execute"]>>;

const run = (tool: ToolRegistration, args: Readonly<Record<string, unknown>>): Promise<Result> =>
  // SAFETY: the arguments are the tool's JSON parameters.
  tool.execute(args as never, api, BACKGROUND_CONTEXT);

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
  it("are five, each run alone and kept from a rerun after an eviction", async () => {
    const { tool } = await setUp();

    for (const name of [
      "environment_create",
      "environment_rename",
      "environment_repo_add",
      "environment_repo_remove",
      "environment_rebuild",
    ]) {
      expect(tool(name).replay).toBe("unsafe");
      expect(tool(name).executionMode).toBe("sequential");
    }
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
  it("renames this Session's Environment by default and records the names before and after", async () => {
    const { tool, held, logged } = await setUp();

    const result = await run(tool("environment_rename"), { name: "Main", reason: "Clearer" });

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

    expect(await failure(run(tool("environment_rename"), { name: "other", reason: "r" }))).toBe(
      'Nothing was saved: Another environment is already named "other"',
    );
    expect(logged).toEqual([]);
  });

  it("says so of the name it has already, and records nothing", async () => {
    const { tool, logged } = await setUp();
    const result = await run(tool("environment_rename"), { name: "Default", reason: "r" });

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

    expect(await failure(run(tool("environment_repo_add"), { url: "x/app", reason: "r" }))).toBe(
      "Nothing was saved: The environment already has a repo in app: name this one",
    );

    const again = await run(tool("environment_repo_add"), { url: "o/app", reason: "r" });

    expect(text(again)).toContain("has that repo already");
    expect(logged).toEqual([]);
  });

  it("remove a Repo and say that no Workspace loses its clone", async () => {
    const { tool, held, logged } = await setUp();
    const result = await run(tool("environment_repo_remove"), { name: "app", reason: "Moved" });

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
      await failure(run(tool("environment_repo_remove"), { name: "ghost", reason: "r" })),
    ).toBe('Nothing was saved: The environment has no repo "ghost"');
    expect(logged).toEqual([]);
  });
});

describe("environment_rebuild", () => {
  it("asks for a Build and says it is under way", async () => {
    const { tool, logged } = await setUp();
    const result = await run(tool("environment_rebuild"), { reason: "The base image moved" });

    expect(text(result)).toContain("the Build is under way");
    expect(text(result)).toContain("environment_get");
    expect(result.details).toMatchObject({
      agentChange: { field: "build", before: null, after: "asked for" },
    });
    expect(logged).toEqual([
      { tool: "environment_rebuild", environmentName: "Default", field: "build" },
    ]);
  });

  it("refuses an Environment with nothing to build, saying why, and records nothing", async () => {
    const { tool, logged } = await setUp();

    expect(
      await failure(run(tool("environment_rebuild"), { id: "0000abcd", reason: "r" })),
    ).toContain("there is nothing to build");
    expect(logged).toEqual([]);
  });
});
