// An MCP prompt's result as the owner's one message (`docs/architecture/mcp-in-a-session.md` → Into the conversation,
// ADR-0033): its `<mcp_prompt>` block, its images, and what the entry keeps for the transcript, as a function over the
// result `prompts/get` answered. Nothing here reads a server or the Workspace: `save` writes a file, and what to do with
// a refusal is the caller's.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- the Workspace's file writes are Promise-native, and the walk is over short lists of JSON.
import { normalizeMcpName } from "@cloudpid/config";
import { isJsonObject, type JsonObject, jsonListOf, present } from "@cloudpid/mcp/types";
import {
  boundedText,
  cleanText,
  escapePageText,
  isInlineImageType,
  MAX_MCP_PROMPT_RESOURCES,
  MAX_MCP_PROMPT_RESULT_DESCRIPTION,
  type McpPromptErrorCode,
  type McpPromptPart,
  type McpPromptResource,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const encoder = new TextEncoder();

const bytesOf = (text: string): number => encoder.encode(text).byteLength;

/** What the block and the typed text may weigh together, in UTF-8 bytes: 1 MiB. */
export const MAX_MCP_PROMPT_BLOCK_BYTES = 1024 * 1024;

/**
 * The most an embedded text resource keeps in the block: more goes to a file, and the block names its path. Until
 * Attached resources have a guard of their own (`docs/architecture/mcp-in-a-session.md` → Attached resources), the two
 * share this one.
 */
export const MAX_MCP_PROMPT_INLINE_TEXT_BYTES = 128 * 1024;

/** The URIs a prompt's resource references keep, in characters. */
const MAX_URI = 2048;

/** The extension a file of each MIME type the Session knows is kept under; any other is `.bin`. */
const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/wav": ".wav",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
  "application/pdf": ".pdf",
};

/** The name a prompt's `file` is kept under in the Session's uploads directory, made unique by `id`. */
export const promptFileName = (
  file: { readonly kind: string; readonly mimeType: string | undefined },
  id: string,
): string =>
  `mcp-${file.kind}-${id}${Option.getOrElse(Record.get(FILE_EXTENSIONS, (file.mimeType ?? "").toLowerCase()), () => ".bin")}`;

/** Why a prompt cannot be got or made a message, before it is a `SessionError` that names the server. */
export type PromptRefusal = {
  readonly code: McpPromptErrorCode;
  readonly message: string;
};

/** A file the result's content must go to: the Workspace keeps it, and the block names its path. */
export type PromptFile = {
  readonly kind: "image" | "audio" | "resource";
  readonly mimeType: string | undefined;
  readonly bytes: Uint8Array;
};

/** An image that goes inline, as pi-ai's user content has it. */
export type PromptImage = {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
};

/** What one prompt result is made into. */
export type PromptMessage = {
  /** The `<mcp_prompt …>` block. */
  readonly block: string;
  /** The images that go inline, in order, after the block. */
  readonly images: ReadonlyArray<PromptImage>;
  /** What the entry keeps, besides what the caller knows of the pick. */
  readonly description: string | undefined;
  readonly parts: ReadonlyArray<McpPromptPart>;
  readonly resources: ReadonlyArray<McpPromptResource>;
};

/** What a prompt result is made into, with what the caller knows of the pick, the owner's typed text and image budget. */
export type PromptInput = {
  /** The server's configured name. */
  readonly server: string;
  /** The prompt's own name. */
  readonly name: string;
  readonly title: string | undefined;
  /** The result, as the server sent it. */
  readonly result: Schema.Json;
  /** What the owner typed beside it, which counts toward the block's bound. */
  readonly typed: string;
  /** How many base64 characters of inline images the owner's own images left. */
  readonly imageBudget: number;
  /** Redacts Secrets from text, as the rest of the message's text is. */
  readonly redact: <A>(value: A) => A;
  /** Writes a file the result's content goes to, answering its path in the Workspace; it rejects when it cannot. */
  readonly save: (file: PromptFile) => Promise<string>;
};

/** One content block of the result's messages, and whose message it was in. */
type Item = { readonly role: "user" | "assistant"; readonly content: JsonObject };

const refusal = (message: string): PromptRefusal => ({ code: "MCP_PROMPT_FAILED", message });

/** A result that is not a prompt. */
const malformed = (why: string) => Result.fail(refusal(`The server's prompt is malformed: ${why}`));

/** The content blocks of the result's messages, in order; or why the result is not a prompt. */
const itemsOf = (result: Schema.Json): Result.Result<ReadonlyArray<Item>, PromptRefusal> => {
  if (!isJsonObject(result)) return malformed("it is not an object");

  const messages = result["messages"];

  if (!Arr.isArray(messages)) return malformed("it has no messages");

  const items: Array<Item> = [];

  for (const message of jsonListOf(messages)) {
    if (!isJsonObject(message)) return malformed("a message is not an object");

    const { role, content } = message;

    if (role !== "user" && role !== "assistant") return malformed("a message has no role");

    // The spec's content is one block; a list of blocks is read the same way.
    for (const block of Arr.isArray(content) ? jsonListOf(content) : [content]) {
      if (!isJsonObject(block)) return malformed("a message has no content");

      items.push({ role, content: block });
    }
  }

  return Result.succeed(items);
};

/** The tags a prompt's own text must not close or open: the message's own blocks. */
const STRUCTURAL = /<(\/?)(mcp_prompt|prompt_message|mcp_resources|resource)(?=[\s>/])/giu;

/** `text` cleaned, redacted, then with the tags that would close or open the message's blocks defanged. */
const proseOf = (input: PromptInput, text: string): string =>
  input.redact(cleanText(text)).replace(STRUCTURAL, "&lt;$1$2");

/** An attribute value, or text on one line, cleaned, redacted and escaped. */
const attribute = (input: PromptInput, value: string): string =>
  escapePageText(input.redact(cleanText(value)).replaceAll(/\s+/gu, " "));

const base64Bytes = (data: string): number => {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;

  return Math.floor((data.length * 3) / 4) - padding;
};

/** `data`, base64, as bytes, or nothing when it is not base64. */
const decodeBase64 = (data: string): Uint8Array | undefined => {
  try {
    return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
};

const sizeWord = (bytes: number): string =>
  bytes < 1024 ? `${String(bytes)} B` : `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;

/** `(mime, size)` as a file's line says it. */
const fileFacts = (mimeType: string | undefined, bytes: number): string =>
  mimeType === undefined ? `(${sizeWord(bytes)})` : `(${mimeType}, ${sizeWord(bytes)})`;

const asString = (value: Schema.Json | undefined): string | undefined =>
  Predicate.isString(value) ? value : undefined;

/** What one content block became: its text in the block, the part and resource it keeps. */
type Made = {
  readonly line: string;
  readonly part: McpPromptPart;
  readonly resource?: McpPromptResource;
  /** The inline image it adds, after the block. */
  readonly image?: PromptImage;
};

/** Where the images and files of one result stand while its blocks are made. */
type Walk = {
  readonly input: PromptInput;
  images: number;
  budget: number;
};

/** The files the Workspace keeps: written, or why not. */
const saved = async (
  input: PromptInput,
  file: PromptFile,
): Promise<Result.Result<string, PromptRefusal>> => {
  try {
    return Result.succeed(await input.save(file));
  } catch {
    return Result.fail(refusal("The prompt's content could not be saved to the Workspace"));
  }
};

/** The result of making one content block. */
type Making = Result.Result<Made, PromptRefusal>;

/**
 * Counts an image of the result and, when it is a type the providers take and fits what the budget has left, takes its
 * room: the image to send inline. Undefined for one that goes to a file.
 */
const takeInline = (walk: Walk, data: string, mimeType: string): PromptImage | undefined => {
  walk.images += 1;

  if (!isInlineImageType(mimeType) || data.length > walk.budget) return undefined;

  walk.budget -= data.length;

  return { type: "image", data, mimeType };
};

/** A text block. */
const textBlock = (walk: Walk, role: Item["role"], content: JsonObject): Making => {
  const text = asString(content["text"]);

  if (text === undefined) return malformed("a text has no text");

  const line = proseOf(walk.input, text);

  return Result.succeed({ line, part: { role, type: "text", bytes: bytesOf(line) } });
};

/** An image or an audio block: an image within the budget goes inline, anything else to a file. */
const mediaBlock = async (
  walk: Walk,
  role: Item["role"],
  type: "image" | "audio",
  content: JsonObject,
): Promise<Making> => {
  const data = asString(content["data"]);
  const mimeType = asString(content["mimeType"]);

  if (data === undefined || mimeType === undefined) return malformed(`${type} has no data`);

  const size = base64Bytes(data);

  const image = type === "image" ? takeInline(walk, data, mimeType) : undefined;

  if (image !== undefined) {
    return Result.succeed({
      line: `[image ${String(walk.images)}]`,
      part: { role, type, mimeType, bytes: size },
      image,
    });
  }

  const bytes = decodeBase64(data);

  if (bytes === undefined) return malformed(`${type} is not base64`);

  const path = await saved(walk.input, { kind: type, mimeType, bytes });

  if (Result.isFailure(path)) return Result.fail(path.failure);

  const line =
    type === "image"
      ? `[image ${String(walk.images)}: ${path.success} ${fileFacts(mimeType, size)}]`
      : `[audio: ${path.success} ${fileFacts(mimeType, size)}]`;

  return Result.succeed({
    line,
    part: { role, type, mimeType, bytes: size, path: path.success },
    resource: { uri: path.success, mimeType, size, kind: "spill", path: path.success },
  });
};

/** A `resource_link`: pi's line for it, with no read clause (the resource tools do not reach a server's resources yet). */
const linkBlock = (walk: Walk, role: Item["role"], content: JsonObject): Making => {
  const uri = asString(content["uri"]);

  if (uri === undefined) return malformed("a resource link has no uri");

  const title = asString(content["title"]) ?? asString(content["name"]);
  const mimeType = asString(content["mimeType"]);
  const size = Predicate.isNumber(content["size"]) ? Math.trunc(content["size"]) : undefined;
  const described = asString(content["description"]);

  const facts = Arr.filter(
    [mimeType, size === undefined ? undefined : sizeWord(size)],
    Predicate.isNotUndefined,
  );

  const label = title === undefined ? "" : ` "${title}"`;
  const inParens = facts.length === 0 ? "" : ` (${Arr.join(facts, ", ")})`;
  const why = described === undefined ? "" : `: ${described}`;
  const shown = boundedText(uri, MAX_URI);

  return Result.succeed({
    line: proseOf(walk.input, `[Resource ${uri}${label}${inParens}${why}]`),
    part: { role, type: "resource_link", ...present({ uri: shown, mimeType }) },
    resource: { uri: shown, kind: "link", ...present({ mimeType, size }) },
  });
};

/** An embedded resource: text in an untrusted `<mcp_resources>` block, in place; an image inline; the rest in a file. */
const embeddedBlock = async (
  walk: Walk,
  role: Item["role"],
  content: JsonObject,
): Promise<Making> => {
  const { input } = walk;
  const embedded = content["resource"];

  if (!isJsonObject(embedded)) return malformed("an embedded resource has none");

  const uri = asString(embedded["uri"]);
  const mimeType = asString(embedded["mimeType"]);

  if (uri === undefined) return malformed("an embedded resource has no uri");

  const text = asString(embedded["text"]);
  const blob = asString(embedded["blob"]);
  const shown = boundedText(uri, MAX_URI);
  const mime = mimeType === undefined ? "" : ` mime_type="${attribute(input, mimeType)}"`;
  const where = `server="${attribute(input, normalizeMcpName(input.server))}" uri="${attribute(input, shown)}"${mime}`;

  const filed = (path: string, size: number): Making =>
    Result.succeed({
      line: `<mcp_resources>\n<resource ${where} path="${attribute(input, path)}"/>\n</mcp_resources>`,
      part: { role, type: "resource", uri: shown, bytes: size, path, ...present({ mimeType }) },
      resource: { uri: shown, size, kind: "spill", path, ...present({ mimeType }) },
    });

  if (text !== undefined) {
    const cleaned = input.redact(cleanText(text));
    const size = bytesOf(cleaned);

    if (size <= MAX_MCP_PROMPT_INLINE_TEXT_BYTES) {
      return Result.succeed({
        line: `<mcp_resources>\n<resource ${where}>${escapePageText(cleaned)}</resource>\n</mcp_resources>`,
        part: { role, type: "resource", uri: shown, bytes: size, ...present({ mimeType }) },
        resource: { uri: shown, size, kind: "text", ...present({ mimeType }) },
      });
    }

    const path = await saved(input, { kind: "resource", mimeType, bytes: encoder.encode(cleaned) });

    return Result.isFailure(path) ? Result.fail(path.failure) : filed(path.success, size);
  }

  if (blob === undefined) return malformed("an embedded resource has no content");

  const size = base64Bytes(blob);

  const image =
    mimeType !== undefined && isInlineImageType(mimeType)
      ? takeInline(walk, blob, mimeType)
      : undefined;

  if (image !== undefined) {
    return Result.succeed({
      line: `[image ${String(walk.images)}]`,
      part: { role, type: "image", mimeType: image.mimeType, bytes: size, uri: shown },
      resource: { uri: shown, mimeType: image.mimeType, size, kind: "image" },
      image,
    });
  }

  const bytes = decodeBase64(blob);

  if (bytes === undefined) return malformed("an embedded blob is not base64");

  const path = await saved(input, { kind: "resource", mimeType, bytes });

  return Result.isFailure(path) ? Result.fail(path.failure) : filed(path.success, size);
};

/** One content block as the block and the entry have it; nothing for a kind this build does not know. */
const madeOf = (walk: Walk, { role, content }: Item): Promise<Making | undefined> => {
  switch (asString(content["type"])) {
    case "text":
      return Promise.resolve(textBlock(walk, role, content));
    case "image":
      return mediaBlock(walk, role, "image", content);
    case "audio":
      return mediaBlock(walk, role, "audio", content);
    case "resource_link":
      return Promise.resolve(linkBlock(walk, role, content));
    case "resource":
      return embeddedBlock(walk, role, content);
    default:
      // Content this build does not know is left out, never guessed at.
      return Promise.resolve(undefined);
  }
};

/**
 * The owner's message from a prompt's result: the `<mcp_prompt server name title>` block, which holds the user
 * messages' text and the assistant ones as `<prompt_message role="assistant">`, in the order they came, joined by blank
 * lines, with `[image n]` markers; the images within the budget as parts of their own; and what is too much for the block
 * (images past the budget, audio, a large or binary embedded resource) in files the caller's `save` writes. A result
 * that is not a prompt, a file that cannot be written, or a block over its bound is refused.
 */
export const promptMessage = async (
  input: PromptInput,
): Promise<Result.Result<PromptMessage, PromptRefusal>> => {
  const read = itemsOf(input.result);

  if (Result.isFailure(read)) return Result.fail(read.failure);

  const items = read.success;

  const walk: Walk = { input, images: 0, budget: input.imageBudget };
  const segments: Array<string> = [];
  const images: Array<PromptImage> = [];
  const parts: Array<McpPromptPart> = [];
  const resources: Array<McpPromptResource> = [];

  for (const item of items) {
    const made = await madeOf(walk, item);

    if (made === undefined) continue;

    if (Result.isFailure(made)) return Result.fail(made.failure);

    const { line, part, resource, image } = made.success;

    segments.push(
      item.role === "assistant"
        ? `<prompt_message role="assistant">\n${line}\n</prompt_message>`
        : line,
    );
    parts.push(part);

    if (resource !== undefined && resources.length < MAX_MCP_PROMPT_RESOURCES) {
      resources.push(resource);
    }

    if (image !== undefined) images.push(image);
  }

  const title = input.title === undefined ? "" : ` title="${attribute(input, input.title)}"`;
  const server = attribute(input, normalizeMcpName(input.server));
  const open = `<mcp_prompt server="${server}" name="${attribute(input, input.name)}"${title}>`;
  const block = `${open}\n${Arr.join(segments, "\n\n")}\n</mcp_prompt>`;

  if (bytesOf(block) + bytesOf(input.typed) > MAX_MCP_PROMPT_BLOCK_BYTES) {
    return Result.fail({
      code: "MCP_PROMPT_TOO_LARGE",
      message: "The prompt is too large to send: its text and yours are over 1 MiB",
    });
  }

  const described = isJsonObject(input.result) ? asString(input.result["description"]) : undefined;

  // Never sent to the model: the owner's disclosure shows it.
  const description =
    described === undefined || described.trim() === ""
      ? undefined
      : input.redact(boundedText(described, MAX_MCP_PROMPT_RESULT_DESCRIPTION));

  return Result.succeed({ block, images, description, parts, resources });
};
