/**
 * The extensions an engine call declares (`docs/architecture/mcp.md` → Extensions): OAuth Client Credentials only on
 * the connection the host named it for, in both eras (`_meta` clientCapabilities on a Modern request, `initialize`
 * capabilities on a Legacy one), and no extension the engine does not know.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off strictEffectProvide:off schemaSync:off
import {
  type FakeServer,
  fetchTo,
  legacyStatelessServer,
  modernServer,
} from "@cloudpid/mcp/testing";
import { MCP_CLIENT_CREDENTIALS_EXTENSION, type McpEngineTargetEncoded } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ByteBudget } from "./budget.ts";
import { discover, request } from "./calls.ts";
import { Validators } from "./validators.ts";

const MCP_APPS = "io.modelcontextprotocol/ui";

afterEach(() => {
  vi.unstubAllGlobals();
});

const target = (extensions?: McpEngineTargetEncoded["extensions"]): McpEngineTargetEncoded => {
  const base = {
    kind: "http",
    conn: "conn-1",
    name: "docs",
    url: "https://mcp.example.test/mcp",
    headers: {},
  } satisfies McpEngineTargetEncoded;

  return extensions === undefined ? base : { ...base, extensions };
};

const run = <A, E>(effect: Effect.Effect<A, E, ByteBudget | Validators>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(ByteBudget.layer, Validators.layer))),
  );

const ENV = { version: "test", hold: () => undefined };

const Declaration = Schema.Struct({
  extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

/** What a request carries: its capabilities (`initialize`) or its `_meta` (Modern). */
const Params = Schema.Struct({
  capabilities: Schema.optionalKey(Declaration),
  _meta: Schema.optionalKey(
    Schema.Struct({
      "io.modelcontextprotocol/clientCapabilities": Schema.optionalKey(Declaration),
    }),
  ),
});

const readParams = Schema.decodeUnknownOption(Params);

/** The extensions each request of `server` declared, by method. */
const declared = (server: FakeServer, method: string) =>
  Arr.filterMap(server.received, (received) => {
    if (received.rpc?.method !== method) return Result.failVoid;

    const params = readParams(received.rpc.params ?? {});

    if (Option.isNone(params)) return Result.failVoid;

    const found =
      method === "initialize"
        ? params.value.capabilities
        : params.value._meta?.["io.modelcontextprotocol/clientCapabilities"];

    return Result.succeed(found?.extensions);
  });

const discovering = async (
  server: FakeServer,
  extensions?: McpEngineTargetEncoded["extensions"],
) => {
  vi.stubGlobal("fetch", fetchTo(server));

  return run(discover(target(extensions), {}, {}, ENV));
};

describe("OAuth Client Credentials on a connection", () => {
  const NAMED = { [MCP_CLIENT_CREDENTIALS_EXTENSION]: {} };

  it("is declared next to MCP Apps on a Modern server's requests when the host names it", async () => {
    const server = modernServer();

    await discovering(server, NAMED);

    const sent = declared(server, "server/discover");

    expect(sent).toHaveLength(1);
    expect(Record.keys(sent[0] ?? {}).sort()).toEqual([MCP_CLIENT_CREDENTIALS_EXTENSION, MCP_APPS]);
    expect(sent[0]?.[MCP_CLIENT_CREDENTIALS_EXTENSION]).toEqual({});

    for (const extensions of declared(server, "tools/list")) {
      expect(extensions).toHaveProperty([MCP_CLIENT_CREDENTIALS_EXTENSION]);
    }
  });

  it("is declared at a Legacy server's initialize when the host names it", async () => {
    const server = legacyStatelessServer();

    await discovering(server, NAMED);

    const sent = declared(server, "initialize");

    expect(sent).toHaveLength(1);
    expect(Record.keys(sent[0] ?? {}).sort()).toEqual([MCP_CLIENT_CREDENTIALS_EXTENSION, MCP_APPS]);
  });

  it.each([
    ["Modern", () => modernServer(), "server/discover"],
    ["Legacy", () => legacyStatelessServer(), "initialize"],
  ])(
    "is not declared on a %s connection the host named no extension for",
    async (_era, make, method) => {
      const server = make();

      await discovering(server);

      const sent = declared(server, method);

      expect(sent).toHaveLength(1);
      expect(Record.keys(sent[0] ?? {})).toEqual([MCP_APPS]);
    },
  );

  it("is declared on a request's connection too, and an extension the engine does not know never is", async () => {
    const server = modernServer();

    vi.stubGlobal("fetch", fetchTo(server));

    await run(
      request(
        target({ ...NAMED, "example.test/third-party": { anything: true } }),
        {},
        { op: "tools/list", ctx: { origin: "host" } },
        {},
        ENV,
      ),
    );

    const listed = declared(server, "tools/list");

    expect(listed.length).toBeGreaterThan(0);

    for (const extensions of listed) {
      expect(Record.keys(extensions ?? {}).sort()).toEqual([
        MCP_CLIENT_CREDENTIALS_EXTENSION,
        MCP_APPS,
      ]);
    }
  });
});
