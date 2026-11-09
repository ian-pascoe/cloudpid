// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The real Registry's wiring of an endpoint-authored write (`registry.fixture.ts` runs `registryMethods` as deployed):
// the change requests and the features it answers, and, in each family of write, the refusal of a text that holds a kept
// Secret with nothing recorded, while a Session's author passes unchecked.
import { DEFAULT_ENVIRONMENT, variableField } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import type { AgentChangeAuthor } from "./agent-changes.ts";
import type { ChangeClaim } from "./change-requests.ts";
import type { RealRegistry } from "./registry.fixture.ts";
import { HOLDS_SECRET, type KeptTexts } from "./via-secrets.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly REAL_REGISTRIES: DurableObjectNamespace<RealRegistry>;
    }
  }
}

const VALUE = "sk-live-0123456789abcdef";

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

/** An endpoint author whose reason holds the Secret: the one text a write without free text can be refused for. */
const holding = (tool: string): AgentChangeAuthor => ({
  ...endpoint(tool),
  reason: `Because ${VALUE} is the key`,
});

/** A fresh real Registry with the Secret `API_KEY` kept for the default Environment. */
const started = async () => {
  const stub = env.REAL_REGISTRIES.get(env.REAL_REGISTRIES.newUniqueId());

  const call = async (method: string, input?: KeptTexts) =>
    runInDurableObject(stub, (registry: RealRegistry) => registry.call(method, input));

  await call("setEnvironmentSecret", {
    environment: DEFAULT_ENVIRONMENT,
    name: "API_KEY",
    value: VALUE,
  });

  return {
    call,
    /** The Agent changes of `environment`, as the owner's list shows them. */
    changesOf: async (environment: string) => call("listAgentChanges", { environment }),
  };
};

/** The id of the Workspace a registered Session was made in. */
const workspaceOf = (created: KeptTexts): string => {
  if (
    Predicate.isObject(created) &&
    !Array.isArray(created) &&
    Predicate.isString(created.workspace)
  ) {
    return created.workspace;
  }

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
    expect(await call("listEnvironmentSecrets")).toMatchObject([{ name: "API_KEY", build: false }]);
  });

  it("refuses a Trigger's message, an Environment trigger's and a Workspace trigger's, making none", async () => {
    const { call, changesOf } = await started();

    const created = await call("createSession", {
      workspace: { kind: "new", environment: DEFAULT_ENVIRONMENT },
    });

    const base = {
      name: "Nightly check",
      message: `Use ${VALUE} to check.`,
      source: { type: "schedule", cron: "@daily", zone: "UTC" },
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
