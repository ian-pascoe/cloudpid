// @effect-diagnostics missingPipeableSignature:off -- readers of plain values, not combinators.
// Which servers the resource tools reach, and which one a model's `server` names (`docs/architecture/mcp-in-a-session.md` →
// Resource tools): shared by the lists (`./resource-list.ts`) and the read (`./resource-read.ts`).
import { normalizeMcpName } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { oneLine } from "./blocks.ts";
import { isReachable } from "./exposure.ts";
import type { McpBuildServer } from "./tools.ts";

/** Whether the resource tools reach `server`: it is enabled, not `hidden`, and offers resources. */
export const hasResources = (server: McpBuildServer): boolean =>
  server.resources === true && isReachable(server);

/** The server of `servers` a model's `wanted` names: its normalized name, its configured one, or `mcp__<name>`. */
export const serverNamed = (
  servers: ReadonlyArray<McpBuildServer>,
  wanted: string,
): McpBuildServer | undefined => {
  const trimmed = wanted.trim();

  const key = normalizeMcpName(
    trimmed.startsWith("mcp__") ? trimmed.slice("mcp__".length) : trimmed,
  );

  return Option.getOrUndefined(
    Arr.findFirst(servers, (server) => normalizeMcpName(server.name) === key),
  );
};

/** Why `wanted` is no server the resource tools reach, saying which are. */
export const unknownServer = (servers: ReadonlyArray<McpBuildServer>, wanted: string): string => {
  const names = Arr.map(servers, (server) => normalizeMcpName(server.name));

  return `No MCP server named ${JSON.stringify(oneLine(wanted, 100))} has resources. Servers with resources: ${Arr.join(names, ", ")}.`;
};
