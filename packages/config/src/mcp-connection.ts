// The keys of an MCP server (`docs/architecture/mcp-connections.md` → Storage): `conn`, which `McpHost` keys connections,
// inventories and eras by, and `mcpServerIdentity`, which MCP tasks use to tell a re-pin from a new server. Both are
// SHA-256 of a canonical JSON with `${NAME}` unresolved, so no Secret enters a hash, and both are pure and synchronous
// (the Registry hashes inside a transaction).
//
// `conn` covers what changes the connection: the source, the normalized name, and the type, url, headers, `oauth`,
// command, args, env and cwd. Every other key (`description`, `timeout`, `enabled`, `sampling`, `exposure`,
// `toolExposure`) is left out: editing it bumps the inventory's version but never reconnects or re-probes (D3.1 of the
// Environment's MCP host object).
// @effect-diagnostics missingPipeableSignature:off -- hashes of plain values, not combinators.
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { isJsonArray, isJsonObject } from "./json.ts";
import type { McpResolvedServer, McpSource } from "./mcp-server-set.ts";
import { MCP_OAUTH_KEYS, normalizeMcpName, type McpOauth } from "./mcp-servers.ts";
import { sha256Hex } from "./sha256.ts";

export { sha256Hex } from "./sha256.ts";

/** What keys a server: where it is defined, its name, and its entry in force. */
export type McpKeyed = Pick<McpResolvedServer, "name" | "source" | "server">;

/**
 * Whose server it is, as MCP sign-ins and `conn` say it (`docs/architecture/mcp-sign-in.md` → Key): `owner` for Global's
 * and an Environment's own, `repo:<owner/repo>` for a Repo's.
 */
export const mcpKeySource = (source: McpSource): string =>
  source.kind === "repo" ? `repo:${source.slug}` : "owner";

const byKey = Order.mapInput(Order.String, (entry: readonly [string, Schema.Json]) => entry[0]);

/** `value` with the keys of every object in it in order, so one value has one text. */
export const sortedJson = (value: Schema.Json): Schema.Json => {
  if (isJsonArray(value)) return Arr.map(value, sortedJson);

  if (!isJsonObject(value)) return value;

  return Record.fromEntries(
    Arr.map(Arr.sort(Record.toEntries(value), byKey), ([key, entry]): [string, Schema.Json] => [
      key,
      sortedJson(entry),
    ]),
  );
};

/** The URL as the MCP sign-in keys it: `new URL(url).href` without its fragment. */
const urlKey = (url: string): string => {
  const parsed = new URL(url);

  parsed.hash = "";

  return parsed.href;
};

const oauthKey = (oauth: McpOauth | undefined): Schema.Json =>
  oauth === undefined
    ? null
    : Record.fromEntries(
        Arr.filterMap(MCP_OAUTH_KEYS, (key) => {
          const field = oauth[key];

          return field === undefined ? Result.failVoid : Result.succeed([key, field] as const);
        }),
      );

/** The canonical text `conn` hashes: the ten keys, in this order, each key of a map sorted. */
export const canonicalMcpConnection = ({ name, source, server }: McpKeyed): string =>
  JSON.stringify({
    source: mcpKeySource(source),
    name: normalizeMcpName(name),
    type: server.type,
    url: server.type === "http" ? urlKey(server.url) : null,
    headers: server.type === "http" ? sortedJson(server.headers) : {},
    oauth: server.type === "http" ? oauthKey(server.oauth) : null,
    command: server.type === "stdio" ? server.command : null,
    args: server.type === "stdio" ? server.args : [],
    env: server.type === "stdio" ? sortedJson(server.env) : {},
    cwd: server.type === "stdio" ? (server.cwd ?? null) : null,
  });

/** The canonical text `mcpServerIdentity` hashes: the source, the normalized name, the type and the url. */
export const canonicalMcpIdentity = ({ name, source, server }: McpKeyed): string =>
  JSON.stringify({
    source: mcpKeySource(source),
    name: normalizeMcpName(name),
    type: server.type,
    url: server.type === "http" ? urlKey(server.url) : null,
  });

/**
 * The connection key of an MCP server (`docs/architecture/mcp-connections.md` → Storage): SHA-256 over its source,
 * normalized name, type, url, headers, `oauth`, command, args, env and cwd, `${NAME}` unresolved. A change to any other
 * key leaves it as it is.
 */
export const mcpConnectionKey = (server: McpKeyed): string =>
  sha256Hex(canonicalMcpConnection(server));

/**
 * SHA-256 of an MCP server's source, normalized name, type and url: what MCP tasks use to tell a server re-pinned to
 * another definition from a new one.
 */
export const mcpServerIdentity = (server: McpKeyed): string =>
  sha256Hex(canonicalMcpIdentity(server));

/**
 * Why OAuth does not apply to `server` (`docs/architecture/mcp-sign-in.md` → MCP sign-ins, Which servers), or undefined when it
 * does: only an HTTP entry signs in with OAuth, and one that sends its own `Authorization` header does not. The Registry's
 * sign-in target and the Settings page's rows both read this one rule.
 */
export const mcpSignInNotApplicable = (server: McpKeyed["server"]): string | undefined => {
  if (server.type !== "http") return "Only an HTTP server signs in with OAuth";

  return Arr.some(Record.keys(server.headers), (name) => name.toLowerCase() === "authorization")
    ? "The entry sends its own Authorization header, so OAuth does not apply"
    : undefined;
};

/** An MCP sign-in's key: the three parts, and their SHA-256, which the Registry keys the sign-in's row by. */
export type McpSignInKey = {
  /** `owner`, or `repo:<owner/repo>` (`mcpKeySource`). */
  readonly source: string;
  /** The normalized name, as the `mcp__<server>` part spells it. */
  readonly name: string;
  /** `new URL(url).href` without its fragment. */
  readonly url: string;
  /** SHA-256 over the three, as 64 hex digits. */
  readonly hash: string;
};

/**
 * The key of the MCP sign-in an HTTP server uses (`docs/architecture/mcp-sign-in.md` → MCP sign-ins): its source, its
 * normalized name and its URL without the fragment. Sign-ins are kept Global, so the key names no Environment; `oauth`
 * and the headers are not in it, so editing them keeps the sign-in. Undefined for a stdio server, which has none.
 */
export const mcpSignInKey = ({ name, source, server }: McpKeyed): McpSignInKey | undefined => {
  if (server.type !== "http") return undefined;

  const key = {
    source: mcpKeySource(source),
    name: normalizeMcpName(name),
    url: urlKey(server.url),
  };

  return { ...key, hash: sha256Hex(JSON.stringify(key)) };
};
