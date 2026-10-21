// The browser's side of an attached image going inline (`image-budget.ts` fits them): decode the file, scale it to a
// 1568 px long edge on a canvas and encode it as JPEG, or WebP (PNG where the browser cannot encode WebP) when it has
// transparency. Each file is decoded and drawn once, and the drawing kept until the file is sent or removed; encodings
// are kept per file and quality, so fitting a changed set of images again costs no new work.

// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off newPromise:off -- browser code with no Effect runtime: promises and canvas callbacks are the platform here.

import * as Predicate from "effect/Predicate";
import { INLINE_IMAGE_BUDGET } from "@cloudpid/protocol";
import { type Encoded, fitLongEdge, QUALITIES } from "./image-budget.ts";

type Picture = ImageBitmap | HTMLImageElement;

/** Decode `file`: as a bitmap, upright by its orientation; else through an image element, which decodes more types. */
const decode = async (file: File): Promise<Picture> => {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.src = url;

    try {
      await image.decode();
    } finally {
      URL.revokeObjectURL(url);
    }

    return image;
  }
};

const sizeOf = (picture: Picture) =>
  picture instanceof HTMLImageElement
    ? { width: picture.naturalWidth, height: picture.naturalHeight }
    : { width: picture.width, height: picture.height };

/** `file` drawn at the size the model gets, on a canvas of its own. */
const draw = async (file: File): Promise<HTMLCanvasElement> => {
  const picture = await decode(file);
  const natural = sizeOf(picture);

  if (natural.width === 0 || natural.height === 0) throw new Error("The image has no pixels");

  const { width, height } = fitLongEdge(natural.width, natural.height);
  const canvas = document.createElement("canvas");

  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");

  if (context === null) throw new Error("The browser has no canvas to draw on");

  context.imageSmoothingQuality = "high";
  context.drawImage(picture, 0, 0, width, height);

  if (!(picture instanceof HTMLImageElement)) picture.close();

  return canvas;
};

/** Whether any pixel of `canvas` is not fully opaque. */
const hasTransparency = (canvas: HTMLCanvasElement): boolean => {
  const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;

  if (pixels === undefined) return false;

  for (let index = 3; index < pixels.length; index += 4) {
    if ((pixels[index] ?? 255) < 255) return true;
  }

  return false;
};

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error("The image could not be encoded"));
        else resolve(blob);
      },
      type,
      quality,
    );
  });

const base64Of = (blob: Blob): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("load", () => {
      // `readAsDataURL` gives a string.
      const url = Predicate.isString(reader.result) ? reader.result : "";

      resolve(url.slice(url.indexOf(",") + 1));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The image could not be read"));
    });
    reader.readAsDataURL(blob);
  });

/**
 * What is known of a file once decoded: its picture at the size the model gets, whether it has transparency, and its
 * encodings by quality (a lossless PNG once, as it is the same at each).
 */
type Known = {
  readonly canvas: HTMLCanvasElement;
  readonly transparent: boolean;
  readonly encodings: Map<number, Promise<Encoded>>;
  png: Promise<Encoded> | undefined;
};

const known = new WeakMap<File, Promise<Known>>();

/** Whether types of this kind can hold transparency at all; a JPEG never does. */
const mayBeTransparent = (file: File) => file.type !== "image/jpeg";

/** The base64 characters `bytes` bytes take. */
const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;

/**
 * Decode `file` once and draw it at the size the model gets, to learn whether it can be sent inline: rejects when the
 * browser cannot read it (some HEIC, a corrupt file). The drawing is kept for `encodeImage` until `releaseImage`.
 */
export const probeImage = (file: File): Promise<Known> => {
  const earlier = known.get(file);

  if (earlier !== undefined) return earlier;

  const probed = draw(file).then((canvas) => ({
    canvas,
    transparent: mayBeTransparent(file) && hasTransparency(canvas),
    encodings: new Map<number, Promise<Encoded>>(),
    png: undefined,
  }));

  known.set(file, probed);
  probed.catch(() => known.delete(file));

  return probed;
};

/** Drop what was kept of `file` for encoding: its message was sent, or it was removed. */
export const releaseImage = (file: File): void => {
  const earlier = known.get(file);

  known.delete(file);
  void earlier?.then(
    ({ canvas }) => {
      canvas.width = 0;
      canvas.height = 0;
    },
    () => {},
  );
};

/**
 * `file` for the model at `quality`: JPEG, or WebP (else PNG) when it has transparency. A GIF goes unchanged at the
 * best quality when it fits the budget alone, so it stays animated; at the others it is a still like any picture.
 */
export const encodeImage = async (file: File, quality: number): Promise<Encoded> => {
  if (
    file.type === "image/gif" &&
    quality === QUALITIES[0] &&
    base64Length(file.size) <= INLINE_IMAGE_BUDGET
  ) {
    return { mimeType: file.type, data: await base64Of(file) };
  }

  const image = await probeImage(file);
  const earlier = image.encodings.get(quality);

  if (earlier !== undefined) return earlier;

  const encoded = (async () => {
    if (image.png !== undefined) return image.png;

    const blob = await toBlob(
      image.canvas,
      image.transparent ? "image/webp" : "image/jpeg",
      quality,
    );

    // A browser that cannot encode WebP gives PNG for it, as for any type it does not know: lossless, so kept once.
    if (image.transparent && blob.type !== "image/webp") {
      image.png = toBlob(image.canvas, "image/png", 1).then(async (png) => ({
        mimeType: png.type,
        data: await base64Of(png),
      }));

      return image.png;
    }

    return { mimeType: blob.type, data: await base64Of(blob) };
  })();

  image.encodings.set(quality, encoded);
  encoded.catch(() => image.encodings.delete(quality));

  return encoded;
};
