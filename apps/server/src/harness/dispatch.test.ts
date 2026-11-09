// docs/architecture/mcp-endpoint.md → Environment and Settings tools → The dispatcher and `describe().harness`, → Retries:
// `request_id`, → After a change, and Notifications: the `harness` operation's dispatcher over the Registry and the
// McpHosts alone (no Session): the five reads answered on the endpoint's surface, `unsupported` for a tool it does not
// serve, `invalid_argument` for input the shared schema refuses, the cores' `not_found` and `invalid_argument` mapped,
// and anything else `unavailable` with a fixed sentence; and the change tools' one path, over a Registry that records
// and claims as the real one does: the probe, the `request_id` (a repeat, other arguments, a cut before the settle, an
// answer lost after the commit, a claim another call took during the write or before a write that found the value set,
// a lookup failing before any write, the `approval:` prefix), the Registry's refusals (one that heals is `unavailable`),
// the author recorded, and the upkeep and the notice after the answer.
// @effect-diagnostics globalJsonInEffect:off preferEffectArray:off missedPipeableOpportunity:off preferTypedSchemaDecoder:off schemaSync:off schemaSyncInEffect:off
import { SUPPORTED_MODELS } from "@cloudpid/config";
import { EnvironmentsError } from "@cloudpid/extensions/environment";
import { SETTINGS_SCOPE } from "@cloudpid/protocol";
import { APPROVAL_REQUEST_PREFIX, HARNESS_TOOLS } from "@cloudpid/protocol/harness-tools";
import type { ApiResult, HarnessAnswer, HarnessRequest } from "@cloudpid/protocol/mcp-api";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { HARNESS_TOOLS_SERVED } from "../mcp/api.ts";
import type { ChangeAnswer } from "../registry/change-requests.ts";
import { SECRETS_CHANGED } from "../registry/via-secrets.ts";
import { harnessDispatch, requestDigest } from "./dispatch.ts";
import {
  type ChangeOptions,
  changingRegistry,
  HOLDS_KEPT_SECRET,
  type HostCalls,
  harnessHosts,
  harnessRegistry,
  harnessUpkeep,
  type RegistryCalls,
} from "./registry.fixture.ts";
import { type HarnessRegistry, harnessServices } from "./services.ts";

const via = { era: "modern" } as const;

/** The verified caller a change is recorded as made by. */
const caller = {
  auth: "oauth",
  client: { name: "pi", version: "1.0.0" },
  clientId: "grant-1",
} as const;

/** The dispatcher over the stand-in Registry (or `registry`) and a host, with what each was asked noted. */
const dispatching = (registry?: (calls: RegistryCalls) => HarnessRegistry) => {
  const registryCalls: RegistryCalls = [];
  const hostCalls: HostCalls = [];
  const upkeep = harnessUpkeep();

  const dispatch = harnessDispatch(
    harnessServices({
      registry: registry === undefined ? harnessRegistry(registryCalls) : registry(registryCalls),
      mcpHosts: harnessHosts(hostCalls),
      appOrigin: "https://cloudpid.test",
      ...upkeep.deps,
    }),
  );

  const run = (tool: string, input: HarnessRequest["input"]): Promise<ApiResult<HarnessAnswer>> =>
    Effect.runPromise(dispatch({ tool, input, via }, caller));

  return { run, registryCalls, hostCalls };
};

/**
 * The dispatcher over the writing stand-in: `call` runs one tool as `McpServer` sends it (the `request_id` in the input
 * and on the request), each call's attempt numbered in order.
 */
const changing = (options: ChangeOptions = {}, rebuilds: Array<"asked" | "underway"> = []) => {
  const registryCalls: RegistryCalls = [];
  const { registry, ledger } = changingRegistry(registryCalls, options);
  const upkeep = harnessUpkeep([], rebuilds);
  let attempts = 0;

  const dispatch = harnessDispatch(
    harnessServices({
      registry,
      mcpHosts: harnessHosts(),
      appOrigin: "https://cloudpid.test",
      ...upkeep.deps,
    }),
    { newAttempt: () => `attempt-${String(++attempts)}` },
  );

  const call = (tool: string, input: { readonly [key: string]: Schema.Json }) =>
    dispatch(
      // The input's `request_id` is the request's too, as `McpServer` copies it there.
      Option.match(Schema.decodeUnknownOption(Schema.String)(input["request_id"]), {
        onNone: (): HarnessRequest => ({ tool, input, via }),
        onSome: (requestId): HarnessRequest => ({ tool, input, requestId, via }),
      }),
      caller,
    );

  return { call, registryCalls, ledger, upkeep };
};

/** The value of an answer that succeeded, read with the tool's own endpoint output schema: a wrong shape fails the test. */
const valueOf = <S extends Schema.Codec<unknown, unknown>>(
  output: S,
  result: ApiResult<HarnessAnswer>,
): S["Type"] => {
  if (!result.ok) throw new Error(`The tool failed: ${result.error.message}`);

  return Schema.decodeUnknownSync(output)(result.value.structured);
};

describe("the five reads, over a Registry and hosts alone", () => {
  it("answer environment_list with no Environment marked a Session's own", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = dispatching();
        const result = yield* Effect.promise(() => run("environment_list", {}));
        const value = valueOf(HARNESS_TOOLS.environment_list.endpoint.output, result);

        expect(value).toMatchObject({ environments: [{ id: "default", name: "Default" }] });
        expect(JSON.stringify(result)).not.toContain("current");
        expect(result.ok && result.value.text).toContain("default");
        expect(result.ok && result.value.text).not.toContain("this Session's");
      }),
    ));

  it("answer environment_get, a page of a field with next_offset, and Global", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = dispatching();

        const whole = valueOf(
          HARNESS_TOOLS.environment_get.endpoint.output,
          yield* Effect.promise(() => run("environment_get", { id: "default" })),
        );

        expect(whole).toMatchObject({ scope: { id: "default" }, settings_truncated: true });

        const first = valueOf(
          HARNESS_TOOLS.environment_get.endpoint.output,
          yield* Effect.promise(() =>
            run("environment_get", { id: "default", field: "setupScript" }),
          ),
        );

        expect(first).toMatchObject({ id: "default", field: "setupScript", offset: 0 });
        expect(first.next_offset).toBe(40_000);

        const last = valueOf(
          HARNESS_TOOLS.environment_get.endpoint.output,
          yield* Effect.promise(() =>
            run("environment_get", { id: "default", field: "setupScript", offset: 40_000 }),
          ),
        );

        expect(last.offset).toBe(40_000);
        expect(last.next_offset).toBeUndefined();

        const global = valueOf(
          HARNESS_TOOLS.environment_get.endpoint.output,
          yield* Effect.promise(() => run("environment_get", { id: "*" })),
        );

        expect(global.scope).toEqual({ id: "*", name: "Global" });
      }),
    ));

  it("answer settings_get for Global and for an Environment, whose Instructions page is its own text", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = dispatching();

        const global = valueOf(
          HARNESS_TOOLS.settings_get.endpoint.output,
          yield* Effect.promise(() => run("settings_get", { scope: "*" })),
        );

        expect(global.scope).toEqual({ id: "*", name: "Global" });

        const own = valueOf(
          HARNESS_TOOLS.settings_get.endpoint.output,
          yield* Effect.promise(() =>
            run("settings_get", { scope: "default", field: "instructions" }),
          ),
        );

        expect(own).toMatchObject({ id: "default", field: "instructions", text: "Run the tests." });
      }),
    ));

  it("answer settings_mcp_list and settings_mcp_get, asking the Environment's host for the held inventory", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run, hostCalls } = dispatching();

        const list = valueOf(
          HARNESS_TOOLS.settings_mcp_list.endpoint.output,
          yield* Effect.promise(() => run("settings_mcp_list", { scope: "default" })),
        );

        expect(list.servers).toMatchObject([{ name: "docs" }]);
        expect(list.inventory).toBe("read");

        const one = valueOf(
          HARNESS_TOOLS.settings_mcp_get.endpoint.output,
          yield* Effect.promise(() => run("settings_mcp_get", { scope: "default", name: "docs" })),
        );

        expect(one.server.name).toBe("docs");
        expect(one.tool_count).toBe(1);
        expect(hostCalls.map(({ host }) => host)).toEqual(["mcp:default", "mcp:default"]);
      }),
    ));
});

describe("a tool it does not serve", () => {
  it.each([
    "environment_skill_save",
    "approval_wait",
    "environments_list",
    "no_such_tool",
    "constructor",
    "",
  ])("is unsupported, and no service is asked (%j)", (tool) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run, registryCalls, hostCalls } = dispatching();
        const result = yield* Effect.promise(() => run(tool, {}));

        expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
        expect(registryCalls).toEqual([]);
        expect(hostCalls).toEqual([]);
      }),
    ),
  );

  it("is served exactly for the tools describe() lists", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = dispatching();

        for (const tool of HARNESS_TOOLS_SERVED) {
          const result = yield* Effect.promise(() => run(tool, {}));

          // An empty input is refused by the tool's own schema where it needs arguments: never as unsupported.
          expect(!result.ok && result.error.code === "unsupported", tool).toBe(false);
        }
      }),
    ));
});

describe("input the shared schema refuses", () => {
  it.each([
    ["environment_get", {}],
    ["environment_get", { id: 3 }],
    ["environment_get", { id: "default", field: "name" }],
    ["environment_get", { id: "default", field: "variables.bad-name" }],
    ["environment_get", { id: "default", field: "setupScript", offset: -1 }],
    ["environment_get", { id: "default", field: "setupScript", offset: 1.5 }],
    ["settings_get", { scope: "*", field: "model" }],
    ["settings_mcp_get", { scope: "default" }],
  ])("is invalid_argument, naming the tool, and no service is asked (%s %j)", (tool, input) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run, registryCalls } = dispatching();
        const result = yield* Effect.promise(() => run(tool, input));

        expect(result).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
        expect(!result.ok && result.error.message.startsWith(`${tool}: `)).toBe(true);
        expect(!result.ok && result.error.message.length).toBeLessThanOrEqual(500);
        expect(registryCalls).toEqual([]);
      }),
    ),
  );

  it("reads an offset with no field as the core's own invalid_argument", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = dispatching();

        for (const [tool, input] of [
          ["environment_get", { id: "default", offset: 10 }],
          ["settings_get", { scope: "*", offset: 10 }],
          ["environment_get", { id: "default", field: "setupScript", offset: 999_999 }],
        ] as const) {
          const result = yield* Effect.promise(() => run(tool, input));

          expect(result, tool).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
        }
      }),
    ));
});

describe("what a core refuses", () => {
  it.each([
    ["environment_get", { id: "ghost" }],
    ["settings_get", { scope: "ghost" }],
    ["settings_mcp_list", { scope: "ghost" }],
    ["settings_mcp_get", { scope: "default", name: "nope" }],
  ])("is not_found for an id or name that names nothing (%s %j)", (tool, input) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = dispatching();
        const result = yield* Effect.promise(() => run(tool, input));

        expect(result).toMatchObject({ ok: false, error: { code: "not_found", retryable: false } });
      }),
    ),
  );
});

describe("what fails without a code", () => {
  const failing = (fail: Effect.Effect<never, EnvironmentsError>) => (calls: RegistryCalls) => ({
    ...harnessRegistry(calls),
    // SAFETY: the stand-in answers the one method the test breaks with an Effect that fails as the core's service does.
    listEnvironments: () => fail,
  });

  it("is unavailable with a fixed sentence that holds none of the service's own words", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { run } = dispatching(
          // SAFETY: a Registry whose list fails with a message of its own and no code.
          failing(
            Effect.fail(EnvironmentsError.make({ message: "D1 shard 7 is down at 10.0.0.3" })),
          ) as never,
        );

        const result = yield* Effect.promise(() => run("environment_list", {}));

        expect(result).toEqual({
          ok: false,
          error: {
            code: "unavailable",
            message: "cloudpid could not read that just now: try again shortly.",
            retryable: true,
          },
        });
      }),
    ));

  it("is unavailable too when a service dies", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        // SAFETY: a Registry whose list is a defect, as a failed RPC is.
        const { run } = dispatching(failing(Effect.die("rpc cut at 10.0.0.3")) as never);
        const result = yield* Effect.promise(() => run("environment_list", {}));

        expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
        expect(JSON.stringify(result)).not.toContain("10.0.0.3");
      }),
    ));
});

describe("a change", () => {
  const reason = "The tests read it";

  it.each([
    [
      "environment_variable_set",
      { id: "default", name: "API_URL", value: "https://a.test", reason },
    ],
    ["environment_variable_unset", { id: "default", name: "TOKEN_URL", reason }],
    ["environment_container_resize", { id: "default", size: "cpu-2", reason }],
    ["environment_idle_time_set", { id: "default", minutes: 5, reason }],
    ["environment_setup_script_set", { id: "default", script: "echo hi", reason }],
    ["environment_start_script_set", { id: "*", script: "echo hi", reason }],
    ["environment_toolchains_set", { id: "default", mise_toml: '[tools]\nnode = "22"', reason }],
    ["environment_ignore_set", { id: "default", patterns: ["/data"], reason }],
    ["environment_spare_workspace_set", { id: "*", enabled: false, reason }],
    ["environment_secret_build", { id: "default", name: "API_KEY", build: false, reason }],
  ] as const)(
    "%s is made as the caller, answered as its schema declares, then upkept and noticed after the answer",
    (tool, input) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { call, ledger, registryCalls, upkeep } = changing();

          // The variable the unset takes out is the Environment's own.
          ledger.values.set("default:variables.TOKEN_URL", "https://example.test/token");

          const result = yield* call(tool, input);

          expect(result.ok, JSON.stringify(result)).toBe(true);

          if (result.ok) {
            Schema.decodeUnknownSync(HARNESS_TOOLS[tool].endpoint.output)(result.value.structured);
          }

          expect(ledger.changes).toHaveLength(1);
          expect(ledger.changes[0]?.author).toEqual({ via: caller, tool, reason });
          // Nothing runs after the change until the answer is sent.
          expect(upkeep.calls).toEqual([]);
          expect(registryCalls).not.toContain("notifyMcpChanges");

          yield* upkeep.runBackground;

          expect(upkeep.calls).toContain("builds.of:default");
          expect(registryCalls.filter((method) => method === "notifyMcpChanges")).toHaveLength(1);
        }),
      ),
  );

  it("asks the probe before anything, and refuses while an older Registry answers it, writing nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const features of [
          Effect.succeed({ via: false }),
          Effect.die("rpc: no such method"),
        ]) {
          const { call, ledger, registryCalls } = changing({ features });

          const result = yield* call("environment_variable_set", {
            id: "default",
            name: "API_URL",
            value: "https://a.test",
            reason,
          });

          expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
          expect(registryCalls).toEqual(["agentChangeFeatures"]);
          expect(ledger.changes).toEqual([]);
        }
      }),
    ));

  it("maps the Registry's refusal of a kept Secret to invalid_argument, with nothing recorded or noticed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls, upkeep } = changing({ keptSecret: "s3cret-value" });

        const result = yield* call("environment_variable_set", {
          id: "*",
          name: "API_URL",
          value: "Bearer s3cret-value",
          reason,
        });

        expect(result).toMatchObject({
          ok: false,
          error: { code: "invalid_argument", message: HOLDS_KEPT_SECRET },
        });

        yield* upkeep.runBackground;

        expect(ledger.changes).toEqual([]);
        expect(registryCalls).not.toContain("notifyMcpChanges");
      }),
    ));

  it("maps the Registry's refusal of a mark whose reason holds a kept Secret to invalid_argument, in its words", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls } = changing({ keptSecret: "s3cret-value" });

        const result = yield* call("environment_secret_build", {
          id: "default",
          name: "API_KEY",
          build: false,
          reason: "s3cret-value is the registry's",
          request_id: "r-1",
        });

        expect(result).toMatchObject({
          ok: false,
          error: { code: "invalid_argument", message: HOLDS_KEPT_SECRET, retryable: false },
        });
        expect(ledger.changes).toEqual([]);
        expect(registryCalls).not.toContain("notifyMcpChanges");
      }),
    ));

  it("answers the Registry's refusal of a check that heals (the kept Secrets changed meanwhile) as unavailable, in its words", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger } = changing({ keptSecret: "s3cret-value", refusal: SECRETS_CHANGED });

        const result = yield* call("environment_variable_set", {
          id: "default",
          name: "API_URL",
          value: "Bearer s3cret-value",
          reason,
        });

        expect(result).toMatchObject({
          ok: false,
          error: { code: "unavailable", message: SECRETS_CHANGED, retryable: true },
        });
        expect(ledger.changes).toEqual([]);
      }),
    ));

  it("that finds the value set already claims nothing and sends no notice", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls, upkeep } = changing();
        const input = { id: "default", minutes: 5, reason, request_id: "r-1" };

        ledger.values.set("default:idleMinutes", 5);

        const result = yield* call("environment_idle_time_set", input);

        yield* upkeep.runBackground;

        expect(result).toMatchObject({
          ok: true,
          value: { structured: { unchanged: ["idleMinutes"] } },
        });
        expect(ledger.claims.size).toBe(0);
        expect(registryCalls).not.toContain("settleChangeRequest");
        expect(registryCalls).not.toContain("notifyMcpChanges");
      }),
    ));
});

describe("the lifecycle, Skill and reset tools", () => {
  const reason = "The tests read it";

  it.each([
    [
      "environment_create",
      { name: "Billing", repos: ["o/api"], reason },
      ["spares.of:made-1", "builds.of:made-1", "mcp.sync:made-1"],
    ],
    ["environment_rename", { id: "default", name: "Renamed", reason }, []],
    [
      "environment_repo_add",
      { id: "default", url: "o/lib", reason },
      ["spares.of:default", "builds.of:default", "mcp.sync:default"],
    ],
    [
      "environment_repo_remove",
      { id: "default", name: "app", reason },
      ["spares.of:default", "builds.of:default", "mcp.sync:default"],
    ],
    ["environment_rebuild", { id: "default", reason }, []],
    ["environment_skill_install", { id: "default", source: "o/skills", skills: ["a"], reason }, []],
    ["environment_skill_update", { id: "default", names: ["a"], reason }, []],
    ["environment_skill_remove", { id: "default", name: "a", reason }, []],
    [
      "environment_setting_reset",
      { id: "default", setting: "setupScript", reason },
      ["builds.of:default"],
    ],
  ] as const)(
    "%s is made as the caller, answered as its schema declares, then upkept and noticed after the answer",
    (tool, input, upkept) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { call, ledger, registryCalls, upkeep } = changing();

          // The setting the reset takes out is the Environment's own.
          ledger.values.set("default:setupScript", "echo own");

          const result = yield* call(tool, input);

          expect(result.ok, JSON.stringify(result)).toBe(true);

          if (result.ok) {
            Schema.decodeUnknownSync(HARNESS_TOOLS[tool].endpoint.output)(result.value.structured);
          }

          expect(ledger.changes).toHaveLength(1);
          expect(ledger.changes[0]?.author).toEqual({ via: caller, tool, reason });
          // Nothing runs after the change until the answer is sent.
          expect(upkeep.calls).toEqual([]);
          expect(registryCalls).not.toContain("notifyMcpChanges");

          yield* upkeep.runBackground;

          expect(upkeep.calls).toEqual(upkept);
          expect(registryCalls.filter((method) => method === "notifyMcpChanges")).toHaveLength(1);
        }),
      ),
  );

  it("looks at a Repo's .pi/mcp.json before the set is pushed when one is added", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, registryCalls, upkeep } = changing();

        yield* call("environment_repo_add", { id: "default", url: "o/lib", reason });
        yield* upkeep.runBackground;

        expect(registryCalls).toContain("mcpLookRepoFiles");
        expect(upkeep.calls).toContain("mcp.sync:default");
      }),
    ));

  it("only pushes the set when a Repo is taken out", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, registryCalls, upkeep } = changing();

        yield* call("environment_repo_remove", { id: "default", name: "app", reason });
        yield* upkeep.runBackground;

        expect(registryCalls).not.toContain("mcpLookRepoFiles");
        expect(upkeep.calls).toContain("mcp.sync:default");
      }),
    ));

  it("answers environment_create with the new Environment's id, name and Repos", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call } = changing();

        const value = valueOf(
          HARNESS_TOOLS.environment_create.endpoint.output,
          yield* call("environment_create", { name: "Billing", repos: ["o/api"], reason }),
        );

        expect(value).toMatchObject({
          scope: { id: "made-1", name: "Billing" },
          changed: true,
          repos: [{ name: "api" }],
        });
      }),
    ));

  it("reports each Skill of an install: one refused beside one installed is recorded", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls, upkeep } = changing();

        const mixed = valueOf(
          HARNESS_TOOLS.environment_skill_install.endpoint.output,
          yield* call("environment_skill_install", {
            id: "default",
            source: "o/skills",
            skills: ["a", "big"],
            reason,
          }),
        );

        expect(mixed).toMatchObject({
          changed: true,
          installed: [{ name: "a" }],
          refused: [{ name: "big", message: "too large" }],
        });

        yield* upkeep.runBackground;

        expect(ledger.changes).toHaveLength(1);
        expect(registryCalls).toContain("notifyMcpChanges");
      }),
    ));

  it("reports an install whose Skills were all refused as no failure, and records nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls, upkeep } = changing();

        const none = valueOf(
          HARNESS_TOOLS.environment_skill_install.endpoint.output,
          yield* call("environment_skill_install", {
            id: "default",
            source: "o/skills",
            skills: ["big"],
            reason,
            request_id: "r-1",
          }),
        );

        expect(none).toMatchObject({ changed: false, installed: [], refused: [{ name: "big" }] });
        expect(ledger.changes).toEqual([]);

        yield* upkeep.runBackground;

        expect(registryCalls).not.toContain("notifyMcpChanges");
      }),
    ));

  // #687 → `environment_rebuild`: the Build is asked for before the change is recorded, so a call cut between the two
  // claims nothing, and its repeat finds the Build under way and asks for none.
  it("asks for one Build only when a call is cut between builds.rebuild and recordRebuild: the repeat sees it under way", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let cuts = 0;

        const { call, ledger } = changing(
          { beforeRecordRebuild: () => (cuts++ === 0 ? Effect.die("cut") : Effect.void) },
          ["asked", "underway"],
        );

        const input = { id: "default", reason, request_id: "r-1" };

        const first = yield* call("environment_rebuild", input);

        expect(first).toMatchObject({ ok: false, error: { code: "unavailable" } });
        expect(ledger.claims.size).toBe(0);

        const repeat = valueOf(
          HARNESS_TOOLS.environment_rebuild.endpoint.output,
          yield* call("environment_rebuild", input),
        );

        expect(repeat).toMatchObject({ changed: false, new_build: false, unchanged: ["build"] });
        expect(ledger.changes).toEqual([]);
      }),
    ));

  it("lists the Skills a repo holds when none is named, and installs nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger } = changing();

        const value = valueOf(
          HARNESS_TOOLS.environment_skill_install.endpoint.output,
          yield* call("environment_skill_install", { id: "default", source: "o/skills", reason }),
        );

        expect(value).toMatchObject({ changed: false, listed: [{ name: "grill-me" }] });
        expect(ledger.changes).toEqual([]);
      }),
    ));

  it("refuses a Skill that is not there as not_found", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call } = changing();

        const gone = yield* call("environment_skill_remove", {
          id: "default",
          name: "zzz",
          reason,
        });

        expect(gone).toMatchObject({ ok: false, error: { code: "not_found" } });
      }),
    ));

  it("refuses an Environment that is not there as not_found", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call } = changing();
        const none = yield* call("environment_rename", { id: "ghost", name: "X", reason });

        expect(none).toMatchObject({ ok: false, error: { code: "not_found" } });
      }),
    ));

  it.each([
    [
      "a Skill install at Global",
      "environment_skill_install",
      { id: "*", source: "o/skills", reason },
    ],
    ["a Skill update at Global", "environment_skill_update", { id: "*", reason }],
    ["a Skill removal at Global", "environment_skill_remove", { id: "*", name: "a", reason }],
    [
      "a Test Build of proposed changes",
      "environment_rebuild",
      { id: "default", reason, proposed: { setup_script: "echo hi" } },
    ],
    [
      "the reset of the size limit",
      "environment_setting_reset",
      { id: "default", setting: "maxInstance", reason },
    ],
  ] as const)(
    "answers %s as unsupported, before the Registry is asked anything",
    (_, tool, input) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { call, registryCalls, ledger } = changing();

          const result = yield* call(tool, { ...input, request_id: "r-1" });

          expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });
          expect(registryCalls).toEqual([]);
          expect(ledger.claims.size).toBe(0);
        }),
      ),
  );

  it.each([
    ["environment_rename", { id: "*", name: "X", reason }],
    ["environment_setting_reset", { id: "*", setting: "setupScript", reason }],
  ] as const)("refuses %s at Global as invalid_argument", (tool, input) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger } = changing();
        const result = yield* call(tool, input);

        expect(result).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
        expect(ledger.changes).toEqual([]);
      }),
    ),
  );

  // #687 L17: a call cut between its write and its settle is answered from the records, which each family reads.
  it.each([
    [
      "environment_create",
      { name: "Billing", repos: ["o/api"], reason },
      { scope: { id: "made-1", name: "Billing" }, repos: [{ name: "api" }] },
    ],
    [
      "environment_skill_install",
      { id: "default", source: "o/skills", skills: ["a", "b"], reason },
      { installed: [{ name: "a" }, { name: "b" }], source: { repo: "o/skills" } },
    ],
    [
      "environment_skill_update",
      { id: "default", names: ["a"], reason },
      { updated: [{ name: "a", to: { commit: "f".repeat(40) } }] },
    ],
  ] as const)(
    "answers a repeat of %s whose call was cut before its settle from its records",
    (tool, input, expected) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { call, ledger } = changing({ beforeSettle: () => Effect.never });

          const withId = { ...input, request_id: "r-1" };

          yield* Effect.exit(call(tool, withId).pipe(Effect.timeout("20 millis")));

          expect(ledger.claims.get("r-1")?.answer).toBeNull();

          const repeat = yield* call(tool, withId);

          expect(repeat.ok, JSON.stringify(repeat)).toBe(true);

          if (repeat.ok) {
            const value = Schema.decodeUnknownSync(HARNESS_TOOLS[tool].endpoint.output)(
              repeat.value.structured,
            );

            expect(value).toMatchObject({ ...expected, replayed: true });
          }

          expect(ledger.changes.length).toBeGreaterThan(0);
        }),
      ),
  );
});

describe("a change to the Settings or an MCP server", () => {
  const reason = "The tests read it";

  it.each([
    ["settings_model_set", { scope: "default", thinking_level: "high", reason }, "default"],
    ["settings_model_set", { scope: "*", thinking_level: "high", reason }, SETTINGS_SCOPE],
    ["settings_compaction_set", { scope: "default", enabled: false, reason }, "default"],
    ["settings_tool_offer", { scope: "*", pattern: "web_*", reason }, SETTINGS_SCOPE],
  ] as const)(
    "%s is recorded as the caller at %j, answered as its schema declares, and noticed after the answer",
    (tool, input, recordedAt) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { call, ledger, registryCalls, upkeep } = changing();

          const result = yield* call(tool, input);

          expect(result.ok, JSON.stringify(result)).toBe(true);

          if (result.ok) {
            const value = Schema.decodeUnknownSync(HARNESS_TOOLS[tool].endpoint.output)(
              result.value.structured,
            );

            expect(value).toMatchObject({ scope: { id: input.scope }, unchanged: [] });
          }

          expect(ledger.changes).toHaveLength(1);
          expect(ledger.changes[0]?.change.scope).toBe(recordedAt);
          expect(ledger.changes[0]?.author).toEqual({ via: caller, tool, reason });
          expect(registryCalls).not.toContain("notifyMcpChanges");

          yield* upkeep.runBackground;

          expect(registryCalls.filter((method) => method === "notifyMcpChanges")).toHaveLength(1);
          // A Settings field makes no Build, no spare and no push of a server set.
          expect(upkeep.calls).toEqual([]);
        }),
      ),
  );

  /** `settings_mcp_disable` of `docs` over a host that takes the set, or (`applyFails`) fails to. */
  const disabling = (applyFails: boolean) => {
    const hostCalls: HostCalls = [];
    const registryCalls: RegistryCalls = [];
    const { registry, ledger } = changingRegistry(registryCalls);
    const upkeep = harnessUpkeep();

    const dispatch = harnessDispatch(
      harnessServices({
        registry,
        mcpHosts: harnessHosts(hostCalls, { applyFails }),
        appOrigin: "https://cloudpid.test",
        ...upkeep.deps,
      }),
    );

    const result = dispatch(
      { tool: "settings_mcp_disable", input: { scope: "default", name: "docs", reason }, via },
      caller,
    );

    return { result, hostCalls, registryCalls, ledger, upkeep };
  };

  it("settings_mcp_disable is recorded as the caller and its set pushed to the host before the answer, with nothing left to sync", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { result: answered, hostCalls, registryCalls, ledger, upkeep } = disabling(false);
        const result = yield* answered;

        expect(result.ok, JSON.stringify(result)).toBe(true);

        if (result.ok) {
          Schema.decodeUnknownSync(HARNESS_TOOLS.settings_mcp_disable.endpoint.output)(
            result.value.structured,
          );
        }

        expect(ledger.changes[0]?.change).toMatchObject({
          scope: "default",
          field: "mcp.servers.docs.enabled",
          after: false,
        });
        expect(ledger.changes[0]?.author).toEqual({
          via: caller,
          tool: "settings_mcp_disable",
          reason,
        });

        expect(hostCalls).toContainEqual({ host: "mcp:default", method: "apply" });
        // The push is before the answer; it took, so nothing is handed on.
        expect(registryCalls).toContain("mcpPushed");

        yield* upkeep.runBackground;

        expect(upkeep.calls).toEqual([]);
      }),
    ));

  it("settings_mcp_disable over a host that fails the push names the Environment, and schedules one sync of it after the answer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { result: answered, registryCalls, ledger, upkeep } = disabling(true);
        const result = yield* answered;

        // The change stands and the call does not fail for the host.
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(ledger.changes).toHaveLength(1);
        expect(registryCalls).not.toContain("mcpPushed");

        if (result.ok) expect(result.value.text).toContain("Default");

        // Under `background`, so after the answer, and once.
        expect(upkeep.calls).toEqual([]);

        yield* upkeep.runBackground;

        expect(upkeep.calls).toEqual(["mcp.sync:default"]);
      }),
    ));

  // The one row of the code's mapping: which refusals are `unsupported` is `settings-endpoint.test.ts`'s.
  it("maps a core's unsupported refusal through, with nothing recorded or noticed", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls, upkeep } = changing();

        const result = yield* call("settings_reset", {
          scope: "*",
          field: "spendLimit.perSession",
          reason,
        });

        expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } });

        yield* upkeep.runBackground;

        expect(ledger.changes).toEqual([]);
        expect(registryCalls).not.toContain("notifyMcpChanges");
      }),
    ));

  it("refuses a value that holds a kept Secret as invalid_argument, in the Registry's words, and records nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls } = changing({ keptSecret: "s3cret-value" });

        const result = yield* call("settings_role_set", {
          scope: "default",
          role: "small",
          model: SUPPORTED_MODELS[0],
          hint: "Pick it when s3cret-value is needed",
          reason,
        });

        expect(result).toMatchObject({
          ok: false,
          error: { code: "invalid_argument", message: HOLDS_KEPT_SECRET, retryable: false },
        });
        expect(ledger.changes).toEqual([]);
        expect(registryCalls).not.toContain("notifyMcpChanges");
      }),
    ));

  it("is settled with its request_id, a repeat getting the same bytes, and a cut call answered from its records as Global's", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let cut = false;

        const { call, ledger } = changing({
          beforeSettle: () => {
            if (cut) return Effect.void;

            cut = true;

            return Effect.never;
          },
        });

        const input = { scope: "*", thinking_level: "high", reason, request_id: "r-9" };

        yield* Effect.exit(call("settings_model_set", input).pipe(Effect.timeout("20 millis")));

        const repeat = yield* call("settings_model_set", input);

        expect(repeat.ok).toBe(true);

        if (repeat.ok) {
          expect(
            Schema.decodeUnknownSync(HARNESS_TOOLS.settings_model_set.endpoint.output)(
              repeat.value.structured,
            ),
          ).toMatchObject({ scope: { id: "*", name: "Global" }, replayed: true });
        }

        expect(ledger.changes).toHaveLength(1);
      }),
    ));
});

describe("a request_id", () => {
  const input = {
    id: "default",
    name: "API_URL",
    value: "https://a.test",
    reason: "The tests read it",
    request_id: "r-1",
  };

  it("is settled with the answer before the answer is sent, and a repeat gets the same bytes and changes nothing", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls } = changing();
        const first = yield* call("environment_variable_set", input);

        expect(ledger.claims.get("r-1")).toMatchObject({ attempt: "attempt-1", changes: [1] });
        expect(ledger.claims.get("r-1")?.answer).toEqual(first.ok ? first.value : undefined);

        const again = yield* call("environment_variable_set", input);

        expect(again).toEqual(first);
        expect(ledger.changes).toHaveLength(1);
        expect(registryCalls.filter((method) => method === "changeEnvironment")).toHaveLength(1);
      }),
    ));

  it.each([
    ["other arguments", "environment_variable_set", { ...input, value: "https://b.test" }],
    [
      "another tool",
      "environment_variable_unset",
      { id: "default", name: "API_URL", reason: "r", request_id: "r-1" },
    ],
  ] as const)(
    "used again with %s is invalid_argument, and nothing more is recorded",
    (_, tool, again) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const { call, ledger } = changing();

          yield* call("environment_variable_set", input);

          const result = yield* call(tool, again);

          expect(result).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
          expect(ledger.changes).toHaveLength(1);
        }),
      ),
  );

  it("beginning approval: is invalid_argument before the Registry is asked anything", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, registryCalls } = changing();

        const result = yield* call("environment_variable_set", {
          ...input,
          request_id: `${APPROVAL_REQUEST_PREFIX}a-1`,
        });

        expect(result).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
        expect(registryCalls).toEqual([]);
      }),
    ));

  // #687 → Ordering against `waitUntil`: a call cut between its write and its settle.
  it("whose call was cut before its settle is answered from the recorded changes, upkept again, then with the first answer once it settles", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let cut: ChangeAnswer | undefined;

        const { call, ledger, upkeep } = changing({
          beforeSettle: (answer) => {
            if (cut !== undefined) return Effect.void;

            cut = answer;

            return Effect.never;
          },
        });

        const first = yield* Effect.exit(
          call("environment_variable_set", input).pipe(Effect.timeout("20 millis")),
        );

        expect(first._tag).toBe("Failure");
        expect(ledger.claims.get("r-1")?.answer).toBeNull();

        // The cut call's upkeep never ran; the repeat's does, after its answer.
        upkeep.pending.length = 0;

        const repeat = yield* call("environment_variable_set", input);

        expect(repeat.ok).toBe(true);

        if (repeat.ok) {
          const value = Schema.decodeUnknownSync(
            HARNESS_TOOLS.environment_variable_set.endpoint.output,
          )(repeat.value.structured);

          expect(value).toMatchObject({
            scope: { id: "default", name: "Default" },
            changes: [{ id: 1, field: "variables.API_URL", before: null, after: "https://a.test" }],
            replayed: true,
          });
        }

        expect(ledger.changes).toHaveLength(1);
        expect(upkeep.calls).toEqual([]);

        yield* upkeep.runBackground;

        expect(upkeep.calls).toContain("builds.of:default");

        // The cut call's settle lands late: the claim's first answer is kept from then on.
        const held = ledger.claims.get("r-1");

        if (held !== undefined && cut !== undefined) held.answer = cut;

        const settled = yield* call("environment_variable_set", input);

        expect(settled).toEqual({ ok: true, value: cut });
      }),
    ));

  it("whose answer is lost after its write committed is answered from its own claim, upkept and noticed after the answer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls, upkeep } = changing({
          afterWrite: () => Effect.die("rpc cut after the commit"),
        });

        const result = yield* call("environment_variable_set", input);

        expect(result).toMatchObject({ ok: true, value: { structured: { replayed: true } } });
        expect(ledger.changes).toHaveLength(1);
        expect(ledger.claims.get("r-1")).toMatchObject({ attempt: "attempt-1", answer: null });
        expect(upkeep.calls).toEqual([]);

        yield* upkeep.runBackground;

        expect(upkeep.calls).toContain("builds.of:default");
        expect(registryCalls.filter((method) => method === "notifyMcpChanges")).toHaveLength(1);
      }),
    ));

  it("whose write found the change made by another call with the same request_id answers that call's answer", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger, registryCalls } = changing();
        const first = yield* call("environment_variable_set", input);
        const { claims } = ledger;
        const held = claims.get.bind(claims);
        let looked = false;

        // This call looks the id up just before the first call's write commits: it finds none, then the value set.
        claims.get = (id) => {
          if (looked) return held(id);

          looked = true;

          return undefined;
        };

        const second = yield* call("environment_variable_set", input);

        expect(second).toEqual(first);
        expect(ledger.changes).toHaveLength(1);
        expect(registryCalls.filter((method) => method === "changeRequest")).toHaveLength(3);
      }),
    ));

  it("whose lookup fails before any write says nothing was changed, so a retry is safe", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger } = changing();
        const { claims } = ledger;

        claims.get = () => {
          throw new Error("rpc cut");
        };

        const result = yield* call("environment_variable_set", input);

        expect(result).toMatchObject({
          ok: false,
          error: { code: "unavailable", retryable: true },
        });
        // The sentence is the contract: it tells the caller whether the change may have been made.
        expect(result.ok ? "" : result.error.message).toContain("nothing was changed");
        expect(ledger.changes).toEqual([]);
      }),
    ));

  it("that another call claims while this one writes is answered as that call's, with nothing recorded twice", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const { call, ledger } = changing();
        const { claims } = ledger;
        const held = claims.get.bind(claims);
        let looked = false;

        // Another call with the same request_id claims it just after this call's lookup found none.
        claims.get = (id) => {
          const found = held(id);

          if (!looked) {
            looked = true;
            claims.set(id, {
              tool: "environment_variable_set",
              digest: requestDigest("environment_variable_set", input),
              attempt: "the-other-call",
              answer: null,
              changes: [],
            });
          }

          return found;
        };

        const result = yield* call("environment_variable_set", input);

        expect(result).toMatchObject({ ok: true, value: { structured: { replayed: true } } });
        expect(ledger.changes).toEqual([]);
      }),
    ));
});
