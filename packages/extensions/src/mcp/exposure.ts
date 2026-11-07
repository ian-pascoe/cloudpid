// How an MCP tool is registered (`docs/architecture/mcp-in-a-session.md` → Exposure): a server's Exposure keys as its
// entry in force carries them, the pi-durable flags of each Exposure, who a tool's `_meta` says sees it, and whether a
// server not discovered yet may have a `direct` tool (the first request waits only for those).
// @effect-diagnostics missingPipeableSignature:off -- readers of plain values, not combinators.
import { type McpExposure, matchesToolPattern, mcpToolPrefix } from "@cloudpid/config";
import { type JsonObject, visibilityOfMeta } from "@cloudpid/mcp/types";
import { HARNESS_TOOL_NAMES } from "@cloudpid/protocol/harness-tools";
import { MCP_ROUTE } from "@cloudpid/protocol/mcp-api";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import type { McpBuildServer } from "./tools.ts";

/** An Exposure as an entry spells it; `codemode-deferred` and anything this build does not know read as `codemode`. */
const ExposureWire = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Literals(["codemode", "deferred", "direct", "hidden"]),
    SchemaTransformation.transform({
      decode: (value): McpExposure =>
        value === "direct" || value === "deferred" || value === "hidden" ? value : "codemode",
      encode: (exposure) => exposure,
    }),
  ),
);

/** The Exposure keys of a server's entry in force; absent keys are the defaults. */
const ExposureKeys = Schema.Struct({
  exposure: ExposureWire.pipe(Schema.withDecodingDefaultKey(Effect.succeed("codemode"))),
  toolExposure: Schema.Record(Schema.String, ExposureWire).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});

const decodeExposureKeys = Schema.decodeUnknownOption(ExposureKeys);

/** A server's Exposure keys as its entry in force carries them; an entry this build cannot read has the defaults. */
export const exposureKeys = (server: Pick<McpBuildServer, "server">) =>
  Option.getOrElse(decodeExposureKeys(server.server), () => ({
    exposure: "codemode" as const,
    toolExposure: {},
  }));

/**
 * Whether `pattern`, an entry of `tools.offered`, can match a name that starts with `prefix`: the pattern's literal head
 * (all of it, without a `*`) either starts with the prefix or, before a `*`, is a start of it.
 */
const mayMatchPrefix = (pattern: string, prefix: string): boolean => {
  const star = pattern.indexOf("*");
  const head = star === -1 ? pattern : pattern.slice(0, star);

  return (
    matchesToolPattern(`${prefix}*`, head) ||
    (star !== -1 && matchesToolPattern(`${head}*`, prefix))
  );
};

/** Whether the Session's tools reach `server`: it is not switched off, and its own Exposure is not `hidden`. */
export const isReachable = (server: Pick<McpBuildServer, "state" | "server">): boolean =>
  server.state !== "disabled" && exposureKeys(server).exposure !== "hidden";

/**
 * Whether any tool of `server` may be `direct`: its own Exposure, a `toolExposure` key, or an offered pattern that can
 * name one of its tools. A server none of whose tools can be is never waited for.
 */
export const mayBeDirect = (
  server: Pick<McpBuildServer, "name" | "server">,
  offered: ReadonlyArray<string>,
): boolean => {
  const { exposure, toolExposure } = exposureKeys(server);

  if (exposure === "hidden") return false;

  const prefix = mcpToolPrefix(server.name);

  return (
    exposure === "direct" ||
    Arr.some(Record.values(toolExposure), (each) => each === "direct") ||
    Arr.some(offered, (pattern) => mayMatchPrefix(pattern, prefix))
  );
};

/** The flags of a registration for `exposure`; `hidden` is never registered. */
export const flagsOf = (exposure: Exclude<McpExposure, "hidden">) => {
  switch (exposure) {
    case "direct":
      return {};
    case "deferred":
      return { deferred: true as const };
    case "codemode":
      return { callers: ["tools"] as const, deferred: true as const };
  }
};

/** Whether a tool's `_meta.ui.visibility` (MCP Apps) lets the model see it: absent, or unreadable, means it does. */
export const reachesModel = (meta: Schema.Json | undefined): boolean =>
  visibilityOfMeta(meta).includes("model");

/**
 * Whether `url` is this stage's own MCP endpoint (`docs/architecture/mcp-endpoint.md` → Self-use): the same origin as
 * `appOrigin` and a path of exactly `MCP_ROUTE` (the query is ignored). `/mcp/`, `/MCP`, another origin, a URL that does
 * not parse, and no `appOrigin` (`alchemy dev`) are not.
 */
export const isOwnEndpoint = (url: string, appOrigin: string | undefined): boolean => {
  if (appOrigin === undefined || appOrigin === "") return false;

  const parsed = URL.parse(url);

  return parsed !== null && parsed.origin === appOrigin && parsed.pathname === MCP_ROUTE;
};

/** Whether an entry as the host stores it is an HTTP server at this stage's own endpoint (`isOwnEndpoint`). */
export const isOwnEntry = (entry: JsonObject, appOrigin: string | undefined): boolean =>
  entry["type"] === "http" &&
  Predicate.isString(entry["url"]) &&
  isOwnEndpoint(entry["url"], appOrigin);

/**
 * Whether the Self-use rule hides tool `name` of the Session's own endpoint: every tool declared in
 * `@cloudpid/protocol/harness-tools` has an in-session twin. The rest of the endpoint's tools (`MCP_TOOL_NAMES`) stay.
 */
export const selfUseHides = (name: string): boolean =>
  Arr.some(HARNESS_TOOL_NAMES, (harness) => harness === name);
