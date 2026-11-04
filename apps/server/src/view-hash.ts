// docs/architecture/mcp-apps.md → The App sandbox (Origins). The hash that names an App View's origin. Kept apart from
// `view-host.ts`, which the App sandbox Worker bundles and which imports nothing but `deployment.ts`: this one needs the
// SHA-256 of `@cloudpid/config`, which only the main Worker (the host that knows an Environment's servers) uses.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
import { sha256Hex } from "@cloudpid/config";
import type { McpSetSource } from "@cloudpid/mcp/types";
import * as Predicate from "effect/Predicate";

/** Lowercase RFC 4648 base32 alphabet, unpadded (`a`–`z`, `2`–`7`). */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** How many characters of the digest's base32 name a View: 26 × 5 = 130 bits, of which the SHA-256 gives the first 128. */
const HASH_LENGTH = 26;

/** The bytes of a hex string. */
const bytesOf = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );

/** `bytes` as unpadded lowercase base32. */
const base32 = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }

    value &= (1 << bits) - 1;
  }

  return bits > 0 ? out + ALPHABET[(value << (5 - bits)) & 31] : out;
};

/**
 * Whose server it is, as an App View's origin says it: `owner` for Global's and an Environment's own, `repo:<owner/repo>`
 * for a Repo's, so a Repo's server never shares an origin with the owner's. A source this build does not know has none.
 */
export const viewSourceOf = (source: McpSetSource): string | undefined => {
  if (source.kind === "global" || source.kind === "environment") return "owner";

  return source.kind === "repo" && "slug" in source && Predicate.isString(source.slug)
    ? `repo:${source.slug}`
    : undefined;
};

/**
 * The 26 characters that name an App View's origin: the first 26 of the base32 of SHA-256 over
 * `"v1\0" + environmentId + "\0" + source + "\0" + normalizedName`. Views of different servers, Environments or sources
 * never share an origin; editing a server's URL, headers or other config keeps it. `normalizedName` is the server's name
 * as tool names spell it (`normalizeMcpName`).
 */
export const viewHash = (input: {
  readonly environment: string;
  readonly source: string;
  readonly normalizedName: string;
}): string =>
  base32(
    bytesOf(sha256Hex(`v1\0${input.environment}\0${input.source}\0${input.normalizedName}`)),
  ).slice(0, HASH_LENGTH);
