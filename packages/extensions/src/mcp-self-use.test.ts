// The Self-use rule (`docs/architecture/mcp-endpoint.md` → Self-use): an HTTP MCP server at this stage's own `/mcp` registers
// none of the tools declared in `@cloudpid/protocol/harness-tools` (`HARNESS_TOOL_NAMES`), whose twins the Session has, and
// every tool of `MCP_TOOL_NAMES` stays. From another origin, or with no `appOrigin` (`alchemy dev`), it registers all.
// @effect-diagnostics preferEffectArray:off
import { HARNESS_TOOL_NAMES } from "@cloudpid/protocol/harness-tools";
import { MCP_TOOL_NAMES } from "@cloudpid/protocol/mcp-api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { build, startOf } from "./mcp.fixture.ts";
import { makeMcpTools } from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { isOwnEndpoint, isOwnServer, selfUseHides } from "./mcp/exposure.ts";
import { mcpListing } from "./mcp/servers.ts";
import type { McpBuildServer } from "./mcp/tools.ts";

const ORIGIN = "https://cloudpid.test";

/** The endpoint as a server of the Session: the fake host names its URL `https://<name>.test/mcp`. */
const ENDPOINT: FakeMcpServer = {
  name: "cloudpid",
  exposure: "direct",
  tools: [...HARNESS_TOOL_NAMES, ...MCP_TOOL_NAMES].map((name) => ({ name })),
};

/** The names the model is given for `ENDPOINT`'s tools. */
const registeredFor = (appOrigin: string | undefined) =>
  Effect.gen(function* () {
    const host = fakeMcpHost([ENDPOINT]);

    const built = yield* Effect.promise(() =>
      build(makeMcpTools(host.client, undefined, { appOrigin }), startOf(1)),
    );

    return Arr.map(Option.getOrThrow(built).tools ?? [], (tool) => tool.name);
  });

const modelNames = (names: ReadonlyArray<string>) =>
  Arr.map(names, (name) => `mcp__cloudpid__${name}`);

describe("isOwnEndpoint", () => {
  it("is true for the same origin and a path of exactly /mcp, ignoring the query", () => {
    expect(isOwnEndpoint(`${ORIGIN}/mcp`, ORIGIN)).toBe(true);
    expect(isOwnEndpoint(`${ORIGIN}/mcp?x=1`, ORIGIN)).toBe(true);
    expect(isOwnEndpoint(`${ORIGIN}:443/mcp`, ORIGIN)).toBe(true);
  });

  it("reads appOrigin as a URL, so an uppercase host or a trailing slash still names the endpoint", () => {
    expect(isOwnEndpoint(`${ORIGIN}/mcp`, "https://CloudPid.test")).toBe(true);
    expect(isOwnEndpoint(`${ORIGIN}/mcp`, `${ORIGIN}/`)).toBe(true);
    expect(isOwnEndpoint(`${ORIGIN}/mcp`, "not a url")).toBe(false);
    expect(isOwnEndpoint("foo:/mcp", "bar:/x")).toBe(false);
  });

  it("is false for /mcp/, /MCP, a sub-path, another origin, a port, an unparsable URL and no appOrigin", () => {
    expect(isOwnEndpoint(`${ORIGIN}/mcp/`, ORIGIN)).toBe(false);
    expect(isOwnEndpoint(`${ORIGIN}/MCP`, ORIGIN)).toBe(false);
    expect(isOwnEndpoint(`${ORIGIN}/mcp/sub`, ORIGIN)).toBe(false);
    expect(isOwnEndpoint(`${ORIGIN}/`, ORIGIN)).toBe(false);
    expect(isOwnEndpoint("https://other.test/mcp", ORIGIN)).toBe(false);
    expect(isOwnEndpoint("http://cloudpid.test/mcp", ORIGIN)).toBe(false);
    expect(isOwnEndpoint(`${ORIGIN}:8443/mcp`, ORIGIN)).toBe(false);
    expect(isOwnEndpoint("not a url", ORIGIN)).toBe(false);
    expect(isOwnEndpoint("", ORIGIN)).toBe(false);
    expect(isOwnEndpoint(`${ORIGIN}/mcp`)).toBe(false);
    expect(isOwnEndpoint(`${ORIGIN}/mcp`, "")).toBe(false);
  });

  it("reads an entry as the host stores it: an HTTP server with a URL", () => {
    expect(isOwnServer({ type: "http", url: `${ORIGIN}/mcp` }, ORIGIN)).toBe(true);
    expect(isOwnServer({ type: "stdio", url: `${ORIGIN}/mcp` }, ORIGIN)).toBe(false);
    expect(isOwnServer({ type: "http" }, ORIGIN)).toBe(false);
    expect(isOwnServer({ type: "http", url: 3 }, ORIGIN)).toBe(false);
  });
});

describe("the Self-use rule", () => {
  it("hides exactly the HARNESS_TOOL_NAMES, and none of the MCP_TOOL_NAMES", () => {
    for (const name of HARNESS_TOOL_NAMES) expect(selfUseHides(name)).toBe(true);

    for (const name of MCP_TOOL_NAMES) expect(selfUseHides(name)).toBe(false);

    expect(selfUseHides("anything_else")).toBe(false);
  });

  it("keeps the two lists apart", () => {
    expect(Arr.intersection(HARNESS_TOOL_NAMES, MCP_TOOL_NAMES)).toEqual([]);
  });

  it("registers exactly the MCP_TOOL_NAMES tools from the own endpoint", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registered = yield* registeredFor(ORIGIN);

        expect(registered).toEqual(modelNames(MCP_TOOL_NAMES));
      }),
    ));

  it("registers every tool of both lists from another origin", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registered = yield* registeredFor("https://other.test");

        expect(registered).toEqual(modelNames([...HARNESS_TOOL_NAMES, ...MCP_TOOL_NAMES]));
      }),
    ));

  it("registers every tool of both lists with no appOrigin (alchemy dev)", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const registered = yield* registeredFor(undefined);

        expect(registered).toEqual(modelNames([...HARNESS_TOOL_NAMES, ...MCP_TOOL_NAMES]));
      }),
    ));

  it("leaves the own endpoint no mcp_servers line when it offers only tools Self-use hides", () => {
    const only = (ownEndpoint: boolean): McpBuildServer => ({
      name: "cloudpid",
      state: "connected",
      discoveredAt: 1,
      server: { exposure: "codemode" },
      tools: HARNESS_TOOL_NAMES.map((name) => ({ name, inputSchema: { type: "object" } })),
      ownEndpoint,
    });

    expect(mcpListing([only(true)], []).text).toBe("");
    expect(mcpListing([only(false)], []).text).toBe("- mcp__cloudpid (codemode)");
  });
});
