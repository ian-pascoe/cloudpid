// docs/architecture/mcp-endpoint.md → Environment and Settings tools → The dispatcher and `describe().harness`: the
// `harness` operation's dispatcher over the Registry and the McpHosts alone (no Session): the five reads answered on the
// endpoint's surface, `unsupported` for a tool it does not serve, `invalid_argument` for input the shared schema refuses,
// the cores' `not_found` and `invalid_argument` mapped, and anything else `unavailable` with a fixed sentence.
// @effect-diagnostics globalJsonInEffect:off preferEffectArray:off missedPipeableOpportunity:off preferTypedSchemaDecoder:off schemaSync:off schemaSyncInEffect:off
import { EnvironmentsError } from "@cloudpid/extensions/environment";
import { HARNESS_TOOLS } from "@cloudpid/protocol/harness-tools";
import type { ApiResult, HarnessAnswer, HarnessRequest } from "@cloudpid/protocol/mcp-api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { HARNESS_TOOLS_SERVED } from "../mcp/api.ts";
import { harnessDispatch } from "./dispatch.ts";
import {
  type HostCalls,
  harnessHosts,
  harnessRegistry,
  type RegistryCalls,
} from "./registry.fixture.ts";
import { type HarnessRegistry, harnessServices } from "./services.ts";

const via = { era: "modern" } as const;

/** The dispatcher over the stand-in Registry (or `registry`) and a host, with what each was asked noted. */
const dispatching = (registry?: (calls: RegistryCalls) => HarnessRegistry) => {
  const registryCalls: RegistryCalls = [];
  const hostCalls: HostCalls = [];

  const dispatch = harnessDispatch(
    harnessServices({
      registry: registry === undefined ? harnessRegistry(registryCalls) : registry(registryCalls),
      mcpHosts: harnessHosts(hostCalls),
      appOrigin: "https://cloudpid.test",
    }),
  );

  const run = (tool: string, input: HarnessRequest["input"]): Promise<ApiResult<HarnessAnswer>> =>
    Effect.runPromise(dispatch({ tool, input, via }));

  return { run, registryCalls, hostCalls };
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
    "environment_variable_set",
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
