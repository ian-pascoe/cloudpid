/**
 * Who is calling, as far as `McpServer` can tell (`docs/architecture/mcp-endpoint.md` → Access and identity, "The client's
 * name"): the client's name (display only, untrusted) and the era it speaks. How the caller got in is never here: the
 * main Worker closes it over the `api` target.
 */
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over headers and parsed JSON.
import { type McpClient, type McpEra, SESSION_ID } from "@cloudpid/protocol/mcp-api";
import type { Wire } from "./tools.ts";
import { CLIENT_INFO_META_KEY } from "@modelcontextprotocol/server";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What `McpApi` is told of the caller: its `Via`. */
export interface Caller {
  readonly client?: McpClient;
  readonly era: McpEra;
}

/** The longest a client's name or version is kept. */
const MAX_CLIENT_CHARS = 40;

/** The header pi's `mcp.json` `headers` (and `/cloudpid`) set: `name/version`. */
export const CLIENT_HEADER = "x-cloudpid-client";

/** `User-Agent` product tokens that name a library or a runtime, not the client that uses it. */
const GENERIC_PRODUCTS = new Set([
  "node",
  "nodejs",
  "undici",
  "bun",
  "deno",
  "curl",
  "wget",
  "axios",
  "node-fetch",
  "got",
  "python-requests",
  "python-httpx",
  "python",
  "aiohttp",
  "okhttp",
  "go-http-client",
  "java",
  "mozilla",
  "applewebkit",
  "chrome",
  "safari",
  "firefox",
  "edg",
  "cloudflare-workers",
]);

/** Printable, short and free of anything a display would have to escape. */
const tidy = (text: string): string =>
  text
    // oxlint-disable-next-line no-control-regex -- the point is to remove control characters.
    .replace(/[\u0000-\u001f\u007f<>"'`\\]/g, "")
    .trim()
    .slice(0, MAX_CLIENT_CHARS);

const client = (name: string, version?: string): McpClient | undefined => {
  const cleanName = tidy(name);
  const cleanVersion = version === undefined ? "" : tidy(version);

  if (cleanName === "") return undefined;

  return cleanVersion === "" ? { name: cleanName } : { name: cleanName, version: cleanVersion };
};

/** `name/version`, or `name` alone. */
const fromProduct = (product: string): McpClient | undefined => {
  const slash = product.indexOf("/");

  return slash < 0 ? client(product) : client(product.slice(0, slash), product.slice(slash + 1));
};

/** The first `User-Agent` product that is not a library or runtime; parenthesised comments are skipped. */
const fromUserAgent = (agent: string): McpClient | undefined => {
  const products = agent.replace(/\([^)]*\)/g, " ").split(/\s+/);

  for (const product of products) {
    const name = product.split("/")[0]?.toLowerCase() ?? "";

    if (name !== "" && !GENERIC_PRODUCTS.has(name)) return fromProduct(product);
  }

  return undefined;
};

/** What a client says of itself: a name, and a version where it has one. Anything else in it is ignored. */
const ClientInfo = Schema.Struct({
  name: Schema.String,
  version: Schema.optionalKey(Schema.String),
});

const decodeClientInfo = Schema.decodeUnknownOption(ClientInfo);

/**
 * The parts of a JSON-RPC request body this endpoint reads: its method, and where a client may have put its info
 * (Modern's `_meta`, or Legacy `initialize`'s `clientInfo`). Each is read leniently, so a malformed one costs only itself.
 */
const RequestBody = Schema.Struct({
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(
    Schema.Struct({
      _meta: Schema.optionalKey(
        Schema.Struct({ [CLIENT_INFO_META_KEY]: Schema.optionalKey(Schema.Unknown) }),
      ),
      clientInfo: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});

export type RequestBody = typeof RequestBody.Type;

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(RequestBody));

/** The request's JSON body as far as {@link RequestBody} reads it; undefined when it is not one request (a batch, say). */
export const readBody = (text: string): RequestBody | undefined =>
  Option.getOrUndefined(decodeBody(text));

const fromBody = (body: RequestBody | undefined): McpClient | undefined => {
  const params = body?.params;

  const info = Option.getOrUndefined(
    decodeClientInfo(params?._meta?.[CLIENT_INFO_META_KEY] ?? params?.clientInfo),
  );

  return info === undefined ? undefined : client(info.name, info.version);
};

/**
 * The client's name: the first present of the `X-Cloudpid-Client` header, the request body's client info (Modern's
 * `_meta`, or `initialize`'s), and the first `User-Agent` product that is no library; else none ("via MCP").
 */
export const clientOf = (
  headers: Headers,
  body: RequestBody | undefined,
): McpClient | undefined => {
  const header = headers.get(CLIENT_HEADER);

  const named = header === null ? undefined : fromProduct(header);

  if (named !== undefined) return named;

  const meta = fromBody(body);

  if (meta !== undefined) return meta;

  const agent = headers.get("user-agent");

  return agent === null ? undefined : fromUserAgent(agent);
};

const SessionArgument = Schema.Struct({
  session_id: Schema.optionalKey(Schema.String.check(Schema.isPattern(SESSION_ID))),
  // An import's id is its Session's.
  import_id: Schema.optionalKey(Schema.String.check(Schema.isPattern(SESSION_ID))),
});

const decodeSessionArgument = Schema.decodeUnknownOption(SessionArgument);

/** The Session a `tools/call` names (`session_id`, or an import's `import_id`), for its span, when it is a full UUID. */
export const sessionOf = (args: Wire): string | undefined =>
  Option.getOrUndefined(
    Option.map(decodeSessionArgument(args), (found) => found.session_id ?? found.import_id),
  );
