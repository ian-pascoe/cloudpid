// The Session's `read`: pi-durable's, with every image it returns prepared to fit the conversation (`./prepare.ts`), the
// image file it takes into memory bounded, and what it left out or re-encoded said in the result.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { type BinaryReader, type ExecutionEnv, ok } from "@earendil-works/pi-durable/env";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import {
  cloudflareImages,
  type ImagePreparation,
  type ImagesService,
  MAX_IMAGE_FILE_BYTES,
} from "./prepare.ts";

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
 * It offers the formats the binding takes (not BMP, which pi-durable's `read` offers with a processor). An image that
 * cannot be made to fit, or whose file is over `MAX_IMAGE_FILE_BYTES`, is left out: the result is an error that says so
 * and why, and the Session goes on.
 */
export const readTool = (images: ImagesService) => {
  // Without a processor, pi-durable's description lists the inline formats only.
  const base = createReadTool();

  return defineTool({
    ...base,
    async execute(args, api, context) {
      // This call's image, as prepared: pi-durable's own error does not say why one was left out, nor its notes what
      // else was done to it.
      let prepared:
        | { readonly preparation: ImagePreparation; readonly mimeType: string }
        | undefined;

      const read = createReadTool({
        images: cloudflareImages(images, {
          observe: (preparation, mimeType) => {
            prepared = { preparation, mimeType };
          },
        }),
      });

      try {
        const result = await read.execute(
          args,
          api.env === undefined ? api : { ...api, env: boundedReads(api.env) },
          context,
        );

        if (prepared === undefined) return result;

        const { preparation, mimeType } = prepared;

        if ("leftOut" in preparation) {
          return result.isError === true
            ? leftOutResult(
                `${args.path} is an image (${mimeType}) that was left out: ${preparation.leftOut}.`,
              )
            : result;
        }

        if (preparation.notes.length === 0 || result.isError === true) return result;

        return {
          ...result,
          diagnostics: [
            ...(result.diagnostics ?? []),
            { severity: "info", code: "image", message: preparation.notes.join(" ") },
          ],
        };
      } catch (error) {
        if (!(error instanceof ImageFileTooLarge)) throw error;

        return leftOutResult(
          `${args.path} is an image file of ${megabytes(error.size)}, over the ${megabytes(MAX_IMAGE_FILE_BYTES)} an image may be; it was left out. Make a smaller copy of it and read that.`,
        );
      }
    },
  });
};
