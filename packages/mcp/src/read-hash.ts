/**
 * The SHA-256 of what a `resources/read` answered (`docs/architecture/mcp-in-a-session.md` → Resource watches: the
 * baseline a watch's re-read is compared with). It covers each content item's `uri`, `mimeType` and body, in order, and
 * nothing else: a `_meta`, or a key a later server version adds, never makes a resource look changed.
 *
 * Each body is hashed on its own and the digests are hashed together, so no copy of a 16 MiB read is made beyond the
 * one body being hashed: a text's UTF-8 bytes, or a blob's base64 text as the server sent it.
 */
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- WebCrypto's digest is Promise-based.
import type { ReadResourceResult } from "@modelcontextprotocol/client";
import * as Arr from "effect/Array";

const encoder = new TextEncoder();

const digestOf = async (bytes: BufferSource): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

const hexOf = (bytes: Uint8Array): string =>
  Arr.join(
    Arr.map(Arr.fromIterable(bytes), (byte) => byte.toString(16).padStart(2, "0")),
    "",
  );

/** Lowercase hex of the SHA-256 of `contents`. */
export const contentsSha256 = async (contents: ReadResourceResult["contents"]): Promise<string> => {
  const digests: Array<Uint8Array> = [];

  for (const item of contents) {
    const isText = "text" in item;

    digests.push(
      await digestOf(
        encoder.encode(JSON.stringify([item.uri, item.mimeType ?? null, isText ? "text" : "blob"])),
      ),
      await digestOf(encoder.encode(isText ? item.text : item.blob)),
    );
  }

  const joined = new Uint8Array(digests.length * 32);

  for (const [index, digest] of digests.entries()) joined.set(digest, index * 32);

  return hexOf(await digestOf(joined));
};
