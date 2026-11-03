// The model-facing names of MCP tools (`docs/architecture/mcp-in-a-session.md` → Tool names, ADR-0030): `mcp__<server>__<tool>`
// with both parts snake_case, a hash on every member of a collision and on a name over the providers' 64 characters. Pure
// and synchronous, so prompts, the Session's `mcp` extension, `settings_mcp_*` and the importer of pi transcripts all
// spell a tool alike. `@cloudpid/effect-durable`'s tool-name check accepts exactly this shape.
// @effect-diagnostics missingPipeableSignature:off -- naming of plain values, not combinators.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import { sha256Hex } from "./mcp-connection.ts";
import { normalizeMcpName } from "./mcp-servers.ts";

/** The providers' limit on a tool name: Anthropic `^[a-zA-Z0-9_-]{1,64}$`, OpenAI at most 64. */
export const MAX_MCP_TOOL_NAME_LENGTH = 64;

/** What every MCP tool's model-facing name starts with. */
export const MCP_TOOL_NAME_PREFIX = "mcp__";

/** Whether `name` is an MCP tool's model-facing name (`mcp__<server>__<tool>`). */
export const isMcpToolName = (name: string): boolean => name.startsWith(MCP_TOOL_NAME_PREFIX);

/**
 * The three resource tools the `mcp` extension registers when a server has resources (`docs/architecture/
 * mcp-in-a-session.md` → Resource tools): snake_case like every tool, and not `mcp__`-prefixed since they are not any
 * one server's.
 */
export const MCP_RESOURCE_TOOL_NAMES = [
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
] as const;

const RESOURCE_TOOL_NAME_SET: ReadonlySet<string> = new Set(MCP_RESOURCE_TOOL_NAMES);

/** Whether `name` is one of the resource tools. */
export const isMcpResourceToolName = (name: string): boolean => RESOURCE_TOOL_NAME_SET.has(name);

/**
 * Whether the `mcp` extension owns the tool `name`: an MCP tool or a resource tool. Its Exposure, not the settings'
 * deferral, decides how it is offered, and a call of it never resolves a Secret Reference.
 */
export const isMcpExtensionToolName = (name: string): boolean =>
  isMcpToolName(name) || isMcpResourceToolName(name);

/**
 * `mcp__<server>`, server `server`'s part of its tools' names: its `codemode` namespace, and with `__` the start of each
 * of its tools' names (`mcpToolPrefix`).
 */
export const mcpServerNamespace = (server: string): string =>
  `${MCP_TOOL_NAME_PREFIX}${normalizeMcpName(server)}`;

/** `mcp__<server>__`, what every name of server `server`'s tools starts with. */
export const mcpToolPrefix = (server: string): string => `${mcpServerNamespace(server)}__`;

/** The hex digits of the hash a collision or a long name adds. */
const HASH_LENGTH = 8;

/** A name over the limit is cut to this, so that `_` and the hash fill it exactly. */
const CUT_LENGTH = MAX_MCP_TOOL_NAME_LENGTH - HASH_LENGTH - 1;

/** What stands for a tool part that has no letter or digit (a tool called `-`). */
const EMPTY_TOOL_PART = "tool";

/** The server part when the name has no room for a tool part at all (a server name of 48 characters or more). */
const CUT_SERVER_LENGTH = 44;

/**
 * The tool part of a name: `_` inserted before each run of upper-case letters, lower-cased, everything but `a-z` and
 * `0-9` as `_`, runs of `_` collapsed and the ends trimmed (`getUser` → `get_user`). Never empty.
 */
export const mcpToolPart = (tool: string): string =>
  tool
    .replaceAll(/[A-Z]+/g, "_$&")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "") || EMPTY_TOOL_PART;

/**
 * The 8 hex digits of `sha256("server\0tool")` that tell tools apart. The server is the normalized name, so a change of
 * its case or `-` does not rename its tools; the tool is the server's own.
 */
export const mcpToolHash = (server: string, tool: string): string =>
  sha256Hex(`${normalizeMcpName(server)}\0${tool}`).slice(0, HASH_LENGTH);

/**
 * A tool's model-facing name. `collides` adds the hash that every member of a collision gets (`mcpToolNames` finds
 * them). A name over 64 characters is cut to 55, then `_` and the hash; one whose server part leaves no room for a tool
 * part keeps the shape instead, as `mcp__<server cut to 44>__<hash>`.
 */
export const mcpToolName = (
  server: string,
  tool: string,
  options: { readonly collides?: boolean } = {},
): string => {
  const serverPart = normalizeMcpName(server);
  const prefix = mcpToolPrefix(server);
  const plain = `${prefix}${mcpToolPart(tool)}`;
  const collides = options.collides ?? false;

  if (!collides && plain.length <= MAX_MCP_TOOL_NAME_LENGTH) return plain;

  const hash = mcpToolHash(server, tool);

  if (plain.length + 1 + HASH_LENGTH <= MAX_MCP_TOOL_NAME_LENGTH) return `${plain}_${hash}`;

  if (prefix.length >= CUT_LENGTH) {
    return `${MCP_TOOL_NAME_PREFIX}${serverPart.slice(0, CUT_SERVER_LENGTH)}__${hash}`;
  }

  // The cut leaves a tool part that starts with a letter or digit, so trimming `_` never reaches the server part.
  return `${plain.slice(0, CUT_LENGTH).replaceAll(/_+$/g, "")}_${hash}`;
};

/**
 * The model-facing name of each of one server's tools, by the server's own name for it. Every member of a collision
 * (tools of one name once spelled as snake_case, or a hashed name equal to a plain one) is hashed, so a name never
 * depends on the order the server lists its tools in.
 */
export const mcpToolNames = (
  server: string,
  tools: ReadonlyArray<string>,
): ReadonlyMap<string, string> => {
  const unique = Arr.dedupe(tools);
  const hashed = new Set<string>();

  for (;;) {
    const named = Arr.map(unique, (tool): readonly [string, string] => [
      tool,
      mcpToolName(server, tool, { collides: hashed.has(tool) }),
    ]);

    const counts = new Map<string, number>();

    for (const [, name] of named) counts.set(name, (counts.get(name) ?? 0) + 1);

    const added = Arr.filter(
      named,
      ([tool, name]) => !hashed.has(tool) && (counts.get(name) ?? 0) > 1,
    );

    // A hash that still collides (the same 32 bits under the same cut) is left: nothing more tells those two apart.
    if (added.length === 0) return new Map(named);

    for (const [tool] of added) hashed.add(tool);
  }
};

/** What pi names an MCP tool: `mcp__<server>__<tool>` with everything outside `[A-Za-z0-9_]` as `_`. */
const PI_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

const piPart = (text: string): string => text.replaceAll(/[^A-Za-z0-9_]/g, "_");

/** The longest of `servers` whose pi prefix `name` starts with, with that prefix. */
const longestMatch = (
  name: string,
  servers: ReadonlyArray<string>,
): { readonly server: string; readonly prefix: string } | undefined =>
  Option.getOrUndefined(
    Arr.head(
      Arr.sort(
        Arr.filterMap(servers, (server) => {
          const prefix = `mcp__${piPart(server)}__`;

          return name.startsWith(prefix) ? Result.succeed({ server, prefix }) : Result.failVoid;
        }),
        Order.flip(Order.mapInput(Order.Number, ({ server }: { server: string }) => server.length)),
      ),
    ),
  );

/**
 * A pi transcript's MCP tool name in cloudpid's spelling (`mcp__github__getUser` → `mcp__github__get_user`), through
 * the same functions as a live name; a name that is not an MCP tool's is returned as it is. `servers` are the configured
 * names to read the server part by, for one that holds `__` (the longest match wins); otherwise the server ends at
 * the first `__`. Pi's hash suffix and cut cannot be undone, and a long name is hashed from pi's spelling, not the
 * server's own, so such names stay as pi wrote them or as a new tool's.
 */
export const mcpToolNameFromPi = (name: string, servers: ReadonlyArray<string> = []): string => {
  const known = longestMatch(name, servers);

  if (known !== undefined) {
    const tool = name.slice(known.prefix.length);

    return tool === "" ? name : mcpToolName(known.server, tool);
  }

  const match = PI_TOOL_NAME.exec(name);

  return match === null ? name : mcpToolName(match[1] ?? "", match[2] ?? "");
};
