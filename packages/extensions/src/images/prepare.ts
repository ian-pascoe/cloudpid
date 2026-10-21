// Preparing an image the agent reads for the conversation: as it is when it fits already, else scaled down and
// re-encoded by the Cloudflare Images binding (not in the Session DO's own isolate), or left out with the reason.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import type { ImageLimits, ImageProcessor, PreparedImage } from "@earendil-works/pi-durable/tools";
import type * as Types from "effect/Types";
import { type Dimensions, imageDimensions, isAnimated } from "./dimensions.ts";

/**
 * The longest image kept in a conversation, in base64 characters (about 560 KB). An image enters the conversation, so it
 * is stored in the Session's SQLite, sent to the model with every later request, and sent to each client in the
 * transcript's snapshot: the bound keeps a few of them from outgrowing any of the three.
 */
export const MAX_IMAGE_CHARACTERS = 750_000;

/**
 * The largest image file `read` takes into memory: what the Images binding accepts as input. pi-durable's `read` reads an
 * image whole before preparing it, in the Session DO's 128 MB isolate.
 */
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;

/**
 * The most transformations one image gets: each output is billed as Images usage (sizes, not qualities or formats, make
 * a transformation unique), and each takes a round trip.
 */
export const MAX_IMAGE_ATTEMPTS = 6;

/** What the Session uses of the Cloudflare Images binding (`ImagesBinding`); a fake stands in for it in tests. */
export interface ImagesService {
  info(stream: ReadableStream<Uint8Array>): Promise<{
    readonly format: string;
    readonly width?: number;
    readonly height?: number;
  }>;
  input(stream: ReadableStream<Uint8Array>): {
    transform(transform: {
      readonly width: number;
      readonly height: number;
      readonly fit: "scale-down";
    }): {
      output(options: {
        readonly format: "image/jpeg" | "image/webp";
        readonly quality?: number;
        readonly anim?: boolean;
      }): Promise<{ image(): ReadableStream<Uint8Array> }>;
    };
  };
}

/**
 * Formats every provider takes inline, and the Images binding takes as input. pi-durable's `read` also finds BMP, which
 * the binding does not take.
 */
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * An image prepared for the conversation, with what the model should know of it that pi-durable's own notes (resized,
 * converted) do not say; or why it was left out.
 */
export type ImagePreparation =
  | { readonly image: PreparedImage; readonly notes: readonly string[] }
  | { readonly leftOut: string };

/** The output qualities tried: the first, then the second for an output a little over the bound. */
const QUALITIES = [80, 60] as const;

/** The share of the bound an output at the first quality must fit within for the second to be tried at its size. */
const QUALITY_STEP_REACH = 0.6;

/** The length of the base64 of `byteLength` bytes. */
const base64Length = (byteLength: number) => Math.ceil(byteLength / 3) * 4;

/** Standard base64 of `bytes`, built 8 KiB at a time: one `String.fromCharCode` call with megabytes of arguments overflows the stack. */
const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";

  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }

  return btoa(binary);
};

/** `characters` for people: `750,000`. */
const count = (characters: number) => characters.toLocaleString("en-US");

/**
 * `bytes`, an image of `mimeType`, prepared to fit `limits` and `MAX_IMAGE_CHARACTERS`: as it is when it already does,
 * else scaled down and re-encoded by `images`; or why it could not be.
 */
export const prepareImage = async (
  images: ImagesService,
  bytes: Uint8Array,
  mimeType: string,
  limits: ImageLimits,
): Promise<ImagePreparation> => {
  if (!INLINE_IMAGE_TYPES.has(mimeType)) {
    const format = mimeType.replace(/^image\//, "").toUpperCase();

    return { leftOut: `${format} images are not supported; convert it to PNG first and read that` };
  }

  try {
    return await fit(images, bytes, mimeType, limits);
  } catch (error) {
    // A file the service cannot decode, the account's monthly transformations used up (error 9422), an outage.
    return {
      leftOut: `the image service failed (${error instanceof Error ? error.message : String(error)})`,
    };
  }
};

const fit = async (
  images: ImagesService,
  bytes: Uint8Array,
  mimeType: string,
  limits: ImageLimits,
): Promise<ImagePreparation> => {
  const maxCharacters = Math.min(limits.maxBytes, MAX_IMAGE_CHARACTERS);
  // One copy, read again for each call: a stream is consumed by the call it is given to.
  const source = new Blob([bytes]);

  // From the header, so an image that fits needs no call; else from the binding, whose `info` is not billed.
  const { width, height }: Partial<Dimensions> =
    imageDimensions(bytes, mimeType) ?? (await images.info(source.stream()));

  if (width === undefined || height === undefined) return { leftOut: "its size cannot be read" };

  if (
    width <= limits.maxWidth &&
    height <= limits.maxHeight &&
    base64Length(bytes.byteLength) <= maxCharacters
  ) {
    return { image: { data: toBase64(bytes), mimeType }, notes: [] };
  }

  // JPEG stays JPEG; anything else becomes WebP, which keeps transparency and is far smaller than PNG.
  const format = mimeType === "image/jpeg" ? "image/jpeg" : "image/webp";
  const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height);

  let size = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };

  let quality: number = QUALITIES[0];

  for (let attempt = 0; attempt < MAX_IMAGE_ATTEMPTS; attempt++) {
    const output = await images
      .input(source.stream())
      .transform({ ...size, fit: "scale-down" })
      .output({ format, quality, anim: false });

    const encoded = new Uint8Array(await new Response(output.image()).arrayBuffer());
    const characters = base64Length(encoded.byteLength);

    if (characters <= maxCharacters) {
      const image: Types.Mutable<PreparedImage> = {
        data: toBase64(encoded),
        mimeType: format,
      };

      const notes: string[] = [];
      const resized = size.width !== width || size.height !== height;

      if (resized) image.resized = { from: { width, height }, to: size };

      if (format !== mimeType) image.convertedFrom = mimeType;

      // pi-durable notes a resize or a conversion; an image only re-encoded would otherwise read as the original.
      if (!resized && format === mimeType) {
        notes.push(
          `Re-encoded at quality ${quality} to fit the conversation's limit of ${count(maxCharacters)} base64 characters.`,
        );
      }

      if (isAnimated(bytes, mimeType))
        notes.push("It was animated; only its first frame is shown.");

      return { image, notes };
    }

    const fitting = maxCharacters / characters;

    // A little over: the same size at a lower quality, which Images bills as the same transformation.
    if (quality === QUALITIES[0] && fitting >= QUALITY_STEP_REACH) {
      quality = QUALITIES[1];

      continue;
    }

    if (size.width === 1 && size.height === 1) break;

    // Bytes go roughly with pixels: both sides shrink by the square root of the share that fits, with a margin, and by
    // at least a quarter.
    const factor = Math.min(0.75, Math.sqrt(fitting) * 0.9);

    size = {
      width: Math.max(1, Math.floor(size.width * factor)),
      height: Math.max(1, Math.floor(size.height * factor)),
    };
  }

  return {
    leftOut: `it could not be reduced to ${count(maxCharacters)} base64 characters, the most an image in the conversation may be; make a smaller copy of it (fewer pixels, or a JPEG) and read that`,
  };
};

/** What `cloudflareImages` makes of each image: `observe` is told every preparation, the left-out ones included. */
export type CloudflareImagesOptions = {
  readonly observe?: (preparation: ImagePreparation, mimeType: string) => void;
};

/**
 * An `ImageProcessor` for pi-durable's `read` over the Images binding: `prepareImage`, `undefined` for an image it leaves
 * out.
 */
export const cloudflareImages = (
  images: ImagesService,
  options: CloudflareImagesOptions = {},
): ImageProcessor => ({
  prepare: async (bytes, mimeType, limits) => {
    const prepared = await prepareImage(images, bytes, mimeType, limits);

    options.observe?.(prepared, mimeType);

    return "image" in prepared ? prepared.image : undefined;
  },
});
