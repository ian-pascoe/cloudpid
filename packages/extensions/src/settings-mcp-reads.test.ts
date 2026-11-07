// The cores of `settings_mcp_list` and `settings_mcp_get` on the endpoint surface (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → The endpoint's limits): no Scope marked a Session's own, each value and its text inside
// their limits whatever the set holds, the entry and the layers left out when they are too large, and the code of what is
// refused. What the Session's surface answers is pinned by `harness-session.test.ts`.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalJsonInEffect:off missedPipeableOpportunity:off preferTypedSchemaDecoder:off schemaSync:off schemaSyncInEffect:off
import type { McpExposure, McpResolvedServer } from "@cloudpid/config";
import {
  ENDPOINT_STRUCTURED_BYTES,
  ENDPOINT_TEXT_CHARS,
  GLOBAL_SETTINGS_SCOPE,
  SettingsMcpGetEndpointOutput,
  SettingsMcpListEndpointOutput,
} from "@cloudpid/protocol/harness-tools";
import type { SettingsMcpServer, SettingsMcpView } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { fakeMcpHost } from "./mcp.testing.ts";
import { SettingsAccessError } from "./settings.ts";
import {
  settingsMcpGetRead,
  settingsMcpListRead,
  type SettingsMcpReadServices,
} from "./settings-mcp-reads.ts";
import { storedBytes } from "./stored-bytes.ts";

/** A server as the Registry resolves it: an HTTP entry in force, `${NAME}` unresolved, with `extra` in its description. */
const resolved = (name: string, extra = ""): McpResolvedServer => {
  const exposure: McpExposure = "codemode";

  return {
    name,
    source: { kind: "environment" },
    server: {
      enabled: true,
      exposure,
      toolExposure: {},
      timeout: 60,
      sampling: "ask",
      type: "http",
      url: `https://${name}.example.test/mcp`,
      headers: { Authorization: "Bearer ${API_TOKEN}" },
      description: extra,
    },
    replacesGlobal: false,
    shadowed: [],
    resolvesSecrets: true,
  };
};

const server = (name: string, extra = ""): SettingsMcpServer => ({
  server: resolved(name, extra),
  origins: { enabled: "default", exposure: "default", toolExposure: "default" },
  reads: [{ name: "API_TOKEN", kind: "secret", where: ["headers.Authorization"] }],
  resetFields: [],
  signIn: null,
  hints: [],
  problems: [],
});

/** The view of Environment `api`, whose servers are `servers`, with `layers` for the one `name` names. */
const viewOf = (
  servers: ReadonlyArray<SettingsMcpServer>,
  name: string | undefined,
  written: { readonly value: Schema.Json } = { value: {} },
): SettingsMcpView => {
  const chosen = Arr.filter(servers, (each) => name === undefined || each.server.name === name);

  return {
    scope: "api",
    name: "Api",
    servers: chosen,
    names: Arr.map(servers, (each) => each.server.name),
    layers:
      name === undefined || chosen.length === 0
        ? null
        : {
            global: { kind: "entry", value: written.value },
            environment: { kind: "entry", value: written.value },
            repos: [],
          },
    repos: [],
    orphans: [],
    problems: [],
    offered: [],
    warnings: [],
  };
};

/** The services over one Environment, `api`: its servers, and a host that holds `tools` for each. */
const servicesOf = (
  servers: ReadonlyArray<SettingsMcpServer>,
  tools: number = 1,
  written?: { readonly value: Schema.Json },
): SettingsMcpReadServices => {
  const host = fakeMcpHost(
    Arr.map(servers, (each) => ({
      name: each.server.name,
      tools: Arr.makeBy(tools, (index) => ({
        name: `tool_${index}`,
        description: "A tool",
        annotations: { readOnlyHint: true },
      })),
      protocolVersion: "2025-06-18",
      instructions: "Search before you publish.",
    })),
  );

  return {
    own: Effect.succeed("api"),
    host: () => host.client,
    view: ({ scope, name }) =>
      scope === "api"
        ? Effect.succeed(viewOf(servers, name, written))
        : Effect.fail(
            SettingsAccessError.make({
              message: `No Environment has the id ${JSON.stringify(scope)}.`,
              code: "not_found",
            }),
          ),
  };
};

const listEndpoint = (services: SettingsMcpReadServices, scope = "api") =>
  settingsMcpListRead(services)({ scope }, "endpoint");

const getEndpoint = (services: SettingsMcpReadServices, name: string, scope = "api") =>
  settingsMcpGetRead(services)({ scope, name }, "endpoint");

describe("settings_mcp_list on the endpoint", () => {
  it("lists the servers with no mark of a Session's own Scope", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* listEndpoint(servicesOf([server("shared"), server("docs")]));
        const value = Schema.decodeUnknownSync(SettingsMcpListEndpointOutput)(answer.structured);

        expect(Arr.map(value.servers, ({ name }) => name)).toEqual(["shared", "docs"]);
        expect(value.inventory).toBe("read");
        expect(JSON.stringify(answer.structured)).not.toContain("is_own");
        expect(answer.text).toContain('MCP servers of Environment "Api" (api): 2');
      }),
    ));

  it("is cut to both limits, flagged, for a set of many servers with long descriptions", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const many = Arr.makeBy(300, (index) => server(`server-${index}`, "d".repeat(2_000)));

        const answer = yield* listEndpoint(servicesOf(many));
        const value = Schema.decodeUnknownSync(SettingsMcpListEndpointOutput)(answer.structured);

        expect(value.servers_truncated).toBe(true);
        expect(value.servers.length).toBeLessThan(300);
        expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
        expect(answer.text.length).toBeLessThanOrEqual(ENDPOINT_TEXT_CHARS);
        expect(answer.text).toContain("Cut");
      }),
    ));

  it("answers not_found, from the service, for a Scope that names no Environment", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(listEndpoint(servicesOf([]), "nope"));

        expect(error.code).toBe("not_found");
      }),
    ));
});

describe("settings_mcp_get on the endpoint", () => {
  it("shows one server in full with no mark of a Session's own Scope", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* getEndpoint(
          servicesOf([server("shared"), server("docs")], 3),
          "docs",
        );

        const value = Schema.decodeUnknownSync(SettingsMcpGetEndpointOutput)(answer.structured);

        expect(value.server.name).toBe("docs");
        expect(value.tool_count).toBe(3);
        expect(value.tools).toHaveLength(3);
        expect(value.entry).toMatchObject({ type: "http", url: "https://docs.example.test/mcp" });
        expect(value.entry_truncated).toBe(false);
        expect(value.layers).toMatchObject({ truncated: false });
        expect(JSON.stringify(answer.structured)).not.toContain("is_own");
        expect(answer.text).toContain('MCP server "docs"');
      }),
    ));

  it("leaves out an entry and layers as written that are too large, flagged, and stays inside both limits", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const big = { blob: "x".repeat(15_000) };

        const answer = yield* getEndpoint(servicesOf([server("docs")], 1, { value: big }), "docs");
        const value = Schema.decodeUnknownSync(SettingsMcpGetEndpointOutput)(answer.structured);

        expect(value.layers.global).toBeNull();
        expect(value.layers.environment).toBeNull();
        expect(value.layers.truncated).toBe(true);
        expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
        expect(answer.text.length).toBeLessThanOrEqual(ENDPOINT_TEXT_CHARS);
        expect(answer.text).toContain("too large to show here");
      }),
    ));

  it("cuts a server's 500 tools to what fits, flagged", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const answer = yield* getEndpoint(servicesOf([server("docs")], 500), "docs");
        const value = Schema.decodeUnknownSync(SettingsMcpGetEndpointOutput)(answer.structured);

        expect(value.tool_count).toBe(500);
        expect(value.tools_truncated).toBe(true);
        expect(value.tools.length).toBeLessThan(500);
        expect(storedBytes(answer.structured)).toBeLessThanOrEqual(ENDPOINT_STRUCTURED_BYTES);
        expect(answer.text.length).toBeLessThanOrEqual(ENDPOINT_TEXT_CHARS);
      }),
    ));

  it("answers not_found for a server the Scope does not have, and for a Scope that names no Environment", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const services = servicesOf([server("docs")]);

        const ghost = yield* Effect.flip(getEndpoint(services, "ghost"));
        const scope = yield* Effect.flip(getEndpoint(services, "docs", "nope"));

        expect(ghost.code).toBe("not_found");
        expect(ghost.message).toContain('No MCP server "ghost"');
        expect(ghost.message).toContain("Its servers: docs.");
        expect(scope.code).toBe("not_found");
        expect(GLOBAL_SETTINGS_SCOPE).toBe("*");
      }),
    ));
});
