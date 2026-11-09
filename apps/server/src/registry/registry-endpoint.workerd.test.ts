// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The real Registry's wiring of an endpoint-authored write (`registry.fixture.ts` runs `registryMethods` as deployed):
// the change requests and the features it answers, and, in each family of write, the refusal of a text that holds a kept
// Secret with nothing recorded, while a Session's author passes unchecked.
import { DEFAULT_ENVIRONMENT, variableField } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AgentChangeAuthor } from "./agent-changes.ts";
import type { ChangeClaim } from "./change-requests.ts";
import type { RegistryMethods } from "./Registry.ts";
import type { RealRegistry } from "./registry.fixture.ts";
import { HOLDS_SECRET } from "./via-secrets.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REAL_REGISTRIES: DurableObjectNamespace<RealRegistry>;
    }
  }
}

const VALUE = "sk-live-0123456789abcdef";
const GLOBAL_VALUE = "global-secret-value-4321";

const endpoint = (tool: string, request?: ChangeClaim): AgentChangeAuthor => ({
  via: { auth: "oauth", client: { name: "pi" } },
  tool,
  reason: "The tests need it",
  request,
});

const session = (tool: string): AgentChangeAuthor => ({
  session: "s-1",
  conversation: 1,
  tool,
  reason: "The tests need it",
});

/** An endpoint author whose reason holds `value`: the one text a write without free text can be refused for. */
const holding = (tool: string, value = VALUE): AgentChangeAuthor => ({
  ...endpoint(tool),
  reason: `Because ${value} is the key`,
});

/** A fresh real Registry with the Secret `API_KEY` kept for the default Environment, and `GLOBAL_KEY` kept Global. */
const started = async () => {
  const stub = env.REAL_REGISTRIES.get(env.REAL_REGISTRIES.newUniqueId());

  const call = async <K extends keyof RegistryMethods>(
    method: K,
    ...input: Parameters<RegistryMethods[K]>
  ) => runInDurableObject(stub, (registry: RealRegistry) => registry.call(method, ...input));

  await call("setEnvironmentSecret", {
    environment: DEFAULT_ENVIRONMENT,
    name: "API_KEY",
    value: VALUE,
  });

  await call("setEnvironmentSecret", {
    environment: null,
    name: "GLOBAL_KEY",
    value: GLOBAL_VALUE,
  });

  return {
    call,
    /** The Agent changes of `environment`, as the owner's list shows them. */
    changesOf: async (environment: string) => call("listAgentChanges", { environment }),
  };
};

/** The id of the Workspace a Session of the default Environment is registered in. */
const workspaceOf = (created: Awaited<ReturnType<RealRegistry["call"]>>): string => {
  if (created !== null && "workspace" in created) return created.workspace;

  throw new Error("No Session was registered");
};

const refused = { status: "rejected", message: HOLDS_SECRET };

describe("the real Registry's features", () => {
  it("answers that it records an endpoint's via", async () => {
    const { call } = await started();

    expect(await call("agentChangeFeatures")).toEqual({ via: true });
  });
});

describe("the real Registry's change requests", () => {
  const claim = { id: "req-1", tool: "environment_variable_set", digest: "d-1", attempt: "a-1" };

  const setVariable = {
    environment: DEFAULT_ENVIRONMENT,
    change: { field: variableField("A"), value: "1" },
  };

  it("claims a request_id with the write that records, answers its lookup, and settles it once", async () => {
    const { call } = await started();

    expect(await call("changeRequest", { id: "req-1" })).toBeNull();

    const made = await call("changeEnvironment", {
      ...setVariable,
      author: endpoint("environment_variable_set", claim),
    });

    expect(made).toMatchObject({ status: "changed", change: { id: 1, via: { auth: "oauth" } } });

    const found = await call("changeRequest", { id: "req-1" });

    expect(found).toMatchObject({
      tool: "environment_variable_set",
      digest: "d-1",
      attempt: "a-1",
      answer: null,
      changes: [{ id: 1, scopeName: "Default", field: "variables.A" }],
    });

    const answer = { text: "Done.", structured: { scope: "Default" } };

    expect(await call("settleChangeRequest", { id: "req-1", attempt: "a-2", answer })).toBe(false);
    expect(await call("settleChangeRequest", { id: "req-1", attempt: "a-1", answer })).toBe(true);
    expect(await call("changeRequest", { id: "req-1" })).toMatchObject({ answer });
  });
});

describe("the real Registry's check of an endpoint's write", () => {
  it("refuses a Container setting of an Environment that holds a kept Secret, recording nothing", async () => {
    const { call, changesOf } = await started();

    const outcome = await call("changeEnvironment", {
      environment: DEFAULT_ENVIRONMENT,
      change: { field: variableField("A"), value: VALUE },
      author: endpoint("environment_variable_set"),
    });

    expect(outcome).toEqual(refused);
    expect(await changesOf(DEFAULT_ENVIRONMENT)).toEqual([]);
  });

  it("refuses a Container setting at Global, which reaches every Scope's Secrets", async () => {
    const { call, changesOf } = await started();

    // `API_KEY` is the default Environment's own: only a write at `*` reaches every Scope.
    const outcome = await call("changeGlobal", {
      change: { field: variableField("A"), value: VALUE },
      author: endpoint("global_variable_set"),
    });

    expect(outcome).toEqual(refused);
    expect(await changesOf("*")).toEqual([]);
  });

  it("refuses a Setting at Global and a Setting Override of an Environment", async () => {
    const { call, changesOf } = await started();

    const atGlobal = await call("changeSettings", {
      changes: [{ field: "model", value: VALUE }],
      author: endpoint("settings_model_set"),
    });

    const atEnvironment = await call("changeSettings", {
      environment: DEFAULT_ENVIRONMENT,
      changes: [{ field: "model", value: VALUE }],
      author: endpoint("settings_model_set"),
    });

    expect(atGlobal).toEqual(refused);
    expect(atEnvironment).toEqual(refused);
    expect(await call("listSettingsChanges")).toEqual([]);
    expect(await changesOf(DEFAULT_ENVIRONMENT)).toEqual([]);
  });

  it("refuses a Build mark and a deletion of a Secret, which stay as they were", async () => {
    const { call, changesOf } = await started();

    const mark = await call("agentMarkSecretBuild", {
      environment: DEFAULT_ENVIRONMENT,
      name: "API_KEY",
      build: true,
      author: holding("environment_secret_build"),
    });

    const deletion = await call("agentDeleteSecret", {
      environment: DEFAULT_ENVIRONMENT,
      name: "API_KEY",
      author: { ...holding("environment_secret_delete"), approved: true },
    });

    expect(mark).toEqual(refused);
    expect(deletion).toEqual(refused);
    expect(await changesOf(DEFAULT_ENVIRONMENT)).toEqual([]);
    expect(await call("listEnvironmentSecrets")).toMatchObject([
      { name: "GLOBAL_KEY" },
      { name: "API_KEY", build: false },
    ]);
  });

  it("refuses a Trigger's message, an Environment trigger's and a Workspace trigger's, making none", async () => {
    const { call, changesOf } = await started();

    const created = await call("createSession", {
      workspace: { kind: "new", environment: DEFAULT_ENVIRONMENT },
    });

    const base = {
      name: "Nightly check",
      message: `Use ${VALUE} to check.`,
      source: { type: "schedule", cron: "@daily", zone: "UTC" } as const,
    };

    const inEnvironment = await call("agentCreateTrigger", {
      id: "t1",
      trigger: { kind: "environment", environment: DEFAULT_ENVIRONMENT, ...base },
      author: endpoint("trigger_create"),
    });

    // The Secret is the default Environment's: a Workspace trigger reaches it through its Workspace's Environment.
    const inWorkspace = await call("agentCreateTrigger", {
      id: "t2",
      trigger: { kind: "workspace", workspace: workspaceOf(created), ...base },
      author: endpoint("trigger_create"),
    });

    expect(inEnvironment).toMatchObject({ status: "invalid", problem: HOLDS_SECRET });
    expect(inWorkspace).toMatchObject({ status: "invalid", problem: HOLDS_SECRET });
    expect(await call("listTriggers", { environment: DEFAULT_ENVIRONMENT })).toEqual([]);
    expect(await changesOf(DEFAULT_ENVIRONMENT)).toEqual([]);
  });

  it("refuses a Skill saved with a file that holds a kept Secret", async () => {
    const { call, changesOf } = await started();

    const outcome = await call("agentSaveSkill", {
      environment: DEFAULT_ENVIRONMENT,
      folder: "deploy",
      files: { "SKILL.md": `---\nname: deploy\ndescription: Deploy\n---\nUse ${VALUE}.\n` },
      author: endpoint("skill_save"),
    });

    expect(outcome).toEqual(refused);
    expect(await call("listSkills", { environment: DEFAULT_ENVIRONMENT })).toEqual([]);
    expect(await changesOf(DEFAULT_ENVIRONMENT)).toEqual([]);
  });

  it("refuses a new Environment whose name holds a Secret kept Global, which a new Environment reaches", async () => {
    const { call } = await started();

    const outcome = await call("agentCreateEnvironment", {
      name: `Prod ${GLOBAL_VALUE}`,
      repos: [],
      author: endpoint("environment_create"),
    });

    expect(outcome).toEqual(refused);
    expect(await call("listEnvironments")).toMatchObject([{ id: DEFAULT_ENVIRONMENT }]);
  });

  it("does not check a new Environment against another Environment's Secret", async () => {
    const { call } = await started();

    // `API_KEY` is the default Environment's own: a new Environment has none of its own and reaches only Global's.
    const outcome = await call("agentCreateEnvironment", {
      name: `Prod ${VALUE}`,
      repos: [],
      author: endpoint("environment_create"),
    });

    expect(outcome).not.toEqual(refused);
  });

  it("refuses the rename of an existing Environment to a name that holds a Secret", async () => {
    const { call, changesOf } = await started();

    const outcome = await call("agentRenameEnvironment", {
      environment: DEFAULT_ENVIRONMENT,
      name: `Prod ${VALUE}`,
      author: endpoint("environment_rename"),
    });

    expect(outcome).toEqual(refused);
    expect(await call("getEnvironment", { id: DEFAULT_ENVIRONMENT })).toMatchObject({
      name: "Default",
    });
    expect(await changesOf(DEFAULT_ENVIRONMENT)).toEqual([]);
  });

  it("refuses the removal of a Skill by an author whose reason holds a Secret, leaving it kept", async () => {
    const { call, changesOf } = await started();

    const files = { "SKILL.md": "---\nname: deploy\ndescription: Deploy\n---\nShip it.\n" };

    await call("agentSaveSkill", {
      environment: DEFAULT_ENVIRONMENT,
      folder: "deploy",
      files,
      author: session("skill_save"),
    });

    const outcome = await call("agentRemoveSkill", {
      environment: DEFAULT_ENVIRONMENT,
      name: "deploy",
      author: holding("skill_remove"),
    });

    expect(outcome).toEqual(refused);
    expect(await call("listSkills", { environment: DEFAULT_ENVIRONMENT })).toMatchObject([
      { name: "deploy" },
    ]);
    expect(await changesOf(DEFAULT_ENVIRONMENT)).toMatchObject([{ session: "s-1" }]);
  });

  it("refuses the update of a Trigger to a message that holds a Secret, leaving it as it was", async () => {
    const { call } = await started();

    await call("agentCreateTrigger", {
      id: "t1",
      trigger: {
        kind: "environment",
        environment: DEFAULT_ENVIRONMENT,
        name: "Weekly report",
        message: "Summarize last week.",
        source: { type: "schedule", cron: "0 9 * * MON", zone: "UTC" },
      },
      author: session("trigger_create"),
    });

    const outcome = await call("agentUpdateTrigger", {
      id: "t1",
      patch: { message: `Use ${VALUE}.` },
      author: endpoint("trigger_update"),
    });

    expect(outcome).toMatchObject({ status: "invalid", problem: HOLDS_SECRET });
    expect(await call("listTriggers", { environment: DEFAULT_ENVIRONMENT })).toMatchObject([
      { id: "t1", message: "Summarize last week.", revision: 1 },
    ]);
  });

  it("makes the same write for a Session, which is never checked", async () => {
    const { call, changesOf } = await started();

    const outcome = await call("changeEnvironment", {
      environment: DEFAULT_ENVIRONMENT,
      change: { field: variableField("A"), value: VALUE },
      author: session("environment_variable_set"),
    });

    expect(outcome).toMatchObject({ status: "changed" });
    expect(await changesOf(DEFAULT_ENVIRONMENT)).toMatchObject([{ session: "s-1" }]);
  });

  it("does not refuse a write for a Secret in what it replaces", async () => {
    const { call } = await started();

    // A Session set the variable to the Secret's value (never checked); the endpoint replaces it, expecting that value.
    await call("changeEnvironment", {
      environment: DEFAULT_ENVIRONMENT,
      change: { field: variableField("A"), value: VALUE },
      author: session("environment_variable_set"),
    });

    const outcome = await call("changeEnvironment", {
      environment: DEFAULT_ENVIRONMENT,
      change: { field: variableField("A"), value: "2" },
      expected: { value: VALUE },
      author: endpoint("environment_variable_set"),
    });

    expect(outcome).toMatchObject({ status: "changed", change: { via: { auth: "oauth" } } });
  });
});
