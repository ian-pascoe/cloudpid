// What an Attached resource became in the owner's message (`docs/architecture/mcp-in-a-session.md` → Attached resources): as
// a function over what a `resources/read` returned (or why it did not), the `<resource>` elements of the untrusted
// `<mcp_resources>` block, the inline images that follow it, and what the entry keeps for the chip. Nothing here reads a server
// or the Workspace: `save` writes a file. Every value is cleaned, redacted of the Secrets the Session holds, and only then
// escaped, so a Secret a character the cleaning drops split is whole when it is redacted, and nothing a server wrote can
// close the block or open another.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- the Workspace's file writes are Promise-native; plain functions over short lists.
import { normalizeMcpName } from "@cloudpid/config";
import {
  ATTACHED_KIND,
  type AttachedResource,
  boundedText,
  cleanText,
  isInlineImageType,
  MAX_RESOURCE_ERROR,
  MAX_RESOURCE_INLINE_TEXT_BYTES,
  MAX_RESOURCE_NAME,
  MAX_RESOURCE_URI,
  oneLine,
  type ResourceRef,
  resourceElement,
  resourcesBlock,
} from "@cloudpid/protocol";
import type { AttachedContent } from "@cloudpid/extensions/mcp";
import * as Arr from "effect/Array";
import type { Mutable } from "effect/Types";
import { base64Bytes, decodeBase64, type PromptFile, type PromptImage } from "./mcp-prompt.ts";

const encoder = new TextEncoder();

/** What the message's Attached resources share while their elements are made: the image budget and the inline text room. */
export type AttachedBudgets = {
  /** How many base64 characters of inline images the message has room for. */
  images: number;
  /** How many UTF-8 bytes of inline text the message's resources may still keep together. */
  text: number;
};

/** What one Attached resource becomes. */
export type AttachedMade = {
  /** Its `<resource>` elements, one for each content the server returned. */
  readonly elements: ReadonlyArray<string>;
  /** The images that go inline, after the block, in order. */
  readonly images: ReadonlyArray<PromptImage>;
  /** What the entry keeps for its chip. */
  readonly chip: AttachedResource;
};

/** `value` cleaned, redacted and on one line, cut to `max` code points: ready to be an attribute, which `resourceElement` escapes. */
const lineOf = (redact: <A>(value: A) => A, value: string, max: number): string =>
  boundedText(redact(oneLine(cleanText(value))), max);

/** The chip's and the elements' common facts about a resource the owner attached. */
type Known = {
  readonly redact: <A>(value: A) => A;
  readonly server: string;
  readonly ref: ResourceRef;
};

/** The chip for `ref`, before it is known how it went into the message. */
const chipOf = (known: Known): Mutable<AttachedResource> => {
  const chip: Mutable<AttachedResource> = {
    server: known.server,
    uri: lineOf(known.redact, known.ref.uri, MAX_RESOURCE_URI),
    kind: ATTACHED_KIND.text,
  };

  if (known.ref.name !== undefined) {
    const name = lineOf(known.redact, known.ref.name, MAX_RESOURCE_NAME);

    if (name !== "") chip.name = name;
  }

  return chip;
};

/** The element and chip of a resource the read could not make a message of. */
export type FailedResource = { readonly element: string; readonly chip: AttachedResource };

/** The element and chip of a resource the read could not make a message of: its error line. */
export const failedResource = (
  redact: <A>(value: A) => A,
  server: string,
  ref: ResourceRef,
  why: string,
): FailedResource => {
  const known: Known = { redact, server, ref };
  const error = lineOf(redact, why, MAX_RESOURCE_ERROR);
  const chip = { ...chipOf(known), kind: ATTACHED_KIND.error, error };

  return {
    element: resourceElement({
      server: normalizeMcpName(server),
      uri: chip.uri,
      error,
    }),
    chip,
  };
};

/** What one content of a resource became: its element, how it went in, its size, and the file or picture it made. */
type Kept = {
  readonly element: string;
  readonly kind: string;
  readonly bytes: number;
  readonly mimeType: string | undefined;
  readonly path?: string;
  readonly image?: PromptImage;
};

/** `content` made into its element: inline text, an inline image, or a file `save` writes. Takes its room from `budgets`. */
const keepContent = async (
  input: {
    readonly redact: <A>(value: A) => A;
    readonly server: string;
    readonly budgets: AttachedBudgets;
    readonly save: (file: PromptFile) => Promise<string>;
  },
  content: AttachedContent,
): Promise<Kept> => {
  const { redact, budgets } = input;
  const uri = lineOf(redact, content.uri, MAX_RESOURCE_URI);

  const mimeType =
    content.mimeType === undefined ? undefined : lineOf(redact, content.mimeType, 100);

  const facts = { server: input.server, uri, mimeType };

  if (content.text !== undefined) {
    const text = redact(cleanText(content.text));
    const bytes = encoder.encode(text).byteLength;

    if (bytes <= MAX_RESOURCE_INLINE_TEXT_BYTES && bytes <= budgets.text) {
      budgets.text -= bytes;

      return {
        element: resourceElement({ ...facts, text }),
        kind: ATTACHED_KIND.text,
        bytes,
        mimeType,
      };
    }

    const path = await input.save({
      kind: "resource",
      mimeType: content.mimeType,
      bytes: encoder.encode(text),
    });

    return {
      element: resourceElement({ ...facts, path }),
      kind: ATTACHED_KIND.spill,
      bytes,
      mimeType,
      path,
    };
  }

  const blob = content.blob ?? "";
  const bytes = base64Bytes(blob);

  if (
    content.mimeType !== undefined &&
    isInlineImageType(content.mimeType) &&
    blob.length <= budgets.images
  ) {
    budgets.images -= blob.length;

    return {
      element: resourceElement({ ...facts, image: true }),
      kind: ATTACHED_KIND.image,
      bytes,
      mimeType,
      image: { type: "image", data: blob, mimeType: content.mimeType },
    };
  }

  const decoded = decodeBase64(blob);

  if (decoded === undefined) throw new Error("The server's blob is not base64");

  const path = await input.save({ kind: "resource", mimeType: content.mimeType, bytes: decoded });

  return {
    element: resourceElement({ ...facts, path }),
    kind: ATTACHED_KIND.spill,
    bytes,
    mimeType,
    path,
  };
};

/**
 * The elements, images and chip of `ref`'s `contents`, as the server returned them. A text that fits the message's room
 * (`MAX_RESOURCE_INLINE_TEXT_BYTES` and what is left of the message's `budgets.text`) goes between the tags; any other text,
 * and a blob that is not an image the providers take or does not fit the image budget, goes to a file `save` writes, which
 * the element names by its `path`. The chip takes the first content's kind, type and path, the sizes together, and how many
 * images went inline. Rejects when a file cannot be written.
 */
export const attachedResource = async (input: {
  readonly redact: <A>(value: A) => A;
  readonly server: string;
  readonly ref: ResourceRef;
  readonly contents: ReadonlyArray<AttachedContent>;
  readonly budgets: AttachedBudgets;
  readonly save: (file: PromptFile) => Promise<string>;
}): Promise<AttachedMade> => {
  const known: Known = { redact: input.redact, server: input.server, ref: input.ref };
  const server = normalizeMcpName(input.server);
  const kept: Array<Kept> = [];

  // One after another: each takes its room from the budgets the next one sees.
  for (const content of input.contents) {
    kept.push(await keepContent({ ...input, server }, content));
  }

  const chip = chipOf(known);
  const [first] = kept;

  if (first !== undefined) {
    chip.kind = first.kind;

    if (first.mimeType !== undefined) chip.mimeType = first.mimeType;

    if (first.path !== undefined) chip.path = first.path;
  }

  chip.size = Arr.reduce(kept, 0, (sum, each) => sum + each.bytes);

  const images = Arr.flatMap(kept, ({ image }) => (image === undefined ? [] : [image]));

  if (images.length > 0) chip.images = images.length;

  return { elements: Arr.map(kept, ({ element }) => element), images, chip };
};

/** What Attached resources add to a message: the block (one text part) and the images after it, and the chips. */
export type AttachedMessage = {
  /** The `<mcp_resources>` block; empty when there is none. */
  readonly block: string;
  readonly images: ReadonlyArray<PromptImage>;
  readonly chips: ReadonlyArray<AttachedResource>;
};

/** The block, images and chips of every resource of a message, in the order the owner attached them. */
export const attachedMessage = (made: ReadonlyArray<AttachedMade>): AttachedMessage => ({
  block: resourcesBlock(Arr.flatMap(made, ({ elements }) => elements)),
  images: Arr.flatMap(made, ({ images }) => images),
  chips: Arr.map(made, ({ chip }) => chip),
});
