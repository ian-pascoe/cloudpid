// What an MCP tool call's card shows of the resources its result names or holds (`docs/architecture/mcp-in-a-session.md` →
// Resource links and embedded resources): one chip for each reference in the call's `details.resources`, and what a preview
// of it shows. This file is the model, with no React: which references there are, what the transcript already holds of
// each (an embedded text or image, which a preview renders from, with no read at all), what kind of preview a payload gets,
// and the safe names a download is given.
//
// What a preview may draw is narrow, since the bytes are a server's: Markdown is drawn without raw HTML (`mcp-resource-view.tsx`),
// any other text (HTML included) as escaped source, an image only from a `data:` URL this file builds from an allowed
// image type and base64 it has checked (never a URL the resource names), and anything else is a download, saved under a
// filename and content type this file chooses.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over small native arrays and strings.
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import {
  base64Bytes,
  bytesFromBase64,
  isBase64,
  McpResourceReason,
  type McpResourcePreviewAnswer,
  type TranscriptPart,
} from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** One reference of a call's `details.resources`, as this reads it: a kind this build does not know reads as a link. */
const ShownRef = Schema.Struct({
  uri: Schema.String,
  kind: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Finite),
  path: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.Finite),
});

const decodeDetails = Schema.decodeUnknownOption(
  Schema.Struct({ server: Schema.String, resources: Schema.Array(Schema.Unknown) }),
);

const decodeRef = Schema.decodeUnknownOption(ShownRef);

/** What the transcript holds of a resource's own data: a text, or a base64 blob and its type. */
export type Held =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "blob"; readonly base64: string; readonly mimeType: string };

/** A resource a card draws a chip for. */
export type ShownResource = {
  readonly server: string;
  readonly uri: string;
  readonly mimeType?: string | undefined;
  readonly size?: number | undefined;
  /** `text`, `image` or `spill` (an embedded resource), or `link` (one the server pointed to, and sent no data for). */
  readonly kind: "text" | "image" | "spill" | "link";
  /** Where a `spill` was saved in the Workspace: its preview is read from there, and by `uri` once cleanup removed the file. */
  readonly path?: string | undefined;
  /** The data the transcript holds of it, when it holds any: a preview then needs no read. */
  readonly held?: Held | undefined;
};

type Content = Extract<TranscriptPart, { type: "tool-result" }>["content"];

/** The kind a reference says, or a link for one this build does not know. */
const kindOf = (kind: string): ShownResource["kind"] =>
  kind === "text" || kind === "image" || kind === "spill" ? kind : "link";

/**
 * The resources of a tool result's `details` (a result without any has none), each with what the result's `content` holds
 * of it: an embedded text or image sits at the index `at` of the content. A `ui://` resource is an App's, which the card
 * draws as a View (`docs/architecture/mcp-apps.md`), so it gets no chip.
 */
export const resourcesOf = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
  content: Content,
): ReadonlyArray<ShownResource> => {
  const found = decodeDetails(details);

  if (Option.isNone(found)) return [];

  const shown: ShownResource[] = [];

  for (const raw of found.value.resources) {
    const decoded = decodeRef(raw);

    if (Option.isNone(decoded) || decoded.value.uri.startsWith("ui://")) continue;

    const ref = decoded.value;
    const kind = kindOf(ref.kind);
    const block = ref.at === undefined ? undefined : content[ref.at];

    let held: Held | undefined;

    if (kind === "text" && block?.type === "text") held = { kind: "text", text: block.text };
    else if (kind === "image" && block?.type === "image") {
      held = { kind: "blob", base64: block.data, mimeType: block.mimeType };
    }

    shown.push({
      server: found.value.server,
      uri: ref.uri,
      mimeType: ref.mimeType,
      size: ref.size,
      kind,
      path: ref.path,
      held,
    });
  }

  return shown;
};

/** The type of a media type: `Image/PNG; charset=x` is `image/png`. */
export const typeOf = (mimeType: string | undefined): string =>
  (mimeType?.split(";")[0] ?? "").trim().toLowerCase();

/** The image types a preview shows (the ones the Session passes on to the model): not an SVG, which is a document with scripts. */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The longest text a preview draws, in characters; a download has all of it. */
export const MAX_PREVIEW_CHARS = 100_000;

/** The path of `uri` without its query and fragment, or `uri` as it is when it is no URL. */
const pathOf = (uri: string): string => uri.split(/[?#]/)[0] ?? "";

const MARKDOWN_TYPES: ReadonlySet<string> = new Set(["text/markdown", "text/x-markdown"]);

/** Whether a text is Markdown: its type says so, or it says nothing better (`text/plain` or none) and its path ends `.md`. */
export const isMarkdown = (mimeType: string | undefined, uri: string): boolean => {
  const type = typeOf(mimeType);

  if (MARKDOWN_TYPES.has(type)) return true;

  return (type === "" || type === "text/plain") && /\.(md|markdown)$/i.test(pathOf(uri));
};

/** Whether a media type is text a preview may decode from a blob: `text/*`, JSON and XML and what ends in them. */
const isTextType = (type: string): boolean =>
  type.startsWith("text/") ||
  type === "application/json" ||
  type === "application/xml" ||
  type === "application/yaml" ||
  type === "application/x-yaml" ||
  type === "application/javascript" ||
  type.endsWith("+json") ||
  type.endsWith("+xml");

/**
 * The most a blob may weigh, decoded, to be drawn in the card: a preview is a look, and what is larger (up to the 16 MiB a
 * read carries) is a download only, since a card does not hold a megabyte of image or text in its page for it.
 */
export const MAX_PREVIEW_BYTES = 1024 * 1024;

/** What a preview shows. */
export type Preview =
  | { readonly kind: "markdown"; readonly text: string; readonly cut: boolean }
  | { readonly kind: "source"; readonly text: string; readonly cut: boolean }
  | { readonly kind: "image"; readonly src: string; readonly mimeType: string }
  /** Only the download: `type` for one the card does not draw, `size` for a blob over `MAX_PREVIEW_BYTES`. */
  | { readonly kind: "download"; readonly why: "type" | "size" };

/** `text` cut to what a preview draws. */
const shownText = (text: string): { readonly text: string; readonly cut: boolean } =>
  text.length > MAX_PREVIEW_CHARS
    ? { text: text.slice(0, MAX_PREVIEW_CHARS), cut: true }
    : { text, cut: false };

/** UTF-8 text of `bytes`, or undefined when they are not valid UTF-8. */
const decodedText = (bytes: Uint8Array<ArrayBuffer>): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * What a preview of `data` shows for a resource at `uri` of type `mimeType`. A text is Markdown (no raw HTML drawn) or
 * source (escaped, `text/html` too); a blob of an allowed image type is an image, of a text type is decoded as the source
 * it is, and any other, or one over `MAX_PREVIEW_BYTES`, is a download only.
 */
export const previewOf = (data: Held, mimeType: string | undefined, uri: string): Preview => {
  const type = typeOf(data.kind === "blob" && data.mimeType !== "" ? data.mimeType : mimeType);

  if (data.kind === "blob") {
    if (base64Bytes(data.base64) > MAX_PREVIEW_BYTES) return { kind: "download", why: "size" };

    if (!isBase64(data.base64)) return { kind: "download", why: "type" };

    if (IMAGE_TYPES.has(type)) {
      return { kind: "image", src: `data:${type};base64,${data.base64}`, mimeType: type };
    }
  }

  let text: string | undefined;

  if (data.kind === "text") text = data.text;
  else if (isTextType(type) || isMarkdown(type, uri)) {
    const bytes = isBase64(data.base64) ? bytesFromBase64(data.base64) : undefined;

    text = bytes === undefined ? undefined : decodedText(bytes);
  }

  if (text === undefined) return { kind: "download", why: "type" };

  return isMarkdown(type, uri)
    ? { kind: "markdown", ...shownText(text) }
    : { kind: "source", ...shownText(text) };
};

const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["text/markdown", ".md"],
  ["text/x-markdown", ".md"],
  ["text/plain", ".txt"],
  ["text/html", ".html"],
  ["text/csv", ".csv"],
  ["application/json", ".json"],
  ["application/pdf", ".pdf"],
  ["application/zip", ".zip"],
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
]);

const FILENAME_LIMIT = 80;

/**
 * The name a download is saved under: the last segment of the URI's path with anything but letters, digits, dots, dashes and
 * underscores made `_`, no leading dot (so never a hidden file or a path), at most 80 characters, and an extension from
 * the type when the name has none. `resource` when the URI names nothing.
 */
export const safeFilename = (uri: string, mimeType: string | undefined): string => {
  const last =
    pathOf(uri)
      .split("/")
      .findLast((part) => part !== "") ?? "";

  let decoded = last;

  try {
    decoded = decodeURIComponent(last);
  } catch {
    // A segment that is not valid percent-encoding is used as it is.
  }

  const cleaned = decoded
    .replaceAll(/[^A-Za-z0-9._-]+/g, "_")
    .replaceAll(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .slice(0, FILENAME_LIMIT);

  const name = cleaned === "" ? "resource" : cleaned;

  return /\.[A-Za-z0-9]{1,8}$/.test(name)
    ? name
    : `${name}${EXTENSIONS.get(typeOf(mimeType)) ?? ""}`;
};

const DOWNLOAD_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/pdf",
  "application/zip",
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/**
 * The content type a download is given: one this list names, any other text as `text/plain`, and everything else (HTML,
 * SVG, scripts, a type that is no type) `application/octet-stream`, so a saved file is never one the browser would run.
 */
export const safeContentType = (mimeType: string | undefined): string => {
  const type = typeOf(mimeType);

  if (DOWNLOAD_TYPES.has(type)) return type;

  return type.startsWith("text/") && type !== "text/html"
    ? "text/plain"
    : "application/octet-stream";
};

/** The bytes of what a download saves: a text as UTF-8, a blob decoded; undefined for base64 that is not. */
export const downloadBytes = (data: Held): Uint8Array<ArrayBuffer> | undefined =>
  data.kind === "text"
    ? new TextEncoder().encode(data.text)
    : isBase64(data.base64)
      ? bytesFromBase64(data.base64)
      : undefined;

/** Whether a preview of `resource` needs a read: the transcript holds none of its data. Never for one that holds it. */
export const needsRead = (resource: ShownResource): boolean => resource.held === undefined;

/** What a chip is called: the file name its URI ends in, or the URI. */
export const chipLabel = (uri: string): string => {
  const last = pathOf(uri)
    .split("/")
    .findLast((part) => part !== "");

  if (last === undefined) return uri.length > 40 ? `${uri.slice(0, 40)}…` : uri;

  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
};

/** The reason an unavailable answer gives, or `failed` for one this build does not know: its `message` then says it. */
const reasonOf = (reason: string): McpResourceReason =>
  Schema.is(McpResourceReason)(reason) ? reason : "failed";

/** What `reason` of an unavailable preview says in the card's words, the Session's `message` for the rest. */
export const unavailableNote = (reason: McpResourceReason, message: string): string => {
  switch (reason) {
    case "stopped":
      return "No live preview: this server runs in a Container that is not running, and opening a preview never starts it. Ask the agent to read the resource.";
    case "input_required":
      return "No preview: the server asks a question before it gives this resource. Open it in a conversation.";
    case "host_unsupported":
      return "No live preview yet: this Session's MCP host is older than previews and cannot promise to leave the Container stopped.";
    case "session_unsupported":
      return "No live preview yet: this Session is older than previews and cannot read a resource for one.";
    case "too_large":
      return "No preview: the resource is larger than 16 MiB, more than a preview carries.";
    case "sign_in":
      return "No preview: the server needs you signed in. Sign in in Settings.";
    case "hidden":
    case "limit":
    case "cancelled":
    case "unavailable":
    case "failed":
      return message === ""
        ? "No preview: the resource could not be read."
        : `No preview: ${message}`;
  }
};

/** What a live read of a resource gave: the first item of its contents as data, or why there is none. */
export type Read =
  | { readonly status: "held"; readonly held: Held }
  | {
      readonly status: "unavailable";
      readonly reason: McpResourceReason;
      readonly message: string;
    };

/** The data a read's answer holds for `resource`, or why it holds none. A status this build does not know is unavailable. */
export const readOf = (
  answer: McpResourcePreviewAnswer,
  resource: Pick<ShownResource, "mimeType">,
): Read => {
  if (answer.status === "contents" && "contents" in answer) {
    const [item] = answer.contents;

    if (item?.text !== undefined)
      return { status: "held", held: { kind: "text", text: item.text } };

    if (item?.blob !== undefined) {
      return {
        status: "held",
        held: {
          kind: "blob",
          base64: item.blob,
          mimeType: item.mimeType ?? resource.mimeType ?? "",
        },
      };
    }

    return { status: "unavailable", reason: "failed", message: "The resource has no contents" };
  }

  if (answer.status === "unavailable" && "reason" in answer) {
    return { status: "unavailable", reason: reasonOf(answer.reason), message: answer.message };
  }

  return {
    status: "unavailable",
    reason: "failed",
    message: "message" in answer && answer.message !== undefined ? answer.message : "",
  };
};

const ShownResources = Schema.Struct({
  resources: Schema.Array(
    Schema.Struct({
      server: Schema.String,
      uri: Schema.String,
      kind: Schema.Literals(["text", "image", "spill", "link"]),
      mimeType: Schema.optionalKey(Schema.String),
      size: Schema.optionalKey(Schema.Finite),
      path: Schema.optionalKey(Schema.String),
      held: Schema.optionalKey(
        Schema.Union([
          Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
          Schema.Struct({
            kind: Schema.Literal("blob"),
            base64: Schema.String,
            mimeType: Schema.String,
          }),
        ]),
      ),
    }),
  ),
});

const decodeShown = Schema.decodeUnknownOption(ShownResources);

/** The resources a card's artifact holds (`resourcesOf`'s, put there by the thread); none when it holds none. */
export const resourcesIn = (
  artifact: ToolCallMessagePartProps["artifact"],
): ReadonlyArray<ShownResource> =>
  Option.match(decodeShown(artifact), { onNone: () => [], onSome: (found) => found.resources });
