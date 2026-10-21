// What an image's header says, read without decoding it, so an image that already fits needs no Images binding call.
// `imageDimensions` is ported from pi-durable's `tools/image.ts`, which does not export it (MIT: see `NOTICE.md`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off

const readUint16LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8);

const readUint16BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0);

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) * 0x1000000 +
  ((bytes[offset + 1] ?? 0) << 16) +
  ((bytes[offset + 2] ?? 0) << 8) +
  (bytes[offset + 3] ?? 0);

const readUint32LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] ?? 0) +
  ((bytes[offset + 1] ?? 0) << 8) +
  ((bytes[offset + 2] ?? 0) << 16) +
  (bytes[offset + 3] ?? 0) * 0x1000000;

const startsWithAscii = (bytes: Uint8Array, offset: number, text: string): boolean =>
  bytes.length >= offset + text.length &&
  Array.from(text).every((char, index) => bytes[offset + index] === char.charCodeAt(0));

/** An image's size in pixels. */
export type Dimensions = { readonly width: number; readonly height: number };

const jpegDimensions = (bytes: Uint8Array): Dimensions | undefined => {
  for (let offset = 2; offset + 9 <= bytes.length;) {
    if (bytes[offset] !== 0xff) return undefined;

    const marker = bytes[offset + 1] ?? 0;

    if (marker === 0xff) {
      offset++;

      continue;
    }

    // SOF0 to SOF15, except DHT (C4), JPG (C8), and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: readUint16BE(bytes, offset + 7), height: readUint16BE(bytes, offset + 5) };
    }

    offset += 2 + readUint16BE(bytes, offset + 2);
  }

  return undefined;
};

const webpDimensions = (bytes: Uint8Array): Dimensions | undefined => {
  if (bytes.length < 30) return undefined;

  if (startsWithAscii(bytes, 12, "VP8 ")) {
    return { width: readUint16LE(bytes, 26) & 0x3fff, height: readUint16LE(bytes, 28) & 0x3fff };
  }

  if (startsWithAscii(bytes, 12, "VP8L")) {
    const bits = readUint32LE(bytes, 21);

    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }

  if (startsWithAscii(bytes, 12, "VP8X")) {
    const uint24 = (offset: number) =>
      readUint16LE(bytes, offset) + ((bytes[offset + 2] ?? 0) << 16);

    return { width: uint24(24) + 1, height: uint24(27) + 1 };
  }

  return undefined;
};

/**
 * The width and height an image of `mimeType` declares in its header: PNG's IHDR, GIF's screen, WebP's VP8, VP8L, or
 * VP8X chunk, JPEG's first SOF segment. `undefined` when the header is not the format's, or cannot be read.
 */
export const imageDimensions = (bytes: Uint8Array, mimeType: string): Dimensions | undefined => {
  switch (mimeType) {
    case "image/png":
      return bytes.length < 24 ||
        !startsWithAscii(bytes, 1, "PNG") ||
        !startsWithAscii(bytes, 12, "IHDR")
        ? undefined
        : { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
    case "image/gif":
      return bytes.length < 10 || !startsWithAscii(bytes, 0, "GIF8")
        ? undefined
        : { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
    case "image/webp":
      return startsWithAscii(bytes, 0, "RIFF") && startsWithAscii(bytes, 8, "WEBP")
        ? webpDimensions(bytes)
        : undefined;
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 ? jpegDimensions(bytes) : undefined;
    default:
      return undefined;
  }
};

/** Skips GIF data sub-blocks from `offset`: the offset after their terminator, or `undefined` past the end. */
const skipSubBlocks = (bytes: Uint8Array, offset: number): number | undefined => {
  let at = offset;

  while (at < bytes.length) {
    const size = bytes[at] ?? 0;

    if (size === 0) return at + 1;

    at += 1 + size;
  }

  return undefined;
};

/** Whether a GIF has more than one frame: its blocks are walked until a second image descriptor or the trailer. */
const isAnimatedGif = (bytes: Uint8Array): boolean => {
  if (bytes.length < 13) return false;

  const screenFlags = bytes[10] ?? 0;
  let offset = 13 + ((screenFlags & 0x80) !== 0 ? 3 * 2 ** ((screenFlags & 0x07) + 1) : 0);
  let frames = 0;

  while (offset < bytes.length) {
    const block = bytes[offset];

    if (block === 0x2c) {
      frames++;

      if (frames > 1) return true;

      const flags = bytes[offset + 9] ?? 0;
      const table = (flags & 0x80) !== 0 ? 3 * 2 ** ((flags & 0x07) + 1) : 0;
      // The descriptor, its color table, the LZW code size, then the image data.
      const next = skipSubBlocks(bytes, offset + 10 + table + 1);

      if (next === undefined) return false;

      offset = next;
    } else if (block === 0x21) {
      const next = skipSubBlocks(bytes, offset + 2);

      if (next === undefined) return false;

      offset = next;
    } else {
      return false;
    }
  }

  return false;
};

/** Whether an image of `mimeType` has more than one frame: a GIF with a second frame, a WebP whose VP8X says so. */
export const isAnimated = (bytes: Uint8Array, mimeType: string): boolean => {
  switch (mimeType) {
    case "image/gif":
      return isAnimatedGif(bytes);
    case "image/webp":
      return startsWithAscii(bytes, 12, "VP8X") && ((bytes[20] ?? 0) & 0x02) !== 0;
    default:
      return false;
  }
};
