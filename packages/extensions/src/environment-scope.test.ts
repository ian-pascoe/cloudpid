// The `environment` extension's Scope (docs/architecture/agent-changes.md → The Scope is named; ADR-0027 → The agent names
// the Scope): every tool that reads or changes an Environment or a setting kept at a Scope requires `id`, and the
// Session's own Environment is never assumed. The Approval tools (`environment_container_size_limit_set`,
// `environment_delete`, `environment_secret_delete`) are covered in approval-tools.test.ts. The fake Environments fail
// on any use, so a call that got past its arguments would show.
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
import { unusedApprovals } from "./approvals.fixture.ts";
import { Approvals } from "./approvals.ts";
import {
  AgentChangeLog,
  DeployCredentials,
  Environments,
  type EnvironmentsService,
  EnvironmentTools,
} from "./environment.ts";
import { unusedLifecycle } from "./environment-lifecycle.fixture.ts";
import { unusedSecretMarks } from "./environment-secret-marks.fixture.ts";
import { unusedSkills } from "./environment-skills.fixture.ts";
import { Secrets, type SecretsService } from "./secrets/store.ts";

/** Environments that die on any use: no tool reaches them without an `id` to name an Environment. */
const unusedEnvironments: EnvironmentsService = {
  ...unusedLifecycle,
  ...unusedSecretMarks,
  ...unusedSkills,
  current: Effect.succeed("default"),
  list: Effect.die("list is not used here"),
  get: () => Effect.die("get is not used here"),
  global: Effect.die("global is not used here"),
  change: () => Effect.die("change is not used here"),
};

// SAFETY: a call that gets past its arguments reaches only the Environments above; Secrets are not read.
const unusedSecrets = {} as SecretsService;

const extension = await Effect.runPromise(
  EnvironmentTools.pipe(
    Effect.provideService(Environments, unusedEnvironments),
    Effect.provideService(AgentChangeLog, { record: () => Effect.void }),
    Effect.provideService(DeployCredentials, { values: [] }),
    Effect.provideService(Secrets, unusedSecrets),
    Effect.provideService(Approvals, unusedApprovals),
  ),
);

const tool = (name: string): ToolRegistration =>
  Option.getOrThrowWith(
    Arr.findFirst(extension.tools ?? [], (each) => each.name === name),
    () => new Error(`no tool ${name}`),
  );

// SAFETY: the tools read only the calling conversation from the invocation's API.
const api = { conversationId: ROOT_CONVERSATION_ID } as ToolExecutionApi;

const REASON = { reason: "Needed" };

/** Every tool that takes `id`, with the rest of a valid call. */
const WITH_ID: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  environment_get: {},
  environment_variable_set: { name: "API_URL", value: "https://api.example.com", ...REASON },
  environment_variable_unset: { name: "API_URL", ...REASON },
  environment_container_resize: { size: "cpu-1", ...REASON },
  environment_idle_time_set: { minutes: 5, ...REASON },
  environment_ignore_set: { patterns: ["/data"], ...REASON },
  environment_setup_script_set: { script: "echo hi", ...REASON },
  environment_start_script_set: { script: "echo hi", ...REASON },
  environment_toolchains_set: { mise_toml: "", ...REASON },
  environment_spare_workspace_set: { enabled: true, ...REASON },
  environment_setting_reset: { setting: "instance", ...REASON },
  environment_secret_build: { name: "NPM_TOKEN", build: true, ...REASON },
  environment_skill_install: { source: "o/r", ...REASON },
  environment_skill_remove: { name: "pr", ...REASON },
  environment_skill_save: { path: "/workspace/.cloudpid/tmp/pr", ...REASON },
  environment_skill_update: { ...REASON },
  environment_rename: { name: "Main", ...REASON },
  environment_repo_add: { url: "o/app", ...REASON },
  environment_repo_remove: { name: "app", ...REASON },
  environment_rebuild: { ...REASON },
};

describe("the environment tools' Scope", () => {
  it.each(Record.keys(WITH_ID))("%s requires id in its parameters", (name) => {
    // SAFETY: the parameters are one JSON Schema object.
    const parameters = tool(name).parameters as { required?: ReadonlyArray<string> };

    expect(parameters.required).toContain("id");
  });

  it.each(Record.toEntries(WITH_ID))(
    "%s refuses a call without id, and does not assume this Session's Environment",
    async (name, args) => {
      // SAFETY: the arguments are the tool's JSON parameters.
      const result = await tool(name).execute(args as never, api, BACKGROUND_CONTEXT);

      expect(result.isError).toBe(true);

      const message = Arr.join(
        Arr.map(result.output ?? [], (part) => (part.type === "text" ? part.text : "")),
        "",
      );

      expect(message).toMatch(/\bid\b/);
      expect(message).not.toContain("is not used here");
    },
  );

  it("takes no id on environment_list and environment_create, which name no Environment", () => {
    for (const name of ["environment_list", "environment_create"]) {
      // SAFETY: the parameters are one JSON Schema object.
      const parameters = tool(name).parameters as { properties?: Record<string, unknown> };

      expect(Record.keys(parameters.properties ?? {})).not.toContain("id");
    }
  });
});
