// What the model gets for the content blocks of a `tools/call` result and the contents of a resource read
// (`docs/architecture/mcp-in-a-session.md` → Calls and results, Resource links and embedded resources): text, images, a
// line for a block it cannot be shown, and a Result Spill for binary data. A link or an embedded resource also leaves a
// reference (`Piece.ref`), which `details.resources` keeps.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- conversions of plain values.
import { isJsonObject } from "@cloudpid/mcp/types";
import { utf8ByteLength } from "@earendil-works/chord/output";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { MAX_REF_URI, type McpResourceRef } from "./details.ts";
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

/**
 * One piece of what the model is given: a block of the server's own text or an image, or a `note`, a line this build
 * writes about a block it cannot show (a link, a placeholder, where a file was saved). Text over the limits is cut in
 * the server's text only; a note is never cut away.
 */
export type Piece = {
  readonly content: ModelContent;
  readonly note: boolean;
  /** The resource the piece is a link to or holds, when it is one. */
  readonly ref?: McpResourceRef;
};

/** What reading a block depends on besides the block. */
export type ModelOptions = {
  /**
   * The name the resource tools take for the server the blocks came from (`mcp__` left off), when they reach it: a link
   * then says how to read it. Absent when they do not, so the model is never pointed at a tool that cannot.
   */
  readonly readServer?: string | undefined;
};

/** The reference of a resource, none for a URI past `MAX_REF_URI`. */
export const refOf = (
  uri: string,
  kind: McpResourceRef["kind"],
  part: number,
  facts: {
    readonly mimeType?: string | undefined;
    readonly size?: number | undefined;
    readonly path?: string | undefined;
  } = {},
): McpResourceRef | undefined => {
  if (uri.length > MAX_REF_URI) return undefined;

  const ref: Mutable<McpResourceRef> = { uri, kind, part };

  if (facts.mimeType !== undefined) ref.mimeType = facts.mimeType;

  if (facts.size !== undefined) ref.size = facts.size;

  if (facts.path !== undefined) ref.path = facts.path;

  return ref;
};

/** `ref` as a piece's key, which is left off when there is none. */
const withRef = (piece: Piece, ref: McpResourceRef | undefined): Piece =>
  ref === undefined ? piece : { ...piece, ref };

const serverText = (text: string): Piece => ({ content: textOf(text), note: false });

const noteOf = (line: TextContent): Piece => ({ content: line, note: true });

/** How many bytes `base64` decodes to, without decoding it. */
export const base64Bytes = (base64: string): number => {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;

  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

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
export const oneLine = (text: string, limit: number): string => {
  const line = text.replaceAll(/\s+/g, " ").trim();

  return line.length > limit ? `${line.slice(0, limit)}…` : line;
};

export const textOf = (text: string): TextContent => ({ type: "text", text });

/** `bytes` as a size: `512B`, `3.4KB`, `1.5MB`. */
const sizeOf = (bytes: number): string => {
  if (bytes < 1024) return `${bytes}B`;

  return bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)}KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};

/** `base64`'s bytes; it throws for text that is not base64. */
export const bytesOf = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);

  return bytes;
};

/** The extension a saved file gets: the one `uri`'s path ends in, else `.bin`. */
export const suffixOf = (uri: string | undefined): string =>
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
): Promise<{ readonly line: TextContent; readonly path?: string; readonly size?: number }> => {
  const label = `${what}${uri === undefined ? "" : ` ${oneLine(uri, URI_LIMIT)}`} (${oneLine(mimeType ?? "unknown type", FIELD_LIMIT)}`;

  let bytes: Uint8Array;

  try {
    bytes = bytesOf(base64);
  } catch {
    return { line: textOf(`[${label}) could not be read: its data is not base64]`) };
  }

  const where = await spill(bytes, suffixOf(uri));

  return "path" in where
    ? {
        line: textOf(`[${label}, ${sizeOf(bytes.length)}) saved to ${where.path}]`),
        path: where.path,
        size: bytes.length,
      }
    : {
        line: textOf(`[${label}, ${sizeOf(bytes.length)}) could not be saved: ${where.reason}]`),
        size: bytes.length,
      };
};

/**
 * `[Resource <uri> "<title>" (<mimeType>, <size>): <description>. Read it with read_mcp_resource (server "<name>")]`,
 * pi's line for a link, with its clause about reading it only when the resource tools reach the server (`readServer`).
 */
const linkLine = (
  block: Extract<ContentBlock, { type: "resource_link" }>,
  readServer: string | undefined,
): string => {
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

  const how =
    readServer === undefined
      ? ""
      : `. Read it with read_mcp_resource (server "${oneLine(readServer, FIELD_LIMIT)}")`;

  return `[Resource ${oneLine(block.uri, URI_LIMIT)} "${title}"${facts === "" ? "" : ` (${facts})`}${description}${how}]`;
};

/** The type a block of a kind this build does not know says it is. */
const kindOf = (raw: Schema.Json): string =>
  isJsonObject(raw) && Predicate.isString(raw["type"]) ? raw["type"] : "unknown";

/** One block as the model gets it. */
const blockFor = async (
  raw: Schema.Json,
  spill: Spill,
  options: ModelOptions,
  part: number,
): Promise<ReadonlyArray<Piece>> => {
  const decoded = decodeBlock(raw);

  // A block of a type this build does not know, or one that is malformed, is a line.
  if (Option.isNone(decoded)) {
    return [noteOf(textOf(`[${oneLine(kindOf(raw), 64)} content omitted]`))];
  }

  const block = decoded.value;

  switch (block.type) {
    case "text":
      return [serverText(block.text)];
    case "image":
      return IMAGE_TYPES.has(typeOf(block.mimeType))
        ? [{ content: { type: "image", data: block.data, mimeType: block.mimeType }, note: false }]
        : [noteOf((await saved("Image", undefined, block.mimeType, block.data, spill)).line)];
    case "audio":
      return [
        noteOf(
          textOf(
            block.mimeType === undefined
              ? "[audio content omitted]"
              : `[audio content (${oneLine(block.mimeType, FIELD_LIMIT)}) omitted]`,
          ),
        ),
      ];
    case "resource_link":
      return [
        withRef(
          noteOf(textOf(linkLine(block, options.readServer))),
          refOf(block.uri, "link", part, { mimeType: block.mimeType, size: block.size }),
        ),
      ];
    case "resource": {
      const { resource } = block;

      if ("text" in resource) {
        return [
          withRef(
            serverText(resource.text),
            refOf(resource.uri, "text", part, {
              mimeType: resource.mimeType,
              size: utf8ByteLength(resource.text),
            }),
          ),
        ];
      }

      if (IMAGE_TYPES.has(typeOf(resource.mimeType ?? ""))) {
        return [
          withRef(
            {
              content: {
                type: "image",
                data: resource.blob,
                mimeType: resource.mimeType ?? "image/png",
              },
              note: false,
            },
            refOf(resource.uri, "image", part, {
              mimeType: resource.mimeType,
              size: base64Bytes(resource.blob),
            }),
          ),
        ];
      }

      const where = await saved(
        "Binary resource",
        resource.uri,
        resource.mimeType,
        resource.blob,
        spill,
      );

      return [
        withRef(
          noteOf(where.line),
          refOf(resource.uri, "spill", part, {
            mimeType: resource.mimeType,
            size: where.size,
            path: where.path,
          }),
        ),
      ];
    }
  }
};

/** What the model gets for each of `blocks`, in order: the pieces of each block, whose references name its index as `part`. */
export const modelBlocks = (
  blocks: ReadonlyArray<Schema.Json>,
  spill: Spill,
  options: ModelOptions = {},
): Promise<ReadonlyArray<ReadonlyArray<Piece>>> =>
  Promise.all(Arr.map(blocks, (block, index) => blockFor(block, spill, options, index)));

/** What the model gets for `blocks`, in order. */
export const modelContent = async (
  blocks: ReadonlyArray<Schema.Json>,
  spill: Spill,
  options: ModelOptions = {},
): Promise<ReadonlyArray<Piece>> => Arr.flatten(await modelBlocks(blocks, spill, options));
