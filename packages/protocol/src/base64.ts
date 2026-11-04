// Base64, as a resource's bytes cross the Session socket and the MCP tools (`docs/architecture/mcp-in-a-session.md` →
// Resource links and embedded resources): one place for the web app, the extensions and the Session to count, check, decode and
// write it, so a 16 MiB blob is never held more times than it has to be.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over strings and bytes.

/** Base64 as the alphabet and padding this encoder writes; anything else is not drawn, saved or put in an attribute. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `text` is base64 as `base64FromBytes` writes it. */
export const isBase64 = (text: string): boolean => BASE64.test(text);

/** How many bytes `base64` decodes to, without decoding it. */
export const base64Bytes = (base64: string): number => {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

/** `base64`'s bytes, or undefined for text that is not base64 (whitespace between its characters is let go, as `atob` does). */
export const bytesFromBase64 = (base64: string): Uint8Array<ArrayBuffer> | undefined => {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

    return bytes;
  } catch {
    return undefined;
  }
};

/** Bytes in a piece `base64FromBytes` turns to text: a multiple of three, so only the last piece has padding. */
const PIECE_BYTES = 3 * 8192;

/**
 * The base64 of `bytes`, written in pieces: no string of every byte (`btoa` takes one, a second copy of the bytes as large
 * as they are) is ever made, only the pieces and their join.
 */
export const base64FromBytes = (bytes: Uint8Array): string => {
  const pieces: Array<string> = [];

  for (let at = 0; at < bytes.length; at += PIECE_BYTES) {
    pieces.push(btoa(String.fromCharCode(...bytes.subarray(at, at + PIECE_BYTES))));
  }

  return pieces.join("");
};
