// Reading an App's HTML (`docs/architecture/mcp-apps.md` → Declaring and reading Apps): which tools are App tools, and
// what a `resources/read` of their `ui://` resource must hold to be kept. Pure but for reading the engine's value.
//
// The content must be exactly one item, `text` or `blob`, with the MIME type exactly `text/html;profile=mcp-app` and at
// most 4 MiB of HTML; its `_meta.ui` (`csp`, `permissions`, `domain`, `prefersBorder`) is read from the item, else from
// the resource's listing entry (the draft's fallback, read side only). The page's hash is the SHA-256 of its `_meta.ui`
// (keys sorted) and its HTML, so a page that two servers give with different declarations is two pages.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- pure functions over plain values, not combinators;
// the one `async` reads a stream the engine returned, a Web API.
import { sha256Hex, sortedJson } from "@cloudpid/config";
import {
  appUriOfMeta,
  isJsonObject,
  MCP_APP_HTML_MAX_BYTES,
  MCP_APP_READ_BYTES,
  MCP_APP_MIME_TYPE,
  type McpAppUiMeta,
  type McpEngineValue,
  type McpToolDefinition,
  MiB,
  ProtocolViolation,
  TooLarge,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { AppPage } from "./app-store.ts";

/** `_meta.ui` is kept up to this many bytes of JSON: a Content Security Policy is short. */
const MAX_UI_META_BYTES = 16 * 1024;

/** The `ui://` resource an App tool declares in its `_meta.ui.resourceUri`; undefined for any other tool. */
export const appUriOf = (tool: McpToolDefinition): string | undefined =>
  appUriOfMeta(tool["_meta"]);

const utf8 = new TextEncoder();

/** `text`'s length in UTF-8 bytes, counted without making them. */
const utf8Length = (text: string) => {
  let bytes = 0;

  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);

    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && at + 1 < text.length) {
      // A surrogate pair is one character of four bytes.
      bytes += 4;
      at += 1;
    } else bytes += 3;
  }

  return bytes;
};

/** Base64 of the alphabet and its padding, which the HTML of an App's blob is. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** `atob` takes this many characters at a time (a multiple of four), so no more than a slice's text is alive with the bytes. */
const BASE64_SLICE = 3 * MiB;

/** The bytes of `blob`, base64 with no whitespace, in one buffer; none when it is not base64. */
const base64Bytes = (blob: string) => {
  if (blob.length % 4 !== 0 || !BASE64.test(blob)) return Option.none<Uint8Array>();

  const padding = blob.endsWith("==") ? 2 : blob.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array((blob.length / 4) * 3 - padding);
  let at = 0;

  for (let from = 0; from < blob.length; from += BASE64_SLICE) {
    const binary = atob(blob.slice(from, from + BASE64_SLICE));

    for (let index = 0; index < binary.length; index++) bytes[at++] = binary.charCodeAt(index);
  }

  return Option.some(bytes);
};

const ReadContents = Schema.Struct({
  contents: Schema.Array(
    Schema.Struct({
      mimeType: Schema.optionalKey(Schema.String),
      text: Schema.optionalKey(Schema.String),
      blob: Schema.optionalKey(Schema.String),
      _meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
});

const decodeContents = Schema.decodeUnknownOption(ReadContents);

const decodeListed = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      uri: Schema.String,
      _meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
);

const violation = (message: string) => ProtocolViolation.make({ message });

const tooLarge = (bytes: number) =>
  TooLarge.make({
    message: `The App's HTML is ${bytes} bytes, over its ${MCP_APP_HTML_MAX_BYTES}`,
    limit: MCP_APP_HTML_MAX_BYTES,
  });

/**
 * The `_meta.ui` in `meta`, keeping `csp`, `permissions` (objects), `domain` (text) and `prefersBorder` (a boolean); a
 * key of another type is left out. Absent when `meta` has no `ui` object.
 */
export const uiMetaOf = (
  meta: Readonly<Record<string, Schema.Json>> | undefined,
): Option.Option<McpAppUiMeta> => {
  const ui = meta?.["ui"];

  if (!isJsonObject(ui)) return Option.none();

  const kept: Mutable<McpAppUiMeta> = {};
  const { csp, permissions, domain, prefersBorder } = ui;

  if (isJsonObject(csp)) kept.csp = csp;

  if (isJsonObject(permissions)) kept.permissions = permissions;

  if (Predicate.isString(domain)) kept.domain = domain;

  if (Predicate.isBoolean(prefersBorder)) kept.prefersBorder = prefersBorder;

  return Option.some(kept);
};

/** What a `resources/read` of a `ui://` resource gave: its HTML, and the `_meta.ui` of its item if it had one. */
export type AppContent = {
  readonly html: string;
  readonly meta: Option.Option<McpAppUiMeta>;
};

/** `value`, a `resources/read` result, as an App's content, or why it is none. */
export const appContentOf = (
  value: Schema.Json,
): Effect.Effect<AppContent, ProtocolViolation | TooLarge> =>
  Effect.gen(function* () {
    const decoded = decodeContents(value);

    if (Option.isNone(decoded))
      return yield* violation("The resource read is not a list of contents");

    const [item, ...more] = decoded.value.contents;

    if (item === undefined || more.length > 0) {
      return yield* violation(
        `The App resource has ${decoded.value.contents.length} content items; it must have exactly one`,
      );
    }

    if (item.mimeType !== MCP_APP_MIME_TYPE) {
      return yield* violation(
        `The App resource's MIME type is ${item.mimeType ?? "absent"}, not ${MCP_APP_MIME_TYPE}`,
      );
    }

    if ((item.text === undefined) === (item.blob === undefined)) {
      return yield* violation("The App resource's item must have exactly one of text and blob");
    }

    let html: string;

    if (item.text !== undefined) {
      html = item.text;

      const bytes = utf8Length(html);

      if (bytes > MCP_APP_HTML_MAX_BYTES) return yield* tooLarge(bytes);
    } else {
      const bytes = base64Bytes(item.blob ?? "");

      if (Option.isNone(bytes)) return yield* violation("The App resource's blob is not base64");

      // The bytes are at least as many as the text, and over the bound there is nothing to decode.
      if (bytes.value.byteLength > MCP_APP_HTML_MAX_BYTES) {
        return yield* tooLarge(bytes.value.byteLength);
      }

      html = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.value),
        catch: () => violation("The App resource's blob is not UTF-8 text"),
      });
    }

    return { html, meta: uiMetaOf(item._meta) };
  });

/** The `_meta.ui` of the entry for `uri` in `listed`, a `resources/list` result; none when it has no such entry. */
export const listedUiMetaOf = (listed: Schema.Json, uri: string): Option.Option<McpAppUiMeta> =>
  Option.flatMap(decodeListed(listed), (entries) =>
    Option.flatMap(
      Arr.findFirst(entries, (entry) => entry.uri === uri),
      (entry) => uiMetaOf(entry._meta),
    ),
  );

/** The page `html` and `meta` make, or why `meta` is too large to keep. */
export const pageOf = (
  html: string,
  meta: McpAppUiMeta,
): Effect.Effect<AppPage, ProtocolViolation> => {
  const declared = JSON.stringify(sortedJson(meta));

  return utf8.encode(declared).byteLength > MAX_UI_META_BYTES
    ? Effect.fail(violation("The App's _meta.ui is too large"))
    : Effect.succeed({ hash: sha256Hex(`${declared}\n${html}`), html, meta });
};

/**
 * `value`'s JSON, as the engine returned it: inline, or read off its stream (cancelled unread when it is over what a page
 * may weigh).
 */
export const jsonOf = (
  value: McpEngineValue,
): Effect.Effect<Schema.Json, TooLarge | ProtocolViolation> => {
  if (value.kind === "inline") return Effect.succeed(value.value);

  if (value.bytes > MCP_APP_READ_BYTES) {
    return Effect.promise(() => value.body.cancel()).pipe(
      Effect.andThen(
        TooLarge.make({
          message: `The answer is ${value.bytes} bytes, over what an App's HTML may take`,
          limit: MCP_APP_READ_BYTES,
        }),
      ),
    );
  }

  return Effect.tryPromise({
    // SAFETY: the engine's stream carries one JSON text, which `Json` is the type of.
    try: async () => (await new Response(value.body).json()) as Schema.Json,
    catch: () => violation("The App resource's answer could not be read"),
  });
};
