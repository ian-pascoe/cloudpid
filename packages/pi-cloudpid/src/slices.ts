// @effect-diagnostics missingPipeableSignature:off nodeBuiltinImport:off -- plain functions over values, called directly; runs on node, on the owner's machine.
/**
 * The file as the endpoint takes it (docs/architecture/mcp-endpoint.md → Session import → The import channel): slices cut
 * by UTF-8 byte offset, each at a character boundary and at most `max` bytes, and the SHA-256 of the whole.
 */
import { createHash } from "node:crypto";

/** One append: where `data` starts in the file (bytes), and the bytes it covers. */
export interface Slice {
  readonly offset: number;
  readonly data: string;
  readonly bytes: number;
}

const encoder = new TextEncoder();

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The UTF-8 bytes of the file. */
export const fileBytes = (text: string): Uint8Array => encoder.encode(text);

/** The lowercase hex SHA-256 of the file. */
export const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Whether `byte` continues a UTF-8 character (`10xxxxxx`), so a cut before it would split one. */
const continues = (byte: number | undefined): boolean =>
  byte !== undefined && (byte & 0xc0) === 0x80;

/**
 * The slice of `bytes` that starts at `offset`: up to `max` bytes, cut back to the last character boundary, or none at the
 * end. An `offset` inside a character, or a `max` too small for the character there, is an error: the endpoint holds
 * whole characters only, so it never asks for one.
 */
export const sliceAt = (bytes: Uint8Array, offset: number, max: number): Slice | undefined => {
  if (offset >= bytes.length) return undefined;

  if (continues(bytes[offset])) {
    throw new RangeError(`offset ${String(offset)} is inside a character`);
  }

  let end = Math.min(offset + max, bytes.length);

  while (end > offset && continues(bytes[end])) end -= 1;

  if (end === offset) {
    throw new RangeError(`a slice of ${String(max)} bytes holds no whole character`);
  }

  return { offset, data: decoder.decode(bytes.subarray(offset, end)), bytes: end - offset };
};
