// A fake Cloudflare Images binding, for tests of what the Session does with images without the Images service. Its
// "images" are a JSON header ({ width, height }) padded to their size, after the start of a real format's header when a
// test needs one read locally; an output is as many bytes as its pixels times `bytesPerPixel` (by default the output
// quality as a fraction), so how an output's size follows its dimensions and quality is known to the test. It records
// each transformation it was asked for.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
import type { ImagesService } from "./images.ts";

/** A real format's header a fake image starts with: `none` reads as no format, so only the binding can size it. */
export type FakeHeader = "none" | "png" | "jpeg" | "gif" | "webp" | "bmp";

const u16le = (value: number) => [value & 0xff, (value >>> 8) & 0xff];
const u16be = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u24le = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff];
const u32be = (value: number) => [...u16be(value >>> 16), ...u16be(value & 0xffff)];
const u32le = (value: number) => [...u16le(value & 0xffff), ...u16le(value >>> 16)];
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/** The start of an image of `width` x `height` in `header`'s format, with as many frames as it says. */
const headerBytes = (header: FakeHeader, width: number, height: number, animated: boolean) => {
  switch (header) {
    case "none":
      return [];
    case "png":
      return [
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
        ...u32be(13),
        ...ascii("IHDR"),
        ...u32be(width),
        ...u32be(height),
        8,
        2,
        ...Array(7).fill(0),
      ];
    case "jpeg":
      // SOI, then a baseline SOF segment.
      return [
        0xff,
        0xd8,
        0xff,
        0xc0,
        ...u16be(17),
        8,
        ...u16be(height),
        ...u16be(width),
        3,
        ...Array(9).fill(0),
      ];
    case "gif": {
      const frame = [
        0x2c,
        ...u16le(0),
        ...u16le(0),
        ...u16le(width),
        ...u16le(height),
        0,
        2,
        1,
        0,
        0,
      ];

      return [
        ...ascii("GIF89a"),
        ...u16le(width),
        ...u16le(height),
        0,
        0,
        0,
        ...frame,
        ...(animated ? frame : []),
        0x3b,
      ];
    }

    case "webp":
      return [
        ...ascii("RIFF"),
        ...u32le(0),
        ...ascii("WEBPVP8X"),
        ...u32le(10),
        animated ? 0x02 : 0,
        0,
        0,
        0,
        ...u24le(width - 1),
        ...u24le(height - 1),
      ];
    case "bmp":
      return [
        ...ascii("BM"),
        ...u32le(0),
        ...u32le(0),
        ...u32le(54),
        ...u32le(40),
        ...u32le(width),
        ...u32le(height),
        ...u16le(1),
        ...u16le(24),
      ];
  }
};

export type FakeImageOptions = {
  /** Its length in bytes; at least its headers'. */
  readonly size?: number;
  readonly header?: FakeHeader;
  /** A GIF or WebP with more than one frame. */
  readonly animated?: boolean;
};

/** A fake image of `width` x `height`. */
export const fakeImage = (width: number, height: number, options: FakeImageOptions = {}) => {
  const start = headerBytes(options.header ?? "none", width, height, options.animated ?? false);
  const json = new TextEncoder().encode(`${JSON.stringify({ width, height })}\n`);
  const bytes = new Uint8Array(Math.max(options.size ?? 64, start.length + json.length));

  bytes.set(start);
  bytes.set(json, start.length);

  return bytes;
};

const describe = async (stream: ReadableStream<Uint8Array>) => {
  const text = await new Response(stream).text();
  const header = text.slice(text.indexOf('{"width"'), text.indexOf("\n", text.indexOf('{"width"')));

  // SAFETY: every fake image holds the JSON header `fakeImage` writes, after its magic number if it has one.
  return JSON.parse(header) as { readonly width: number; readonly height: number };
};

/** A transformation the fake was asked for: its size, and its output's format and quality. */
export type FakeOutput = {
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly quality: number | undefined;
};

export type FakeImagesOptions = {
  /** Bytes of output per pixel at `quality`; by default `quality / 100`. */
  readonly bytesPerPixel?: (quality: number) => number;
  /** The least bytes any output is, however small: an image that cannot be made to fit. */
  readonly leastBytes?: number;
  /** Every call fails with this message, as a binding over its quota does. */
  readonly failing?: string;
};

/** A fake Images binding and the outputs it made, in order. */
export const fakeImages = (options: FakeImagesOptions = {}) => {
  const outputs: FakeOutput[] = [];
  const bytesPerPixel = options.bytesPerPixel ?? ((quality: number) => quality / 100);

  const images: ImagesService = {
    info: async (stream) => {
      if (options.failing !== undefined) throw new Error(options.failing);

      const { width, height } = await describe(stream);

      return { format: "image/png", fileSize: 0, width, height };
    },
    input: (stream) => ({
      transform: (transform) => ({
        output: async ({ format, quality }) => {
          if (options.failing !== undefined) throw new Error(options.failing);

          const source = await describe(stream);

          const scale = Math.min(
            1,
            transform.width / source.width,
            transform.height / source.height,
          );

          const width = Math.round(source.width * scale);
          const height = Math.round(source.height * scale);

          outputs.push({ width, height, format, quality });

          const image = fakeImage(width, height, {
            size: Math.max(
              options.leastBytes ?? 0,
              Math.ceil(width * height * bytesPerPixel(quality ?? 85)),
            ),
          });

          return { image: () => new Response(image).body! };
        },
      }),
    }),
  };

  return { images, outputs };
};
