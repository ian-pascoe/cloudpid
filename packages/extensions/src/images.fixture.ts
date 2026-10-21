// A fake Cloudflare Images binding, for tests of what the Session does with images without the Images service. Its
// "images" are a JSON header ({ width, height }) padded to their size; an output is as many bytes as its pixels times
// `bytesPerPixel` (by default the output quality as a fraction), so how an output's size follows its dimensions and
// quality is known to the test. It records each transformation it was asked for.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
import type { ImagesService } from "./images.ts";

/** JPEG's magic number, which makes a fake image a JPEG to `read`. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];

/** A fake image of `width` x `height` that is `size` bytes long; one that `read` takes for a JPEG when `jpeg`. */
export const fakeImage = (width: number, height: number, size = 64, jpeg = false): Uint8Array => {
  const magic = jpeg ? JPEG_MAGIC : [];
  const header = new TextEncoder().encode(`${JSON.stringify({ width, height })}\n`);
  const bytes = new Uint8Array(Math.max(size, magic.length + header.length));

  bytes.set(magic);
  bytes.set(header, magic.length);

  return bytes;
};

const describe = async (stream: ReadableStream<Uint8Array>) => {
  const text = await new Response(stream).text();
  const header = text.slice(text.indexOf("{"), text.indexOf("\n"));

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

          const image = fakeImage(
            width,
            height,
            Math.max(
              options.leastBytes ?? 0,
              Math.ceil(width * height * bytesPerPixel(quality ?? 85)),
            ),
          );

          return { image: () => new Response(image).body! };
        },
      }),
    }),
  };

  return { images, outputs };
};
