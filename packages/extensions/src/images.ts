// Images the agent reads, prepared for the conversation (`docs/spec.md` → Filesystem and tools). An image a tool
// returns is part of a tool result, which is one conversation entry: one row of the Session DO's SQLite, which
// Cloudflare caps at 2 MB. So every image is held to `MAX_IMAGE_CHARACTERS` of base64, whatever the model would take,
// and one over it is scaled down and re-encoded by the Cloudflare Images binding (not in the Session DO's own isolate),
// or left out with a reason.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { type BinaryReader, type ExecutionEnv, ok } from "@earendil-works/pi-durable/env";
import {
  createReadTool,
  type ImageLimits,
  type ImageProcessor,
  type PreparedImage,
} from "@earendil-works/pi-durable/tools";
import * as Context from "effect/Context";

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

/** Formats every provider takes inline. */
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** An image prepared for the conversation, or why it was left out. */
export type ImagePreparation = { readonly image: PreparedImage } | { readonly leftOut: string };

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

/**
 * The most transformations one image gets: each output is billed as Images usage (sizes, not qualities or formats, make
 * a transformation unique), and each takes a round trip.
 */
export const MAX_IMAGE_ATTEMPTS = 6;

/** The output qualities tried: the first, then the second for an output a little over the bound. */
const QUALITIES = [80, 60] as const;

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Blob([bytes]).stream();

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
  // Free: only transformations are billed.
  const { width, height } = await images.info(streamOf(bytes));

  if (width === undefined || height === undefined) return { leftOut: "its size cannot be read" };

  if (
    INLINE_IMAGE_TYPES.has(mimeType) &&
    width <= limits.maxWidth &&
    height <= limits.maxHeight &&
    base64Length(bytes.byteLength) <= maxCharacters
  ) {
    return { image: { data: toBase64(bytes), mimeType } };
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
      .input(streamOf(bytes))
      .transform({ ...size, fit: "scale-down" })
      .output({ format, quality, anim: false });

    const encoded = new Uint8Array(await new Response(output.image()).arrayBuffer());
    const characters = base64Length(encoded.byteLength);

    if (characters <= maxCharacters) {
      const resized =
        size.width === width && size.height === height
          ? {}
          : { resized: { from: { width, height }, to: size } };

      const converted = format === mimeType ? {} : { convertedFrom: mimeType };

      return { image: { data: toBase64(encoded), mimeType: format, ...converted, ...resized } };
    }

    const over = maxCharacters / characters;

    // A little over: the same size at a lower quality, which Images bills as the same transformation.
    if (quality === QUALITIES[0] && over >= 0.6) {
      quality = QUALITIES[1];

      continue;
    }

    if (size.width === 1 && size.height === 1) break;

    // Bytes go roughly with pixels: both sides shrink by the square root of how far over it was, with a margin, and by
    // at least a quarter.
    const factor = Math.min(0.75, Math.sqrt(over) * 0.9);

    size = {
      width: Math.max(1, Math.floor(size.width * factor)),
      height: Math.max(1, Math.floor(size.height * factor)),
    };
  }

  return {
    leftOut: `it could not be reduced to ${maxCharacters.toLocaleString("en-US")} base64 characters, the most an image in the conversation may be`,
  };
};

/** An `ImageProcessor` for pi-durable's `read` over the Images binding: `prepareImage`, `undefined` for an image it leaves out. */
export const cloudflareImages = (images: ImagesService): ImageProcessor => ({
  prepare: async (bytes, mimeType, limits) => {
    const prepared = await prepareImage(images, bytes, mimeType, limits);

    return "image" in prepared ? prepared.image : undefined;
  },
});

/** The Session's Images binding, which `read` prepares images with. */
export class Images extends Context.Service<Images, ImagesService>()(
  "@cloudpid/extensions/images",
) {}

/** `bytes` for people, in megabytes. */
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** A read of more than `MAX_IMAGE_FILE_BYTES` at once: only `read` taking a whole image file asks for one. */
// @effect-diagnostics-next-line extendsNativeError:off -- thrown inside pi-durable's `read`, through its reader, to stop it.
class ImageFileTooLarge extends Error {
  readonly size: number;

  constructor(size: number) {
    super(`An image file of ${megabytes(size)} is too large to read`);
    this.size = size;
  }
}

/** `reader`, refusing any read of more than `MAX_IMAGE_FILE_BYTES` (`ImageFileTooLarge`) before it is made. */
const boundedReader = (reader: BinaryReader): BinaryReader => ({
  info: (context) => reader.info(context),
  scanLines: (options, context) => reader.scanLines(options, context),
  close: (context) => reader.close(context),
  read: (offset, length, context) => {
    if (length > MAX_IMAGE_FILE_BYTES) throw new ImageFileTooLarge(length);

    return reader.read(offset, length, context);
  },
});

/**
 * `env`, whose binary readers refuse a read of more than `MAX_IMAGE_FILE_BYTES`. `read` reads text in small chunks and
 * an image whole, so only an image file over the limit is refused, before any of it is read.
 */
const boundedReads = (env: ExecutionEnv): ExecutionEnv => {
  const open: ExecutionEnv["openBinaryReader"] = async (path, options, context) => {
    const opened = await env.openBinaryReader(path, options, context);

    return opened.ok ? ok(boundedReader(opened.value)) : opened;
  };

  // A proxy, not a copy: the environment may have more than `ExecutionEnv` names (`BackendEnv`, say).
  return new Proxy(env, {
    get: (target, key) => {
      if (key === "openBinaryReader") return open;

      // SAFETY: a property read of the environment, which the proxy passes on as it is.
      const value: unknown = target[key as keyof ExecutionEnv];

      // Methods run on the environment itself: a class's private fields are not on the proxy.
      return value instanceof Function ? value.bind(target) : value;
    },
  });
};

/** An error result whose message tells the model the image was left out, and why. */
const leftOutResult = (message: string): ToolExecutionResult => ({
  output: [],
  isError: true,
  diagnostics: [{ severity: "error", code: "image_left_out", message }],
});

/**
 * pi-durable's `read`, preparing every image it returns with `images` (`prepareImage`), so each fits the conversation.
 * An image that cannot be made to fit, or whose file is over `MAX_IMAGE_FILE_BYTES`, is left out: the result is an
 * error that says so and why, and the Session goes on.
 */
export const readTool = (images: ImagesService) => {
  const base = createReadTool({ images: cloudflareImages(images) });

  return defineTool({
    ...base,
    async execute(args, api, context) {
      // Why this call's image was left out, which pi-durable's own error does not say.
      let leftOut: { readonly mimeType: string; readonly reason: string } | undefined;

      const read = createReadTool({
        images: {
          prepare: async (bytes, mimeType, limits) => {
            const prepared = await prepareImage(images, bytes, mimeType, limits);

            if ("image" in prepared) return prepared.image;

            leftOut = { mimeType, reason: prepared.leftOut };

            return undefined;
          },
        },
      });

      try {
        const result = await read.execute(
          args,
          api.env === undefined ? api : { ...api, env: boundedReads(api.env) },
          context,
        );

        if (leftOut === undefined || result.isError !== true) return result;

        return leftOutResult(
          `${args.path} is an image (${leftOut.mimeType}) that was left out: ${leftOut.reason}. Make a smaller copy of it (fewer pixels, or a JPEG) and read that.`,
        );
      } catch (error) {
        if (!(error instanceof ImageFileTooLarge)) throw error;

        return leftOutResult(
          `${args.path} is an image file of ${megabytes(error.size)}, over the ${megabytes(MAX_IMAGE_FILE_BYTES)} an image may be; it was left out. Make a smaller copy of it and read that.`,
        );
      }
    },
  });
};
