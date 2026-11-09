// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
// The Approvals asked over the MCP endpoint, end to end over the real Registry (`../registry/registry.fixture.ts` runs
// `registryMethods` as deployed; `docs/architecture/mcp-endpoint.md` → Approvals with no Session): the ask's `pending`,
// `unchanged` and refusals, its `request_id`, dedupe and cap; the apply of an approved request against what the owner
// saw, under the request's claim, and its resume after a write that committed; `approval_wait` and `approval_withdraw`;
// and the Limit paths of both resets, which their tools ask through once they are served.
import { DEFAULT_CONTAINER_SETTINGS } from "@cloudpid/config";
import {
  type AgentChangeVia,
  DEFAULT_ENVIRONMENT,
  GLOBAL_SCOPE,
  MAX_PENDING_APPROVALS,
} from "@cloudpid/protocol";
import type { ApiResult, ApprovalState, HarnessAnswer } from "@cloudpid/protocol/mcp-api";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { RealRegistry } from "../registry/registry.fixture.ts";
import {
  approvalClaim,
  approvalRunner,
  approvalWait,
  approvalWithdraw,
  askApproval,
  waitSeconds,
} from "./approvals.ts";
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

/** A fresh real Registry, and the asking, applying and following parts over it. */
const started = async () => {
  const stub = env.REAL_REGISTRIES.get(env.REAL_REGISTRIES.newUniqueId());

  const call = async <K extends keyof RegistryMethods>(
    method: K,
    ...input: Parameters<RegistryMethods[K]>
  ) => runInDurableObject(stub, (registry: RealRegistry) => registry.call(method, ...input));

  await call("agentChangeFeatures");

  // SAFETY: each method is the real Registry's, called by name over the test's Durable Object, as the stub calls it.
  const registry = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...input: ReadonlyArray<unknown>) =>
          Effect.promise(() => call(method as keyof RegistryMethods, ...(input as [never]))),
    },
  ) as HarnessRegistry;

  // `background` runs at once: the push of a new request is the one thing handed to it here.
  const background = (effect: Effect.Effect<void>) => effect;

  const writes = endpointWrites({
    registry,
    builds: { of: () => Effect.void, rebuild: () => Effect.die("no Build") },
    spares: { of: () => Effect.void },
    background,
    credentials: [],
  });

  let attempts = 0;

  const ask = askApproval({ approvals: registry, writes, background, origin: ORIGIN });

  const runner = approvalRunner({
    approvals: registry,
    writes,
    upkeep: () => Effect.void,
    background,
  });

  return {
    call,
    runner,
    /** Ask for `tool`'s change with `args`, as the dispatcher hands it over. */
    ask: async (
      tool: string,
      args: Readonly<Record<string, Schema.Json>>,
      requestId?: string,
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
        }),
      );
    },
    wait: (approval_id: string, timeout_s?: number) =>
      Effect.runPromise(
        approvalWait({ approvals: registry, runner })(
          timeout_s === undefined ? { approval_id } : { approval_id, timeout_s },
          PI,
        ),
      ),
    withdraw: (approval_id: string) =>
      Effect.runPromise(approvalWithdraw({ approvals: registry })({ approval_id })),
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

    expect(applied).toMatchObject({ status: "finished", result: { text: expect.any(String) } });
    expect(applied?.result?.text).toContain("$20 per Session");
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
      answer: { text: applied?.result?.text },
    });
  });

  it("changes nothing when the target changed since the ask, and says so", async () => {
    const { ask, call, apply } = await started();
    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    await call("updateSettings", { overrides: { spendLimit: { perSession: 5 } } });
    await call("answerApproval", { id, approved: true });

    expect(await apply(id)).toMatchObject({
      status: "changed_since",
      reason: expect.stringContaining("$5 per Session"),
    });
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

    const resumed = await apply(id);

    expect(resumed).toMatchObject({ status: "finished" });
    expect(resumed?.result?.text).toContain("$20 per Session");
    expect(await call("listSettingsChanges")).toHaveLength(1);
  });

  it("applies nothing for a request that is not approved", async () => {
    const { ask, apply } = await started();
    const id = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    expect(await apply(id)).toMatchObject({ status: "pending" });
  });

  it("sets an Environment's size limit", async () => {
    const { ask, call, apply } = await started();

    const id = approvalIdOf(
      await ask("environment_container_size_limit_set", {
        id: DEFAULT_ENVIRONMENT,
        size: LARGER,
        reason: "Bigger builds",
      }),
    );

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

  it("resets an Environment's size limit to Global's once approved", async () => {
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

    await call("answerApproval", { id, approved: true });

    expect(await apply(id)).toMatchObject({ status: "finished" });
    expect(
      (await call("getEnvironmentSettings", { environment: DEFAULT_ENVIRONMENT }))?.overrides
        .maxInstance,
    ).toBeUndefined();
  });
});

describe("approval_wait", () => {
  it("clamps its time to 0–300 seconds, 45 when not given", () => {
    expect([waitSeconds(-5), waitSeconds(0), waitSeconds(999), waitSeconds()]).toEqual([
      0, 0, 300, 45,
    ]);
  });

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
      result: { text: expect.stringContaining("$20 per Session") },
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

  it("says a request it does not keep is not found", async () => {
    const { wait } = await started();

    expect(await wait("gone", 0)).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("approval_withdraw", () => {
  it("withdraws a waiting request, can be repeated, and is refused once the owner approved", async () => {
    const { ask, call, withdraw } = await started();
    const waiting = approvalIdOf(await ask("settings_spend_limit_set", SPEND));

    const approved = approvalIdOf(
      await ask("settings_subagent_depth_set", { scope: GLOBAL_SCOPE, depth: 3, reason: "Deeper" }),
    );

    await call("answerApproval", { id: approved, approved: true });

    const states: Array<ApiResult<ApprovalState>> = [
      await withdraw(waiting),
      await withdraw(waiting),
      await withdraw(approved),
    ];

    expect(states).toMatchObject([
      { ok: true, value: { status: "withdrawn", finished: true } },
      { ok: true, value: { status: "withdrawn", finished: true } },
      { ok: false, error: { code: "invalid_argument" } },
    ]);
  });
});
