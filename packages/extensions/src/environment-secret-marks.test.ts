// The `environment` extension's tool for the Build mark of a kept Secret (docs/spec.md → Agent changes):
// `environment_secret_build`, over fake kept Secrets that apply a mark as the Registry does.
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
import { Approvals } from "./approvals.ts";
import { unusedApprovals } from "./approvals.fixture.ts";
import { unusedLifecycle } from "./environment-lifecycle.fixture.ts";
import { fakeSecretMarks, type KeptMark } from "./environment-secret-marks.fixture.ts";
import { unusedSkills } from "./environment-skills.fixture.ts";
import { Redactions } from "./secrets/redaction.ts";
import { secretEnvName } from "./secrets/references.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";
import { DEFAULT_TOOLSETS } from "./subagents.ts";
import { resolveTools } from "./subagents/toolsets.ts";

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";

const setUp = async (held: Readonly<Record<string, string>> = {}) => {
  const marks = fakeSecretMarks();
  const logged: RunChange[] = [];
  const redactions = new Redactions();

  for (const [name, value] of Record.toEntries(held)) redactions.hold(name, value);

  // SAFETY: the tools use only `refresh` and `redact` of the Secrets.
  const secrets = {
    refresh: Effect.void,
    redact: (value: string) => redactions.redact(value),
  } as SecretsService;

  const environments: EnvironmentsService = {
    ...unusedLifecycle,
    ...marks.service,
    ...unusedSkills,
    current: Effect.succeed("default"),
    list: Effect.succeed([]),
    get: () => Effect.succeed(null),
    every: Effect.succeed({ variables: {}, secrets: [], skills: [] }),
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

  return { tool, logged, ...marks };
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

/** Whether the fake's Secret `name` is marked for the Build. */
const markOf = (kept: ReadonlyArray<KeptMark>, name: string): boolean | undefined =>
  Option.getOrUndefined(
    Option.map(
      Arr.findFirst(kept, (each) => each.name === name),
      (each) => each.build,
    ),
  );

const failure = async (call: Promise<Result>) => {
  const result = await call;

  expect(result.isError).toBe(true);

  return text(result);
};

describe("environment_secret_build", () => {
  it("runs alone, is kept from a rerun after an eviction, and is the root conversation's only", async () => {
    const { tool } = await setUp();

    expect(tool("environment_secret_build").replay).toBe("unsafe");
    expect(tool("environment_secret_build").executionMode).toBe("sequential");

    const ceiling = ["bash", "environment_secret_build"];

    expect(resolveTools(undefined, ceiling, DEFAULT_TOOLSETS)).toMatchObject({
      success: { tools: ["bash"] },
    });
  });

  it("says that a Secret marked for the Build reaches every Setup Script of the Environment", async () => {
    const { tool } = await setUp();
    const description = tool("environment_secret_build").description;

    expect(description).toContain("every Setup Script of the Environment");
    expect(description).toContain("Build");
    expect(description).toContain('id "*"');
  });

  it("marks a Secret kept for the Environment, recording the mark before and after", async () => {
    const { tool, logged, kept, calls } = await setUp();

    const result = await run(tool("environment_secret_build"), {
      name: "API_KEY",
      build: false,
      reason: "No script needs it any more",
    });

    expect(text(result)).toContain("was marked for the Build and is not marked now");
    expect(markOf(kept, "API_KEY")).toBe(false);
    expect(calls).toEqual([
      { environment: "default", name: "API_KEY", build: false, tool: "environment_secret_build" },
    ]);
    expect(result.details).toMatchObject({
      agentChange: {
        environment: { id: "default", name: "Default" },
        field: "secrets.API_KEY.build",
        before: true,
        after: false,
      },
    });
    expect(logged).toEqual([
      {
        tool: "environment_secret_build",
        environmentName: "Default",
        field: "secrets.API_KEY.build",
      },
    ]);
  });

  it("addresses a Secret kept for every Environment with id *", async () => {
    const { tool, logged, kept } = await setUp();

    const result = await run(tool("environment_secret_build"), {
      id: "*",
      name: "NPM_TOKEN",
      build: true,
      reason: "The Setup Script installs from the private registry",
    });

    expect(text(result)).toContain("kept for every Environment");
    expect(text(result)).toContain(`$${secretEnvName("NPM_TOKEN")}`);
    expect(markOf(kept, "NPM_TOKEN")).toBe(true);
    expect(result.details).toMatchObject({
      agentChange: { environment: { id: "*", name: "every Environment" }, after: true },
    });
    expect(logged).toEqual([
      {
        tool: "environment_secret_build",
        environmentName: "every Environment",
        field: "secrets.NPM_TOKEN.build",
      },
    ]);
  });

  it("changes nothing and records nothing for a Secret that has the mark already", async () => {
    const { tool, logged, calls } = await setUp();

    const result = await run(tool("environment_secret_build"), {
      name: "API_KEY",
      build: true,
      reason: "r",
    });

    expect(text(result)).toContain("is marked for the Build already: nothing changed");
    expect(calls).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("refuses a Secret that is not kept there, pointing to id * and to secret_ask", async () => {
    const { tool, logged } = await setUp();

    const message = await failure(
      run(tool("environment_secret_build"), { name: "NPM_TOKEN", build: true, reason: "r" }),
    );

    expect(message).toContain("no Secret NPM_TOKEN is kept for Environment");
    expect(message).toContain('id "*"');
    expect(message).toContain("secret_ask");
    expect(logged).toEqual([]);
  });

  it("refuses an unknown Environment, pointing to environment_list", async () => {
    const { tool } = await setUp();

    expect(
      await failure(
        run(tool("environment_secret_build"), {
          id: "ffff0000",
          name: "API_KEY",
          build: true,
          reason: "r",
        }),
      ),
    ).toContain("environment_list");
  });

  it("refuses a reason that holds a Secret's value or the GitHub token, saving nothing", async () => {
    const { tool, logged, calls } = await setUp({ API_KEY: "sk-live-abcdefghijkl" });

    for (const reason of ["because sk-live-abcdefghijkl", `token ${GITHUB_TOKEN}`]) {
      expect(
        await failure(
          run(tool("environment_secret_build"), { name: "API_KEY", build: false, reason }),
        ),
      ).toContain("the reason holds");
    }

    expect(calls).toEqual([]);
    expect(logged).toEqual([]);
  });
});
