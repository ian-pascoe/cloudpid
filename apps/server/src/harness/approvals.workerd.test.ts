// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalTimers:off newPromise:off preferEffectRecord:off globalDate:off -- a fake GitHub reader over native records, and the Registry's own Skill code run in its object at the time now.
// The Approvals asked over the MCP endpoint, end to end over the real Registry (`../registry/registry.fixture.ts` runs
// `registryMethods` as deployed; `docs/architecture/mcp-endpoint.md` → Approvals with no Session): the ask's `pending`,
// `unchanged` and refusals, its `request_id`, dedupe and cap (`./approval-ask.ts`); the apply of an approved request
// against what the owner saw, under the request's claim, its resume after a write that committed, and its second look at
// the claim after a write that made nothing (`./approval-runner.ts`); `approval_wait` and `approval_withdraw`
// (`./approval-follow.ts`); the Limit paths of both resets; and the deletes (#688 C2): an Environment's, long, which
// `approval_wait` never runs and its run renews the lease for, and a kept Secret's, against the `updatedAt` the owner
// saw, with the Builds' upkeep after it; a long apply's lease renewed after each step, given up when another run took
// it, and let go of when a step fails. A row that needs the Registry to fail (a cut wait, a check that heals) overrides
// that one method; every other call is the real Registry's.
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import {
  type AgentChangeVia,
  DEFAULT_ENVIRONMENT,
  GLOBAL_SCOPE,
  MAX_PENDING_APPROVALS,
} from "@cloudpid/protocol";
import type { ApprovalToolName } from "@cloudpid/protocol/harness-tools";
import type { ApiResult, ApprovalState, HarnessAnswer } from "@cloudpid/protocol/mcp-api";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { RepoReader } from "../github/skill-fetch.ts";
import { openAgentChanges } from "../registry/agent-changes.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { RealRegistry } from "../registry/registry.fixture.ts";
import { installSkills, previewSkillInstall } from "../registry/skill-install.ts";
import { previewSkillUpdates, updateSkills } from "../registry/skill-updates.ts";
import { openSkills, unapprovedGlobalChange } from "../registry/skills.ts";
import { openRegistryStore } from "../registry/store.ts";
import { SECRETS_CHANGED } from "../registry/via-secrets.ts";
import { askApproval } from "./approval-ask.ts";
import { approvalWait, approvalWithdraw } from "./approval-follow.ts";
import { approvalClaim, approvalRunner } from "./approval-runner.ts";
import { requestDigest } from "./dispatch.ts";
import { endpointWrites, type HarnessRegistry } from "./services.ts";

declare global {
  namespace Cloudflare {
    interface Env {
      readonly REAL_REGISTRIES: DurableObjectNamespace<RealRegistry>;
    }
  }
}

const ORIGIN = "https://cloudpid.example.com";

const PI: AgentChangeVia = { auth: "oauth", client: { name: "pi" }, clientId: "grant-1" };

/** A size the Global size limit does not have by default, above every default size. */
const LARGER = DEFAULT_CONTAINER_SETTINGS.maxInstance === "standard-4" ? "mem-12" : "standard-4";

/** A call of the real Registry's method `method` over the Durable Object `stub`, as the stub calls it. */
const callOn =
  (stub: DurableObjectStub<RealRegistry>) =>
  async <K extends keyof RegistryMethods>(method: K, ...input: Parameters<RegistryMethods[K]>) =>
    runInDurableObject(stub, (registry: RealRegistry) => registry.call(method, ...input));

type RegistryCall = ReturnType<typeof callOn>;

/** The methods a row puts in place of the real Registry's, over its `call` (and its Durable Object, to run code in it). */
type Overrides = (
  call: RegistryCall,
  stub: DurableObjectStub<RealRegistry>,
) => Partial<HarnessRegistry>;

/** A fresh real Registry, and the asking, applying and following parts over it, with `overrides` in place of its own. */
const started = async (overrides: Overrides = () => ({})) => {
  const stub = env.REAL_REGISTRIES.get(env.REAL_REGISTRIES.newUniqueId());
  const call = callOn(stub);
  const replaced = overrides(call, stub);

  await call("agentChangeFeatures");

  // SAFETY: each method is the row's own or the real Registry's, called by name with the input the caller gave it.
  const registry = new Proxy(
    {},
    {
      get: (_target, method: string) =>
        replaced[method as keyof HarnessRegistry] ??
        ((...input: ReadonlyArray<unknown>) =>
          Effect.promise(() => call(method as keyof RegistryMethods, ...(input as [never])))),
    },
  ) as HarnessRegistry;

  // `background` runs at once: the push of a new request, and the upkeep after a delete, are handed to it here.
  const background = (effect: Effect.Effect<void>) => effect;

  /** The Environments whose Builds' upkeep ran, in order. */
  const built: Array<string> = [];

  /** The Environments the main Worker pushed an MCP server set to (`mcp.sync`), in order. */
  const synced: Array<string | undefined> = [];

  /** What wiping a Workspace's or Build's object does: a row sets it to see or break a delete's steps. */
  const objects = { destroy: (_name: string) => Promise.resolve() };

  const writes = endpointWrites({
    registry,
    builds: {
      of: (environment) => Effect.sync(() => void built.push(environment)),
      rebuild: () => Effect.die("no Build"),
    },
    spares: { of: () => Effect.void },
    mcp: { sync: (environment) => Effect.sync(() => void synced.push(environment)) },
    objects: {
      workspaces: { destroy: (name) => objects.destroy(name) },
      sessions: { destroy: () => Effect.void },
      triggers: { remove: () => Effect.void },
    },
    background,
    credentials: [],
  });

  let attempts = 0;

  const ask = askApproval({ registry, writes, background, origin: ORIGIN });
  const runner = approvalRunner({ registry, writes, upkeep: () => Effect.void, background });

  return {
    stub,
    call,
    built,
    synced,
    objects,
    /** Ask for `tool`'s change with `args`, as the dispatcher hands it over. */
    ask: async (
      tool: ApprovalToolName,
      args: Readonly<Record<string, Schema.Json>>,
      requestId?: string,
      narrowing?: Effect.Effect<ApiResult<HarnessAnswer>>,
    ): Promise<ApiResult<HarnessAnswer>> => {
      attempts += 1;

      const input = requestId === undefined ? args : { ...args, request_id: requestId };
      // SAFETY: the arguments are JSON, as the endpoint's input is.
      const json = input as Readonly<Record<string, never>>;
      const { reason: _reason, ...withoutReason } = json;

      return Effect.runPromise(
        ask({
          tool,
          args: json,
          caller: PI,
          requestId,
          requestDigest: requestDigest(tool, json),
          digest: requestDigest(tool, withoutReason),
          attempt: `attempt-${attempts}`,
          narrowing,
        }),
      );
    },
    wait: (approval_id: string, timeout_s?: number): Promise<ApiResult<ApprovalState>> =>
      Effect.runPromise(
        approvalWait({ registry, runner })(
          timeout_s === undefined ? { approval_id } : { approval_id, timeout_s },
          PI,
        ),
      ),
    withdraw: (approval_id: string): Promise<ApiResult<ApprovalState>> =>
      Effect.runPromise(approvalWithdraw({ registry })({ approval_id })),
    apply: (id: string) => Effect.runPromise(runner.apply(id)),
  };
};

/** The value of an answer that succeeded; fails the test otherwise. */
const okValue = <A>(result: ApiResult<A>): A => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

  return result.value;
};

/** The `approval_id` a `pending` answer gives. */
const approvalIdOf = (result: ApiResult<HarnessAnswer>): string => {
  const { structured } = okValue(result);

  // SAFETY: a pending answer's structured value has its `approval_id`.
  return (structured as { readonly approval_id: string }).approval_id;
};

const SPEND = { scope: GLOBAL_SCOPE, per_session: 20, reason: "Runs cost more now" };

/** What an applied spend limit's answer carries for programs: the Agent change made. */
const SPEND_CHANGED = {
  changes: [expect.objectContaining({ field: "spendLimit.perSession", after: 20 })],
};

describe("an ask", () => {
  it("answers pending with the request's id, its card's url and when it expires, and keeps it on its section", async () => {
    const { ask, call } = await started();

    const answer = okValue(await ask("settings_spend_limit_set", SPEND));
    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    expect(answer.structured).toEqual({
      status: "pending",
      approval_id: id,
      url: `${ORIGIN}/settings/all/limits?request=${id}`,
      expires_at: expect.any(String),
      scope: { id: GLOBAL_SCOPE, name: "Global" },
    });
    expect(await call("listApprovals", {})).toEqual([
      expect.objectContaining({ id, scope: GLOBAL_SCOPE, section: "limits", via: PI }),
    ]);
  });

  it("answers the request that waits for the same change, for another reason too", async () => {
    const { ask } = await started();

    const first = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    const again = approvalIdOf(
      await ask("settings_spend_limit_set", { ...SPEND, reason: "Asked again" }),
    );

    expect(again).toBe(first);
  });

  it("asks nothing for a value the target has already", async () => {
    const { ask, call } = await started();

    const answer = okValue(
      await ask("settings_instructions_set", { scope: GLOBAL_SCOPE, text: "", reason: "None" }),
    );

    expect(answer.structured).toMatchObject({ status: "unchanged", unchanged: ["instructions"] });
    expect(await call("listApprovals", {})).toEqual([]);
  });

  it("refuses what the tool refuses, and a kept Secret in an argument, keeping no request", async () => {
    const { ask, call } = await started();

    await call("setEnvironmentSecret", {
      environment: null,
      name: "API_KEY",
      value: "sk-live-0123456789abcdef",
    });

    expect(
      await ask("settings_instructions_set", {
        scope: "nope0000",
        text: "Hi",
        reason: "Because",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(
      await ask("settings_spend_limit_set", { ...SPEND, reason: "key sk-live-0123456789abcdef" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(await call("listApprovals", {})).toEqual([]);
  });

  it("answers the Registry's refusal of a check that heals (the kept Secrets changed meanwhile) as unavailable", async () => {
    const { ask } = await started(() => ({
      requestApproval: () => Effect.succeed({ status: "refused", message: SECRETS_CHANGED }),
    }));

    expect(await ask("settings_spend_limit_set", SPEND)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("refuses past the cap of requests per caller", async () => {
    const { ask } = await started();

    for (let index = 1; index <= MAX_PENDING_APPROVALS; index += 1) {
      okValue(await ask("settings_spend_limit_set", { ...SPEND, per_session: index }));
    }

    expect(await ask("settings_spend_limit_set", { ...SPEND, per_session: 99 })).toMatchObject({
      ok: false,
      error: { code: "too_many_approvals" },
    });
  });

  it("answers a repeat of its request_id with the same answer, and refuses one with other arguments", async () => {
    const { ask } = await started();

    const first = await ask("settings_spend_limit_set", SPEND, "req-1");
    const repeat = await ask("settings_spend_limit_set", SPEND, "req-1");

    expect(repeat).toEqual(first);
    expect(
      await ask("settings_spend_limit_set", { ...SPEND, per_session: 30 }, "req-1"),
    ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
  });
});

describe("an approved request's apply", () => {
  it("makes the change against what the owner saw, recorded as approved under the request's claim", async () => {
    const { ask, call, apply } = await started();
    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    await call("answerApproval", { id, approved: true });

    const applied = await apply(id);

    expect(applied).toMatchObject({ status: "finished", result: { structured: SPEND_CHANGED } });
    expect((await call("getSettings")).settings.spendLimit.perSession).toBe(20);
    expect(await call("listSettingsChanges")).toEqual([
      expect.objectContaining({
        field: "spendLimit.perSession",
        after: 20,
        tool: "settings_spend_limit_set",
        via: { auth: "oauth", client: { name: "pi" } },
      }),
    ]);
    expect(await call("changeRequest", { id: `approval:${id}` })).toMatchObject({
      attempt: id,
      answer: applied?.result,
    });
  });

  it("changes nothing when the target changed since the ask", async () => {
    const { ask, call, apply } = await started();
    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    await call("updateSettings", { overrides: { spendLimit: { perSession: 5 } } });
    await call("answerApproval", { id, approved: true });

    expect(await apply(id)).toMatchObject({ status: "changed_since", reason: expect.any(String) });
    expect((await call("getSettings")).settings.spendLimit.perSession).toBe(5);
  });

  it("finishes from the claim after a write that committed, and does not write again", async () => {
    const { ask, call, apply } = await started();
    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));
    const approved = await call("answerApproval", { id, approved: true });

    // The write of a run that was cut before it settled anything.
    await call("changeSettings", {
      changes: [{ field: "spendLimit.perSession", value: 20, expected: { value: null } }],
      author: {
        via: PI,
        tool: "settings_spend_limit_set",
        reason: SPEND.reason,
        approved: true,
        request: approvalClaim(approved!),
      },
    });

    expect(await apply(id)).toMatchObject({
      status: "finished",
      result: { structured: SPEND_CHANGED },
    });
    expect(await call("listSettingsChanges")).toHaveLength(1);
  });

  it("finishes from the claim a run that overlapped a lapsed lease committed, when its own write finds the target changed", async () => {
    let lookups = 0;

    // The first look at the claim misses the overlapping run's write, which commits right after it.
    const { ask, call, apply } = await started((registry) => ({
      changeRequest: (input) => {
        lookups += 1;

        return lookups === 1
          ? Effect.succeed(null)
          : Effect.promise(() => registry("changeRequest", input));
      },
    }));

    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));
    const approved = await call("answerApproval", { id, approved: true });

    await call("changeSettings", {
      changes: [{ field: "spendLimit.perSession", value: 20, expected: { value: null } }],
      author: {
        via: PI,
        tool: "settings_spend_limit_set",
        reason: SPEND.reason,
        approved: true,
        request: approvalClaim(approved!),
      },
    });
    // The owner changes it again after that run: this run's write finds the target changed since the ask.
    await call("updateSettings", { overrides: { spendLimit: { perSession: 5 } } });

    expect(await apply(id)).toMatchObject({ status: "finished" });
    expect(lookups).toBe(2);
    expect(await call("listSettingsChanges")).toHaveLength(1);
  });

  it("applies nothing for a request that is not approved", async () => {
    const { ask, apply } = await started();
    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    expect(await apply(id)).toMatchObject({ status: "pending" });
  });

  it("sets an Environment's size limit, asked for on the Limits section", async () => {
    const { ask, call, apply } = await started();

    const id = approvalIdOf(
      await ask("environment_container_size_limit_set", {
        id: DEFAULT_ENVIRONMENT,
        size: LARGER,
        reason: "Bigger builds",
      }),
    );

    expect(await call("listApprovals", {})).toEqual([
      expect.objectContaining({ id, section: "limits" }),
    ]);

    await call("answerApproval", { id, approved: true });

    expect(await apply(id)).toMatchObject({ status: "finished" });
    expect(
      (await call("getEnvironmentSettings", { environment: DEFAULT_ENVIRONMENT }))?.overrides,
    ).toMatchObject({
      maxInstance: LARGER,
    });
  });
});

describe("the resets' Limit paths", () => {
  it("resets a Limit of the Settings to its default once approved", async () => {
    const { ask, call, apply } = await started();

    await call("updateSettings", { overrides: { spendLimit: { perSession: 5 } } });

    const id = approvalIdOf(
      await ask("settings_reset", {
        scope: GLOBAL_SCOPE,
        field: "spendLimit.perSession",
        reason: "Back to none",
      }),
    );

    await call("answerApproval", { id, approved: true });

    expect(await apply(id)).toMatchObject({ status: "finished" });
    expect((await call("getSettings")).settings.spendLimit.perSession).toBeNull();
  });

  it("resets an Environment's size limit to Global's once approved, asked for on the Limits section", async () => {
    const { ask, call, apply } = await started();

    await call("changeEnvironment", {
      environment: DEFAULT_ENVIRONMENT,
      change: { field: "maxInstance", value: LARGER },
      author: { session: "s-1", conversation: 1, tool: "set", reason: "Bigger" },
    });

    const id = approvalIdOf(
      await ask("environment_setting_reset", {
        id: DEFAULT_ENVIRONMENT,
        setting: "maxInstance",
        reason: "Back to Global's",
      }),
    );

    expect(await call("listApprovals", {})).toEqual([
      expect.objectContaining({ id, section: "limits" }),
    ]);

    await call("answerApproval", { id, approved: true });

    expect(await apply(id)).toMatchObject({ status: "finished" });
    expect(
      (await call("getEnvironmentSettings", { environment: DEFAULT_ENVIRONMENT }))?.overrides
        .maxInstance,
    ).toBeUndefined();
  });
});

describe("the MCP servers' tools", () => {
  const ENTRY = { command: "node", args: ["files.js"] };

  const ADD = {
    scope: GLOBAL_SCOPE,
    name: "files",
    entry: ENTRY,
    reason: "The project reads files",
  };

  /** What the tool's own change answers when the ask hands it on: the dispatcher's, stood in for. */
  const NARROWED: ApiResult<HarnessAnswer> = { ok: true, value: { text: "made", structured: {} } };

  /** Global's own entries of MCP servers, as the Registry keeps them. */
  const serversOf = async (call: RegistryCall) => (await call("getSettings")).settings.mcp.servers;

  it("asks for a definition on the MCP servers' section, whatever the check says", async () => {
    const { ask, call } = await started();

    const id = approvalIdOf(await ask("settings_mcp_add", ADD));

    expect(await call("listApprovals", {})).toEqual([
      expect.objectContaining({
        id,
        scope: GLOBAL_SCOPE,
        section: "mcp",
        tool: "settings_mcp_add",
      }),
    ]);
    expect(await serversOf(call)).toEqual({});
  });

  it("writes exactly what the owner saw once approved, and has the main Worker push each Environment it reaches", async () => {
    const { ask, call, apply, synced } = await started();
    const id = approvalIdOf(await ask("settings_mcp_add", ADD));

    await call("answerApproval", { id, approved: true });

    const applied = await apply(id);

    expect(applied).toMatchObject({
      status: "finished",
      result: { structured: { server_status: { state: "not_checked" } } },
    });
    expect(await serversOf(call)).toEqual({ files: ENTRY });
    expect(await call("listSettingsChanges")).toEqual([
      expect.objectContaining({ field: "mcp.servers.files", tool: "settings_mcp_add" }),
    ]);
    // Global's change reaches the Environment that exists, and the host is asked nothing by the apply.
    expect(synced).toEqual([DEFAULT_ENVIRONMENT]);
  });

  it("changes nothing, and ends changed_since, when the server was defined since the ask", async () => {
    const { ask, call, apply, synced } = await started();
    const id = approvalIdOf(await ask("settings_mcp_add", ADD));
    const other = { command: "node", args: ["other.js"] };

    await call("updateSettings", { overrides: { mcp: { servers: { files: other } } } });
    await call("answerApproval", { id, approved: true });

    expect(await apply(id)).toMatchObject({ status: "changed_since" });
    expect(await serversOf(call)).toEqual({ files: other });
    expect(synced).toEqual([]);
  });

  it("finishes from the claim after a write that committed, worded over what the Registry says of it, and does not write again", async () => {
    const { ask, call, apply } = await started();
    const id = approvalIdOf(await ask("settings_mcp_add", ADD));
    const approved = await call("answerApproval", { id, approved: true });

    // The write of a run that was cut before it settled anything.
    await call("changeSettings", {
      changes: [{ field: "mcp.servers.files", value: ENTRY, expected: { value: null } }],
      author: {
        via: PI,
        tool: "settings_mcp_add",
        reason: ADD.reason,
        approved: true,
        request: approvalClaim(approved!),
      },
    });

    expect(await apply(id)).toMatchObject({
      status: "finished",
      result: { structured: { server_status: { state: "not_checked" } } },
    });
    expect(await call("listSettingsChanges")).toHaveLength(1);
  });

  it("asks to reset an adjustment that would switch a server back on, and resets it once approved", async () => {
    const { ask, call, apply, synced } = await started();

    await call("updateSettings", { overrides: { mcp: { servers: { files: ENTRY } } } });
    await call("changeSettings", {
      environment: DEFAULT_ENVIRONMENT,
      changes: [
        {
          field: "mcp.servers.files.enabled",
          value: false,
          expected: { value: null, inherited: true },
        },
      ],
      author: { via: PI, tool: "settings_mcp_disable", reason: "Off here" },
    });

    const reset = {
      scope: DEFAULT_ENVIRONMENT,
      field: "mcp.servers.files.enabled",
      reason: "On again",
    };

    const id = approvalIdOf(await ask("settings_reset", reset));

    expect(await call("listApprovals", {})).toEqual([
      expect.objectContaining({ id, section: "mcp", tool: "settings_reset" }),
    ]);

    await call("answerApproval", { id, approved: true });

    expect(await apply(id)).toMatchObject({ status: "finished" });
    expect(synced).toEqual([DEFAULT_ENVIRONMENT]);
  });

  it("asks when a change takes a server out of hidden, though the tool's own change is at hand", async () => {
    const { ask, call } = await started();

    await call("updateSettings", {
      overrides: { mcp: { servers: { files: { ...ENTRY, exposure: "hidden" } } } },
    });

    const id = approvalIdOf(
      await ask(
        "settings_mcp_exposure_set",
        { scope: GLOBAL_SCOPE, name: "files", exposure: "codemode", reason: "Needed now" },
        undefined,
        Effect.succeed(NARROWED),
      ),
    );

    expect(await call("listApprovals", {})).toEqual([
      expect.objectContaining({ id, section: "mcp", tool: "settings_mcp_exposure_set" }),
    ]);
  });

  it("makes a change that narrows at once through the tool's own change, asking nobody", async () => {
    const { ask, call } = await started();

    await call("updateSettings", { overrides: { mcp: { servers: { files: ENTRY } } } });

    const answer = await ask(
      "settings_mcp_exposure_set",
      { scope: GLOBAL_SCOPE, name: "files", exposure: "hidden", reason: "Not needed" },
      undefined,
      Effect.succeed(NARROWED),
    );

    expect(answer).toEqual(NARROWED);
    expect(await call("listApprovals", {})).toEqual([]);
  });

  it("answers a repeat of a request_id that asked, its settle cut, with the same request, though the state narrows now", async () => {
    // The settle of the first call's claim is lost: its claim has no answer and no changes.
    const { ask, call } = await started(() => ({
      settleChangeRequest: () => Effect.succeed(false),
    }));

    await call("updateSettings", {
      overrides: { mcp: { servers: { files: { ...ENTRY, exposure: "hidden" } } } },
    });

    const args = { scope: GLOBAL_SCOPE, name: "files", exposure: "codemode", reason: "Needed now" };

    const first = approvalIdOf(
      await ask("settings_mcp_exposure_set", args, "req-1", Effect.succeed(NARROWED)),
    );

    // Meanwhile the entry is no longer hidden, so the same call would narrow, if it were made now.
    await call("updateSettings", {
      overrides: { mcp: { servers: { files: { ...ENTRY, exposure: "direct" } } } },
    });

    const repeated = await ask(
      "settings_mcp_exposure_set",
      args,
      "req-1",
      Effect.succeed(NARROWED),
    );

    expect(approvalIdOf(repeated)).toBe(first);
    expect(await call("listApprovals", {})).toHaveLength(1);
  });

  // L17: a repeat of a `request_id` whose first call made its change and was cut is answered from the changes it recorded,
  // before `prepare` reads a state the change altered (a removed server is gone; a tool exposure is set already).
  type Cut = {
    readonly tool: ApprovalToolName;
    readonly args: Readonly<Record<string, string>> & {
      readonly reason: string;
      readonly request_id?: string;
    };
    readonly change: { readonly field: string; readonly value: Schema.Json; readonly reset?: true };
  };

  it.each<Cut>([
    {
      tool: "settings_mcp_remove",
      args: { scope: GLOBAL_SCOPE, name: "files", reason: "Not needed" },
      change: { field: "mcp.servers.files", value: null, reset: true },
    },
    {
      tool: "settings_mcp_tool_exposure_set",
      args: {
        scope: GLOBAL_SCOPE,
        name: "files",
        tool: "drop_*",
        exposure: "hidden",
        reason: "Not needed",
      },
      change: { field: "mcp.servers.files.toolExposure", value: { "drop_*": "hidden" } },
    },
  ])(
    "answers a repeat of $tool's request_id from its recorded change",
    async ({ tool, args, change }) => {
      const { ask, call } = await started();

      await call("updateSettings", { overrides: { mcp: { servers: { files: ENTRY } } } });
      await call("changeSettings", {
        changes: [change],
        author: {
          via: PI,
          tool,
          reason: args.reason,
          request: { id: "req-1", tool, digest: requestDigest(tool, args), attempt: "first" },
        },
      });

      const repeated = await ask(tool, args, "req-1", Effect.succeed(NARROWED));

      expect(repeated).toEqual(NARROWED);
      expect(await call("listApprovals", {})).toEqual([]);
    },
  );
});

// #693 S3b-3: a change to the Skills kept Global asks the owner. GitHub is the one thing stood in for: the Registry's Skill
// methods that read it run the Registry's own code (`installSkills`, `updateSkills` and their previews) in its object, over
// its storage, with a fake reader; the asks, the requests, the claims and the removal are the real Registry's.
describe("the Skills kept Global", () => {
  const COMMIT = "c0ffee0000000000000000000000000000000001";
  const LATER = "c0ffee0000000000000000000000000000000002";

  const skillMd = (name: string, body = "Steps.") =>
    `---\nname: ${name}\ndescription: What ${name} does.\n---\n${body}\n`;

  /** A repo as the fake reader serves it: its files by path, at its head commit. */
  type Repo = { files: Readonly<Record<string, string>>; commit: string };

  /** A reader over `repo` as it is when read; a blob's SHA names its commit, so a folder changes with its commit. */
  const readerOf = (repo: Repo): RepoReader => {
    const listing = async () => ({
      truncated: false,
      entries: Object.entries(repo.files).map(([path, text]) => ({
        path,
        type: "blob" as const,
        sha: `${repo.commit}:${path}`,
        size: text.length,
      })),
    });

    return {
      commit: async () => repo.commit,
      tree: listing,
      headTree: listing,
      file: async () => null,
      blob: async (_repo, sha) =>
        new TextEncoder().encode(repo.files[sha.slice(sha.indexOf(":") + 1)] ?? ""),
    };
  };

  const TWO = {
    "skills/grill-me/SKILL.md": skillMd("grill-me"),
    "skills/tdd/SKILL.md": skillMd("tdd"),
  };

  /** The Registry's own code of the Skill methods `inObject` runs: its storage, and the time now. */
  const contextIn = (storage: DurableObjectStorage) => ({
    storage,
    store: openRegistryStore(storage),
    skills: openSkills(storage),
    changes: openAgentChanges(storage),
    now: Date.now(),
  });

  /**
   * The Registry's GitHub-reading Skill methods over `repo`, run in its object as it runs them (refusing a change at Global
   * without a pin), and `keep`, the owner's install of Skills at Global. `cutFirstInstall`: the first install keeps only the
   * first Skill the owner approved, then its run is cut (a multi-Skill install cut after one Skill committed).
   */
  const github = (repo: Repo, { cutFirstInstall = false } = {}) => {
    let installs = 0;
    let target: DurableObjectStub<RealRegistry> | undefined;

    const inObject = <A>(body: (context: ReturnType<typeof contextIn>) => Promise<A>) => {
      if (target === undefined) throw new Error("the Registry is not started");

      return runInDurableObject(target, async (_instance: RealRegistry, state) =>
        body(contextIn(state.storage)),
      );
    };

    const overrides: Overrides = (_call, stub) => {
      target = stub;

      return {
        agentPreviewSkillInstall: (input) =>
          Effect.promise(() =>
            inObject((context) => previewSkillInstall(context, readerOf(repo), input)),
          ),
        agentInstallSkills: ({ pin, ...input }) =>
          Effect.suspend(() => {
            const unapproved = unapprovedGlobalChange(input.environment, pin !== undefined);

            if (unapproved !== undefined) {
              return Effect.succeed({ status: "refused" as const, message: unapproved });
            }

            installs += 1;

            if (!cutFirstInstall || installs > 1 || pin === undefined) {
              return Effect.promise(() =>
                inObject((context) => installSkills(context, readerOf(repo), { ...input, pin })),
              );
            }

            const first = { ...pin, skills: pin.skills.slice(0, 1) };

            return Effect.promise(() =>
              inObject((context) =>
                installSkills(context, readerOf(repo), { ...input, pin: first }),
              ),
            ).pipe(Effect.andThen(Effect.die(new Error("The run was cut after its first Skill"))));
          }),
        previewSkillUpdates: (input) =>
          Effect.promise(() =>
            inObject((context) => previewSkillUpdates(context, readerOf(repo), input)),
          ),
        agentUpdateSkills: (input) =>
          Effect.suspend(() => {
            const unapproved = unapprovedGlobalChange(input.environment, input.pins !== undefined);

            return unapproved === undefined
              ? Effect.promise(() =>
                  inObject((context) => updateSkills(context, readerOf(repo), input)),
                )
              : Effect.succeed({ status: "refused" as const, message: unapproved });
          }),
      };
    };

    return {
      overrides,
      keep: (skills: ReadonlyArray<string>) =>
        inObject((context) =>
          installSkills(context, readerOf(repo), {
            environment: GLOBAL_SCOPE,
            source: "o/skills",
            skills,
            author: null,
          }),
        ),
    };
  };

  const INSTALL = {
    id: GLOBAL_SCOPE,
    source: "o/skills",
    skills: ["grill-me", "tdd"],
    reason: "Every project should grill the plan",
  };

  /** The request kept for `id`. */
  const requestOf = async (call: RegistryCall, id: string) => {
    const [found] = (await call("listApprovals", {})).filter((approval) => approval.id === id);

    if (found === undefined) throw new Error(`No request ${id}`);

    return found;
  };

  /** The Skills kept Global, by name. */
  const keptGlobal = async (call: RegistryCall) =>
    ((await call("listSkills", { environment: GLOBAL_SCOPE })) ?? []).map(({ name }) => name);

  it("answers an install, an update and a removal at Global pending, on the Skills section, keeping only the pins", async () => {
    const repo = { files: TWO, commit: COMMIT };
    const { overrides, keep } = github(repo);
    const { ask, call } = await started(overrides);

    const installing = okValue(await ask("environment_skill_install", INSTALL));
    const installId = approvalIdOf(await ask("environment_skill_install", INSTALL));

    expect(installing.structured).toMatchObject({
      status: "pending",
      approval_id: installId,
      url: `${ORIGIN}/settings/all/skills?request=${installId}`,
      scope: { id: GLOBAL_SCOPE, name: "Global" },
    });

    const install = await requestOf(call, installId);

    expect(install).toMatchObject({
      scope: GLOBAL_SCOPE,
      section: "skills",
      tool: "environment_skill_install",
    });
    // The card shows the files; the row's `expected` holds the pin only, never a file's text (#685 L6).
    expect(install.card.after).toContain("Steps.");
    expect(install.expected).toEqual({
      commit: COMMIT,
      skills: [
        { name: "grill-me", path: "skills/grill-me", digest: expect.any(String), savedAt: null },
        { name: "tdd", path: "skills/tdd", digest: expect.any(String), savedAt: null },
      ],
    });
    expect(JSON.stringify(install.expected)).not.toContain("Steps.");

    // An update and a removal of Skills kept Global already.
    await keep(["grill-me", "tdd"]);
    repo.files = { ...TWO, "skills/grill-me/SKILL.md": skillMd("grill-me", "Newer steps.") };
    repo.commit = LATER;

    const updateId = approvalIdOf(
      await ask("environment_skill_update", {
        id: GLOBAL_SCOPE,
        names: ["grill-me"],
        reason: "Latest",
      }),
    );

    const update = await requestOf(call, updateId);

    expect(update.card.after).toContain("Newer steps.");
    expect(update.expected).toEqual({
      pins: [
        {
          name: "grill-me",
          savedAt: expect.any(Number),
          commit: LATER,
          folderHash: expect.any(String),
        },
      ],
    });

    const removeId = approvalIdOf(
      await ask("environment_skill_remove", { id: GLOBAL_SCOPE, name: "tdd", reason: "Unused" }),
    );

    expect((await requestOf(call, removeId)).expected).toEqual({ savedAt: expect.any(Number) });
    // Nothing is changed until the owner approves.
    expect(await call("listAgentChanges", { environment: GLOBAL_SCOPE })).toEqual([]);
  });

  it("refuses more Skills than one request shows, and a preview over the size cap, keeping no request", async () => {
    const eleven = Object.fromEntries(
      Array.from({ length: 11 }, (_, at) => [`skills/s${at}/SKILL.md`, skillMd(`s${at}`)]),
    );

    // Two Skills that fit a set alone, and not together: 3 files of 1.4 MiB each.
    const big = (name: string) => ({
      [`skills/${name}/SKILL.md`]: skillMd(name),
      ...Object.fromEntries(
        [1, 2, 3].map((at) => [`skills/${name}/part-${at}.md`, "x".repeat(1_400 * 1024)]),
      ),
    });

    const many = github({ files: eleven, commit: COMMIT });
    const run = await started(many.overrides);

    const tooMany = await run.ask("environment_skill_install", {
      ...INSTALL,
      skills: Object.keys(eleven).map((path) => path.split("/")[1] ?? ""),
    });

    expect(tooMany).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(!tooMany.ok && tooMany.error.message).toContain("more than the 10");
    expect(await run.call("listApprovals", {})).toEqual([]);

    const large = github({ files: { ...big("a"), ...big("b") }, commit: COMMIT });
    const sized = await started(large.overrides);

    const tooLarge = await sized.ask("environment_skill_install", {
      ...INSTALL,
      skills: ["a", "b"],
    });

    expect(tooLarge).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(!tooLarge.ok && tooLarge.error.message).toContain("bytes together");
    expect(await sized.call("listApprovals", {})).toEqual([]);
  });

  it("installs on Approve each Skill only while its pin holds, as approved under the request's claim, naming those it skipped", async () => {
    const repo = { files: TWO, commit: COMMIT };
    const { overrides } = github(repo);
    const { ask, call, apply } = await started(overrides);
    const id = approvalIdOf(await ask("environment_skill_install", INSTALL));

    // tdd changes at the commit after the owner was asked: its files are not the ones they were shown.
    repo.files = { ...TWO, "skills/tdd/SKILL.md": skillMd("tdd", "Other steps.") };
    await call("answerApproval", { id, approved: true });

    const applied = await apply(id);

    expect(applied).toMatchObject({
      status: "finished",
      result: {
        structured: {
          scope: { id: GLOBAL_SCOPE },
          changed: true,
          installed: [{ name: "grill-me" }],
          refused: [{ name: "tdd" }],
        },
      },
    });
    expect(applied?.result?.text).toContain("Skipped (the others were kept):");
    expect(applied?.result?.text).toContain("from their next readying");
    expect(await keptGlobal(call)).toEqual(["grill-me"]);
    expect(await call("listAgentChanges", { environment: GLOBAL_SCOPE })).toEqual([
      expect.objectContaining({
        field: "skills.grill-me",
        tool: "environment_skill_install",
        approved: true,
        via: { auth: "oauth", client: { name: "pi" } },
      }),
    ]);
    expect(await call("changeRequest", { id: `approval:${id}` })).toMatchObject({
      attempt: id,
      answer: applied?.result,
    });
  });

  it("ends changed_since, keeping nothing, when no Skill is still as the owner was shown it", async () => {
    const repo = { files: TWO, commit: COMMIT };
    const { overrides, keep } = github(repo);
    const { ask, call, apply } = await started(overrides);

    const id = approvalIdOf(
      await ask("environment_skill_install", { ...INSTALL, skills: ["grill-me"] }),
    );

    // The owner installs it themselves meanwhile: the Skill of the name was saved since the ask.
    await keep(["grill-me"]);
    repo.files = { ...TWO, "skills/grill-me/SKILL.md": skillMd("grill-me", "Other.") };
    await call("answerApproval", { id, approved: true });

    expect(await apply(id)).toMatchObject({
      status: "changed_since",
      reason: expect.stringContaining("grill-me"),
    });
    expect(await call("listAgentChanges", { environment: GLOBAL_SCOPE })).toEqual([]);
  });

  it("updates and removes on Approve, each against what the owner saw", async () => {
    const repo = { files: TWO, commit: COMMIT };
    const { overrides, keep } = github(repo);
    const { ask, call, apply } = await started(overrides);

    await keep(["grill-me", "tdd"]);
    repo.files = { ...TWO, "skills/grill-me/SKILL.md": skillMd("grill-me", "Newer steps.") };
    repo.commit = LATER;

    const update = approvalIdOf(
      await ask("environment_skill_update", {
        id: GLOBAL_SCOPE,
        names: ["grill-me"],
        reason: "Latest",
      }),
    );

    const remove = approvalIdOf(
      await ask("environment_skill_remove", { id: GLOBAL_SCOPE, name: "tdd", reason: "Unused" }),
    );

    await call("answerApproval", { id: update, approved: true });
    await call("answerApproval", { id: remove, approved: true });

    expect(await apply(update)).toMatchObject({
      status: "finished",
      result: { structured: { updated: [{ name: "grill-me", to: { commit: LATER } }] } },
    });
    expect(await apply(remove)).toMatchObject({
      status: "finished",
      result: { structured: { skill: "tdd", changed: true } },
    });
    expect(await keptGlobal(call)).toEqual(["grill-me"]);
    expect(
      (await call("listAgentChanges", { environment: GLOBAL_SCOPE }))?.map(({ tool }) => tool),
    ).toEqual(["environment_skill_remove", "environment_skill_update"]);
  });

  // #685 L18: one transaction per Skill, so a run can be cut between two; the next runs `apply` again under the same attempt.
  it("resumes a multi-Skill install cut after its first Skill committed, installing nothing twice", async () => {
    const { overrides } = github({ files: TWO, commit: COMMIT }, { cutFirstInstall: true });
    const { ask, call, apply } = await started(overrides);
    const id = approvalIdOf(await ask("environment_skill_install", INSTALL));

    await call("answerApproval", { id, approved: true });

    // The first run keeps grill-me, then is cut: the request stays approved, its claim holding grill-me's change.
    expect(await apply(id)).toMatchObject({ status: "approved" });
    expect(await keptGlobal(call)).toEqual(["grill-me"]);
    expect(await call("changeRequest", { id: `approval:${id}` })).toMatchObject({
      answer: null,
      changes: [expect.objectContaining({ field: "skills.grill-me" })],
    });

    const resumed = await apply(id);

    expect(resumed).toMatchObject({
      status: "finished",
      result: {
        structured: {
          changed: true,
          installed: [{ name: "grill-me" }, { name: "tdd" }],
          unchanged: [],
          changes: [
            expect.objectContaining({ field: "skills.grill-me" }),
            expect.objectContaining({ field: "skills.tdd" }),
          ],
        },
      },
    });
    expect(await keptGlobal(call)).toEqual(["grill-me", "tdd"]);
    expect(
      (await call("listAgentChanges", { environment: GLOBAL_SCOPE }))?.map(({ field }) => field),
    ).toEqual(["skills.tdd", "skills.grill-me"]);
    expect(await call("changeRequest", { id: `approval:${id}` })).toMatchObject({
      answer: resumed?.result,
      changes: [
        expect.objectContaining({ field: "skills.grill-me" }),
        expect.objectContaining({ field: "skills.tdd" }),
      ],
    });
  });
});

describe("approval_wait", () => {
  it("reads a waiting request once with 0, and applies an approved one no run is applying", async () => {
    const { ask, call, wait } = await started();
    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    expect(okValue(await wait(id, 0))).toMatchObject({
      approval_id: id,
      tool: "settings_spend_limit_set",
      status: "pending",
      finished: false,
    });

    await call("answerApproval", { id, approved: true });

    expect(okValue(await wait(id, 0))).toMatchObject({
      status: "finished",
      finished: true,
      result: { structured: SPEND_CHANGED },
    });
  });

  it("returns when the owner answers", async () => {
    const { ask, call, wait } = await started();
    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    const waiting = wait(id, 30);

    await call("answerApproval", { id, approved: false, reason: "Too much" });

    expect(okValue(await waiting)).toMatchObject({
      status: "declined",
      finished: true,
      reason: "Too much",
    });
  });

  it("answers a wait cut short (a deploy) with the request as read once after, interrupted", async () => {
    const { ask, wait } = await started(() => ({
      waitApproval: () => Effect.die("the RPC was cut"),
    }));

    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    expect(okValue(await wait(id, 30))).toMatchObject({
      approval_id: id,
      status: "pending",
      finished: false,
      interrupted: true,
    });
  });

  it("says a request it does not keep is not found", async () => {
    const { wait } = await started();

    expect(await wait("gone", 0)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("approval_withdraw", () => {
  it("withdraws a waiting request, can be repeated, and is refused once the owner approved, applied or not", async () => {
    const { ask, call, withdraw, apply } = await started();
    const waiting = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    const approved = approvalIdOf(
      await ask("settings_subagent_depth_set", { scope: GLOBAL_SCOPE, depth: 3, reason: "Deeper" }),
    );

    const notApplied = approvalIdOf(
      await ask("settings_subagent_workspaces_set", {
        scope: GLOBAL_SCOPE,
        limit: 2,
        reason: "More",
      }),
    );

    await call("answerApproval", { id: approved, approved: true });
    await call("updateSettings", {
      overrides: { extensions: { subagents: { maxSubagentWorkspaces: 1 } } },
    });
    await call("answerApproval", { id: notApplied, approved: true });
    await apply(notApplied);

    const states: Array<ApiResult<ApprovalState>> = [
      await withdraw(waiting),
      await withdraw(waiting),
      await withdraw(approved),
      await withdraw(notApplied),
    ];

    expect(states).toMatchObject([
      { ok: true, value: { status: "withdrawn", finished: true } },
      { ok: true, value: { status: "withdrawn", finished: true } },
      { ok: false, error: { code: "invalid_argument" } },
      { ok: false, error: { code: "invalid_argument" } },
    ]);
  });
});

describe("the deletes", () => {
  /** A new Environment "Web"'s id. */
  const madeIn = async (call: RegistryCall) => {
    const made = await call("createEnvironment", { name: "Web" });

    if (made.status !== "named") throw new Error(`Environment not made: ${made.status}`);

    return made.environment.id;
  };

  it("asks to delete an Environment on its section, as long, and refuses the default and an unknown one without asking", async () => {
    const { ask, call } = await started();
    const environment = await madeIn(call);

    const id = approvalIdOf(await ask("environment_delete", { id: environment, reason: "Done" }));

    expect(
      await ask("environment_delete", { id: DEFAULT_ENVIRONMENT, reason: "Done" }),
    ).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
    expect(await ask("environment_delete", { id: "0000beef", reason: "Done" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await call("listApprovals", {})).toEqual([
      expect.objectContaining({ id, scope: environment, section: "environments" }),
    ]);
    expect(await call("approval", { id })).toMatchObject({ long: true });
  });

  it("deletes the Environment once approved, never in approval_wait, withdrawing its other waiting requests", async () => {
    const { ask, call, wait, apply } = await started();
    const environment = await madeIn(call);
    const id = approvalIdOf(await ask("environment_delete", { id: environment, reason: "Done" }));

    const other = approvalIdOf(
      await ask("environment_container_size_limit_set", {
        id: environment,
        size: LARGER,
        reason: "Bigger builds",
      }),
    );

    await call("answerApproval", { id, approved: true });

    expect(okValue(await wait(id, 0))).toMatchObject({
      status: "approved",
      long: true,
      finished: false,
    });
    expect(await call("getEnvironment", { id: environment })).not.toBeNull();

    expect(await apply(id)).toMatchObject({
      status: "finished",
      result: {
        structured: { environment: { id: environment, name: "Web" }, deleted: true },
      },
    });
    expect(await call("getEnvironment", { id: environment })).toBeNull();
    expect(await call("approval", { id: other })).toMatchObject({
      status: "withdrawn",
      withdrawal: "environment_deleted",
    });
    // Its run found it gone: the delete is done.
    expect(await apply(id)).toMatchObject({ status: "finished" });
  });

  /** Environment "Web" with a Session in a Workspace of its own, its delete asked and approved: the request's id. */
  const approvedDelete = async ({ ask, call }: Awaited<ReturnType<typeof started>>) => {
    const environment = await madeIn(call);

    await call("createSession", { workspace: { kind: "new", environment } });

    const id = approvalIdOf(await ask("environment_delete", { id: environment, reason: "Done" }));

    await call("answerApproval", { id, approved: true });

    return { environment, id };
  };

  it("renews its lease after each step of an Environment's delete, as the same run", async () => {
    const claims: Array<{
      readonly token: string;
      readonly leased: boolean;
      readonly until: number;
    }> = [];

    const run = await started((registry) => ({
      claimApproval: (input) =>
        Effect.promise(() => registry("claimApproval", input)).pipe(
          Effect.tap((claimed) =>
            Effect.sync(() => {
              if (claimed !== null) {
                claims.push({
                  token: input.token,
                  leased: claimed.leased,
                  until: claimed.approval.leaseUntil ?? 0,
                });
              }
            }),
          ),
        ),
    }));

    const { environment, id } = await approvedDelete(run);

    // Each wipe takes a moment, so a renewal's lease ends later than the claim's.
    run.objects.destroy = () => new Promise((resolve) => setTimeout(resolve, 5));

    expect(await run.apply(id)).toMatchObject({ status: "finished" });
    expect(await run.call("getEnvironment", { id: environment })).toBeNull();
    // The claim, then one renewal after the Workspace and one after the spare and the Build.
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((claim) => claim.token)).size).toBe(1);
    expect(claims.every((claim) => claim.leased)).toBe(true);
    expect(claims[2]!.until).toBeGreaterThan(claims[0]!.until);
  });

  it("stops an Environment's delete at its next step once another run holds the lease, leaving that run's lease", async () => {
    const run = await started();
    const { environment, id } = await approvedDelete(run);
    const wiped: Array<string> = [];

    // While the Workspace is wiped, another run takes the request, as one does once a lease lapsed.
    run.objects.destroy = async (name) => {
      wiped.push(name);

      if (name.startsWith("ws:")) {
        await runInDurableObject(run.stub, (_registry, state) => {
          state.storage.sql.exec(
            "UPDATE approval_requests SET lease_token = 'other-run' WHERE id = ?",
            id,
          );
        });
      }
    };

    expect(await run.apply(id)).toMatchObject({ status: "approved", leaseToken: "other-run" });
    // It stopped before the spare and the Build: the rest is the other run's.
    expect(wiped).toEqual([expect.stringMatching(/^ws:/)]);
    expect(await run.call("getEnvironment", { id: environment })).not.toBeNull();
  });

  it("lets go of the lease when a step of an Environment's delete fails, so the next run finishes it at once", async () => {
    const run = await started();
    const { environment, id } = await approvedDelete(run);

    run.objects.destroy = () => Promise.reject(new Error("storage error"));

    expect(await run.apply(id)).toMatchObject({
      status: "approved",
      leaseToken: null,
      leaseUntil: null,
    });
    expect(await run.call("getEnvironment", { id: environment })).not.toBeNull();

    run.objects.destroy = () => Promise.resolve();

    expect(await run.apply(id)).toMatchObject({ status: "finished" });
    expect(await run.call("getEnvironment", { id: environment })).toBeNull();
  });

  it("deletes a kept Secret against the updatedAt the owner saw, recorded under the request's claim, then runs the Builds' upkeep", async () => {
    const { ask, call, apply, built } = await started();
    const environment = await madeIn(call);

    await call("setEnvironmentSecret", { environment, name: "API_KEY", value: "v1", build: true });

    const args = { id: environment, name: "API_KEY", reason: "Rotated" };
    const changed = approvalIdOf(await ask("environment_secret_delete", args));

    // The owner saves it again: the request asked about the value before.
    await call("setEnvironmentSecret", { environment, name: "API_KEY", value: "v2", build: true });
    await call("answerApproval", { id: changed, approved: true });

    expect(await apply(changed)).toMatchObject({ status: "changed_since" });
    expect(await call("listEnvironmentSecrets")).toHaveLength(1);
    expect(built).toEqual([]);

    const id = approvalIdOf(await ask("environment_secret_delete", { ...args, reason: "Again" }));

    await call("answerApproval", { id, approved: true });

    const applied = await apply(id);

    expect(applied).toMatchObject({
      status: "finished",
      result: { structured: { scope: { id: environment }, name: "API_KEY", deleted: true } },
    });
    expect(await call("listEnvironmentSecrets")).toEqual([]);
    expect(built).toEqual([environment]);
    expect(await call("changeRequest", { id: `approval:${id}` })).toMatchObject({
      attempt: id,
      answer: applied?.result,
    });
  });
});
