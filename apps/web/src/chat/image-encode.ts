// The browser's side of an attached image going inline (`image-budget.ts` fits them): decode the file, scale it to a
// 1568 px long edge on a canvas and encode it as JPEG, or WebP (PNG where the browser cannot encode WebP) when it has
// transparency. Encodings are kept per file and quality, so fitting a changed set of images again costs no new work;
// the canvas is dropped after each encoding, so attached images do not each hold one.

// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off newPromise:off -- browser code with no Effect runtime: promises and canvas callbacks are the platform here.

import * as Predicate from "effect/Predicate";
import { type Encoded, fitLongEdge } from "./image-budget.ts";

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

const base64Of = (blob: Blob) =>
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

/** What is known of a file once decoded: whether it has transparency, and its encodings by quality. */
type Known = { readonly transparent: boolean; readonly encodings: Map<number, Promise<Encoded>> };

const known = new WeakMap<File, Promise<Known>>();

/** Whether types of this kind can hold transparency at all; a JPEG never does. */
const mayBeTransparent = (file: File) => file.type !== "image/jpeg";

/**
 * Decode `file` once, to learn whether it can be sent inline: rejects when the browser cannot read it (some HEIC, a
 * corrupt file).
 */
export const probeImage = (file: File): Promise<Known> => {
  const earlier = known.get(file);

  if (earlier !== undefined) return earlier;

  const probed = draw(file).then((canvas) => {
    const transparent = mayBeTransparent(file) && hasTransparency(canvas);

    canvas.width = 0;
    canvas.height = 0;

    return { transparent, encodings: new Map<number, Promise<Encoded>>() };
  });

  known.set(file, probed);

  return probed;
};

/** `file` for the model at `quality`: JPEG, or WebP (else PNG) when it has transparency. */
export const encodeImage = async (file: File, quality: number): Promise<Encoded> => {
  const { transparent, encodings } = await probeImage(file);
  const earlier = encodings.get(quality);

  if (earlier !== undefined) return earlier;

  const encoded = (async () => {
    const canvas = await draw(file);

    try {
      let blob = await toBlob(canvas, transparent ? "image/webp" : "image/jpeg", quality);

      // A browser that cannot encode WebP gives PNG for it, as for any type it does not know.
      if (transparent && blob.type !== "image/webp") blob = await toBlob(canvas, "image/png", 1);

      return { mimeType: blob.type, data: await base64Of(blob) };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  })();

  encodings.set(quality, encoded);
  encoded.catch(() => encodings.delete(quality));

  return encoded;
};
