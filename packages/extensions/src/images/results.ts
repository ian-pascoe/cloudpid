// One tool result's images, held to a total. Each image `read` returns is held to `MAX_IMAGE_CHARACTERS`, and a
// browser screenshot too, but a result can carry several: a `codemode` script can `image()` many (pi-codemode allows 16
// Mi characters of output), and a browser run can take several screenshots. The result is one SQLite row all the same.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";

/**
 * The most base64 characters of images one tool result holds (two images at `MAX_IMAGE_CHARACTERS`), leaving room under
 * the 8 MiB row (workerd#7493) for the result's text, details, and diagnostics.
 */
export const MAX_RESULT_IMAGE_CHARACTERS = 1_500_000;

type TextItem = { readonly type: "text"; readonly text: string };

type ImageItem = { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** What stands in for an image left out of a result. */
const leftOut = (image: ImageItem): TextItem => ({
  type: "text",
  text: `[An image (${image.mimeType}, about ${Math.round((image.data.length * 3) / 4 / 1000)} KB) was left out: one tool result holds at most ${MAX_RESULT_IMAGE_CHARACTERS.toLocaleString("en-US")} base64 characters of images. Show fewer images at once.]`,
});

/**
 * `items` with their images kept in order until the next one would take them over `MAX_RESULT_IMAGE_CHARACTERS`; that
 * one and every image after it becomes a note saying it was left out. Items whose images fit are returned as they are.
 */
export const boundImages = <Item extends TextItem | ImageItem>(
  items: readonly Item[],
): readonly (Item | TextItem)[] => {
  let total = 0;
  let spent = false;

  const bounded = items.map((item): Item | TextItem => {
    if (item.type !== "image") return item;

    // SAFETY: `Item` is a text or an image item, and this one is not text.
    const image = item as ImageItem;

    spent ||= total + image.data.length > MAX_RESULT_IMAGE_CHARACTERS;

    if (spent) return leftOut(image);

    total += image.data.length;

    return item;
  });

  return spent ? bounded : items;
};

/**
 * Every tool result's images held to `MAX_RESULT_IMAGE_CHARACTERS` before the result is stored: a call's own and a
 * nested one's (a script's tool calls), through pi-durable's `afterTool` hook.
 */
export const ResultImages = defineExtension({
  name: "result-images",
  hooks: [
    hook(ToolTask, {
      afterTool: (_call, result) => {
        if (result.output === undefined) return undefined;

        const output = boundImages(result.output);

        return output === result.output ? undefined : { ...result, output: [...output] };
      },
    }),
  ],
});
