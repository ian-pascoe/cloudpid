// How an MCP tool is registered (`docs/architecture/mcp-in-a-session.md` → Exposure): a server's Exposure keys as its
// entry in force carries them, the pi-durable flags of each Exposure, who a tool's `_meta` says sees it, and whether a
// server not discovered yet may have a `direct` tool (the first request waits only for those).
// @effect-diagnostics missingPipeableSignature:off -- readers of plain values, not combinators.
import { type McpExposure, matchesToolPattern, mcpToolPrefix } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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

/** The part of a tool's `_meta` that says who sees it (MCP Apps). */
const Visibility = Schema.Struct({
  ui: Schema.Struct({ visibility: Schema.Array(Schema.String) }),
});

const decodeVisibility = Schema.decodeUnknownOption(Visibility);

/** Whether a tool's `_meta.ui.visibility` (MCP Apps) lets the model see it: absent, or unreadable, means it does. */
export const reachesModel = (meta: Schema.Json | undefined): boolean =>
  Option.match(decodeVisibility(meta), {
    onNone: () => true,
    onSome: ({ ui }) => ui.visibility.includes("model"),
  });
