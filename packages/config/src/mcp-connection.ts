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
import { isJsonArray, isJsonObject, utf8Encoder } from "./json.ts";
import type { McpResolvedServer, McpSource } from "./mcp-server-set.ts";
import { MCP_OAUTH_KEYS, normalizeMcpName, type McpOauth } from "./mcp-servers.ts";

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

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotateRight = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

/** The SHA-256 of `text` as UTF-8, as 64 hex digits. Synchronous, so it can run inside a Durable Object transaction. */
export const sha256Hex = (text: string): string => {
  const bytes = utf8Encoder.encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);

  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);

  view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);

  const state = Uint32Array.of(
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  );

  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);

    for (let i = 16; i < 64; i += 1) {
      const w15 = words[i - 15] ?? 0;
      const w2 = words[i - 2] ?? 0;
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);

      words[i] = ((words[i - 16] ?? 0) + s0 + (words[i - 7] ?? 0) + s1) >>> 0;
    }

    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state;

    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const first = (h + s1 + choose + (K[i] ?? 0) + (words[i] ?? 0)) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (s0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }

    const next = [a, b, c, d, e, f, g, h];

    for (let i = 0; i < 8; i += 1) state[i] = ((state[i] ?? 0) + (next[i] ?? 0)) >>> 0;
  }

  return Arr.join(
    Arr.map(Array.from(state), (word) => word.toString(16).padStart(8, "0")),
    "",
  );
};

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
