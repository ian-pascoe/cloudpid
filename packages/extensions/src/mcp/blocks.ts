// What the model gets for the content blocks of a `tools/call` result (`docs/architecture/mcp-in-a-session.md` → Calls
// and results): text, images, a line for a block it cannot be shown, and a Result Spill for binary data.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- conversions of plain values.
import { isJsonObject } from "@cloudpid/mcp/types";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Spill } from "./spill.ts";

/** A content block of a `tools/call` result of a type this build knows, as far as the Session reads it. */
export const ContentBlock = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: Schema.String }),
  Schema.Struct({ type: Schema.Literal("audio"), mimeType: Schema.optionalKey(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("resource_link"),
    uri: Schema.String,
    name: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
    description: Schema.optionalKey(Schema.String),
    mimeType: Schema.optionalKey(Schema.String),
    size: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    resource: Schema.Union([
      Schema.Struct({
        uri: Schema.String,
        mimeType: Schema.optionalKey(Schema.String),
        text: Schema.String,
      }),
      Schema.Struct({
        uri: Schema.String,
        mimeType: Schema.optionalKey(Schema.String),
        blob: Schema.String,
      }),
    ]),
  }),
]);

export type ContentBlock = typeof ContentBlock.Type;

const decodeBlock = Schema.decodeUnknownOption(ContentBlock);

/** What the model is given of a result: text and images. */
export type ModelContent = TextContent | ImageContent;

/** The image types every provider takes; any other image is saved to a file instead. */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The longest a field of a line the model reads is, so a server's text never fills the context through one. */
const URI_LIMIT = 2048;

const FIELD_LIMIT = 500;

/** `text` on one line, cut to `limit` characters. */
const oneLine = (text: string, limit: number): string => {
  const line = text.replaceAll(/\s+/g, " ").trim();

  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

const textOf = (text: string): TextContent => ({ type: "text", text });

/** `bytes` as a size: `512B`, `3.4KB`, `1.5MB`. */
const sizeOf = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;

  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)}KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

/** `base64`'s bytes; it throws for text that is not base64. */
const bytesOf = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  return bytes;
};

/** The extension a saved file gets: the one `uri`'s path ends in, else `.bin`. */
const suffixOf = (uri: string | undefined): string =>
  (uri === undefined ? undefined : /\.[A-Za-z0-9]{1,8}$/.exec(uri.split(/[?#]/)[0] ?? "")?.[0]) ??
  ".bin";

/** The type of a media type: `image/png; charset=x` is `image/png`. */
const typeOf = (mimeType: string): string => (mimeType.split(";")[0] ?? "").trim().toLowerCase();

/** Binary data saved to a file, and the line that says where: a Result Spill. */
const saved = async (
  what: string,
  uri: string | undefined,
  mimeType: string | undefined,
  base64: string,
  spill: Spill,
): Promise<TextContent> => {
  const label = `${what}${uri === undefined ? "" : ` ${oneLine(uri, URI_LIMIT)}`} (${oneLine(mimeType ?? "unknown type", FIELD_LIMIT)}`;

  let bytes: Uint8Array;

  try {
    bytes = bytesOf(base64);
  } catch {
    return textOf(`[${label}) could not be read: its data is not base64]`);
  }

  const where = await spill(bytes, suffixOf(uri));

  return textOf(
    "path" in where
      ? `[${label}, ${sizeOf(bytes.length)}) saved to ${where.path}]`
      : `[${label}, ${sizeOf(bytes.length)}) could not be saved: ${where.reason}]`,
  );
};

/**
 * `[Resource <uri> "<title>" (<mimeType>, <size>): <description>]`, pi's line for a link. Its clause about reading it
 * with `read_mcp_resource` comes with the resource tools (#471), which a server's link names only when they reach it.
 */
const linkLine = (block: Extract<ContentBlock, { type: "resource_link" }>): string => {
  const title = oneLine(block.title ?? block.name ?? block.uri, FIELD_LIMIT);

  const facts = Arr.join(
    [
      ...(block.mimeType === undefined ? [] : [oneLine(block.mimeType, FIELD_LIMIT)]),
      ...(block.size === undefined ? [] : [sizeOf(block.size)]),
    ],
    ", ",
  );

  const description =
    block.description === undefined ? "" : `: ${oneLine(block.description, FIELD_LIMIT)}`;

  return `[Resource ${oneLine(block.uri, URI_LIMIT)} "${title}"${facts === "" ? "" : ` (${facts})`}${description}]`;
};

/** The type a block of a kind this build does not know says it is. */
const kindOf = (raw: Schema.Json): string =>
  isJsonObject(raw) && Predicate.isString(raw["type"]) ? raw["type"] : "unknown";

/** One block as the model gets it. */
const blockFor = async (raw: Schema.Json, spill: Spill): Promise<ReadonlyArray<ModelContent>> => {
  const decoded = decodeBlock(raw);

  // A block of a type this build does not know, or one that is malformed, is a line.
  if (Option.isNone(decoded)) return [textOf(`[${oneLine(kindOf(raw), 64)} content omitted]`)];

  const block = decoded.value;

  switch (block.type) {
    case "text":
      return [textOf(block.text)];
    case "image":
      return IMAGE_TYPES.has(typeOf(block.mimeType))
        ? [{ type: "image", data: block.data, mimeType: block.mimeType }]
        : [await saved("Image", undefined, block.mimeType, block.data, spill)];
    case "audio":
      return [
        textOf(
          block.mimeType === undefined
            ? "[audio content omitted]"
            : `[audio content (${oneLine(block.mimeType, FIELD_LIMIT)}) omitted]`,
        ),
      ];
    case "resource_link":
      return [textOf(linkLine(block))];
    case "resource": {
      const { resource } = block;

      if ("text" in resource) return [textOf(resource.text)];

      return IMAGE_TYPES.has(typeOf(resource.mimeType ?? ""))
        ? [{ type: "image", data: resource.blob, mimeType: resource.mimeType ?? "image/png" }]
        : [await saved("Binary resource", resource.uri, resource.mimeType, resource.blob, spill)];
    }
  }
};

/** What the model gets for `blocks`, in order. */
export const modelContent = async (
  blocks: ReadonlyArray<Schema.Json>,
  spill: Spill,
): Promise<ReadonlyArray<ModelContent>> =>
  Arr.flatten(await Promise.all(Arr.map(blocks, (block) => blockFor(block, spill))));
