// MCP Apps on the Session socket (`docs/architecture/mcp-apps.md` → App records, Socket messages): the App record the
// Session keeps for each App call, its bounds, and the messages and answers around it. Records are additive-only, with
// fallback members and no format `v`: a member a later build adds is a key an older reader passes over, and an enum of
// strings (`state`, `kind`, `status`) is read as the fallback it names when it does not know the value.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- bounds over plain
// values, written as loops so a record is measured and cut without copying it more than it must.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { ConversationId } from "./conversation-id.ts";

const MiB = 1024 * 1024;

/** The most one App record may weigh, as its JSON in UTF-8 bytes (`boundAppRecord`). */
export const MAX_MCP_APP_RECORD_BYTES = MiB;

/** The most the records of one Session may weigh in all: past it the least recently mounted are evicted. */
export const MAX_MCP_APP_RECORDS_BYTES = 32 * MiB;

/** A text of a record that is over its bound is cut to this many UTF-8 bytes. */
export const MCP_APP_TEXT_CUT_BYTES = 64 * 1024;

/**
 * The most records a Session keeps, however small: the index of them is one stored value, and sent to the page (as
 * `mcp_apps`) whenever it changes. Past it the least recently mounted record is evicted, as past `MAX_MCP_APP_RECORDS_BYTES`.
 */
export const MAX_MCP_APP_RECORDS = 1000;

/** The most stubs (what an evicted record leaves) a Session keeps; the oldest are dropped, and read as no record. */
export const MAX_MCP_APP_STUBS = 2000;

/** The most entries an App's audit log keeps (`docs/architecture/mcp-apps.md` → An App View's calls). */
export const MAX_MCP_APP_AUDIT = 50;

/**
 * An App View's limits (`docs/architecture/mcp-apps.md` → An App View's calls): requests in flight at once, and requests a
 * minute, for each View (a Session socket's mount of one call), counted whether or not the request is let through.
 */
export const MAX_MCP_APP_IN_FLIGHT = 4;
export const MAX_MCP_APP_PER_MINUTE = 60;

/** The log lines (`notifications/message`) a View may send in a minute, counted the same way. */
export const MAX_MCP_APP_LOGS_PER_MINUTE = 60;

/**
 * App context and App messages (`docs/architecture/mcp-apps.md` → App messages and App context). A held context is at most
 * `MAX_MCP_APP_CONTEXT_BYTES` of UTF-8 (cut at a character); the text a client sends is at most `MAX_MCP_APP_CONTEXT_INPUT`
 * characters, which the Session cuts. A conversation holds at most `MAX_MCP_APP_PENDING` pending contexts (one for each call
 * of its Views), and a Session at most `MAX_MCP_APP_CONTEXTS` contexts, delivered ones included. A View may send
 * `MAX_MCP_APP_CONTEXTS_PER_MINUTE` a minute, counted whether or not it is held.
 */
export const MAX_MCP_APP_CONTEXT_BYTES = 4096;
export const MAX_MCP_APP_CONTEXT_INPUT = 64 * 1024;
export const MAX_MCP_APP_PENDING = 16;
export const MAX_MCP_APP_CONTEXTS = 128;
export const MAX_MCP_APP_CONTEXTS_PER_MINUTE = 60;

/** The most App messages one composer holds, and one message sends (`submit.app`): one for each App View, at most this many. */
export const MAX_APP_MESSAGES = 3;

/** The longest App message the Session takes with a send, in characters (the chip holds what the View sent, cut to it). */
export const MAX_APP_MESSAGE_CHARS = 16 * 1024;

/** What an audit entry keeps of a request: its arguments, in UTF-8 bytes (cut at a character), and the result's or error's text, in characters. */
export const MCP_APP_AUDIT_ARGS_BYTES = 2048;
export const MCP_APP_AUDIT_TEXT_CHARS = 500;

/** The most App tools `mcp_app_tools` lists. */
export const MAX_MCP_APP_TOOLS = 1000;

/** The most UTF-16 code units of one App tool's `inputSchema` that `mcp_app_tools` carries, and of all of them together. */
export const MAX_MCP_APP_SCHEMA_CHARS = 2048;
export const MAX_MCP_APP_SCHEMAS_CHARS = 65_536;

/** One entry of an App View's audit log: what it asked for, and what came of it. `kind` is a string so one a later build adds still reads. */
export const McpAppAuditEntry = Schema.Struct({
  /** Epoch milliseconds. */
  at: Schema.Finite,
  kind: Schema.String,
  /** A line of plain text: the call's tool and what it came to, never a Secret's value. */
  summary: Schema.String,
});

export type McpAppAuditEntry = typeof McpAppAuditEntry.Type;

/** The last App context an App View sent (`ui/update-model-context`) for the call, which the card shows as a chip. */
export const McpAppContext = Schema.Struct({
  /** What it is deduplicated by. */
  hash: Schema.String,
  text: Schema.String,
  /** Epoch milliseconds the Session held it. */
  at: Schema.Finite,
  /** Whether it was delivered to the conversation, or is pending. */
  delivered: Schema.optionalKey(Schema.Boolean),
});

export type McpAppContext = typeof McpAppContext.Type;

/**
 * The record of one App call, direct or nested in `codemode`, root or subagent: what a mount, live or later, is given. The
 * `result` is the whole Secret-redacted `CallToolResult` (`content`, `structuredContent`, `isError` and the result's
 * `_meta`), as the server sent it. `truncated` is set when a bound cut it (`boundAppRecord`).
 */
export const McpAppRecord = Schema.Struct({
  callId: Schema.String,
  /** The server's configured name. */
  server: Schema.String,
  /** The tool, as the server names it. */
  tool: Schema.String,
  /** The conversation that made the call, as a number's text. */
  conversation: Schema.String,
  /** For a call nested in a `codemode` script, the script's call. */
  parentCall: Schema.optionalKey(Schema.String),
  arguments: Schema.Record(Schema.String, Schema.Json),
  /** The hash the App's page is kept under at the host (`mcp_app_html`), when the host had it. */
  htmlHash: Schema.optionalKey(Schema.String),
  /**
   * What named the origin of the server's Views when the call ran (`viewHash`: its Environment, source and name). A mount
   * whose server now has another is not the same server (a Repo's `docs` shadowed by an owner's): it is "App unavailable".
   */
  viewHash: Schema.optionalKey(Schema.String),
  result: Schema.Record(Schema.String, Schema.Json),
  truncated: Schema.optionalKey(Schema.Boolean),
  /** The App View's calls and reads, newest last, at most `MAX_MCP_APP_AUDIT`. */
  audit: Schema.Array(McpAppAuditEntry),
  context: Schema.optionalKey(McpAppContext),
  /** Epoch milliseconds the call completed. */
  at: Schema.Finite,
});

export type McpAppRecord = typeof McpAppRecord.Type;

/** What a call's record is made from: everything the call knows; the audit log and the context start empty. */
export type McpAppDraft = Omit<McpAppRecord, "audit" | "context" | "truncated" | "at">;

/** What an evicted record leaves: who the call was, and nothing of its data. */
export const McpAppStub = Schema.Struct({
  callId: Schema.String,
  server: Schema.String,
  tool: Schema.String,
  conversation: Schema.String,
  parentCall: Schema.optionalKey(Schema.String),
  /** Epoch milliseconds the call completed, when the stub knows (a record's eviction keeps it; older stubs have none). */
  at: Schema.optionalKey(Schema.Finite),
});

export type McpAppStub = typeof McpAppStub.Type;

/**
 * One App call of a conversation, as `mcp_apps` lists them: `kept` (its record can be mounted) or `evicted` (a stub: the
 * card shows the call's summary only, "App data no longer kept"). A state this build does not know reads as `evicted`.
 */
export const McpAppEntry = Schema.Struct({
  callId: Schema.String,
  server: Schema.String,
  tool: Schema.String,
  parentCall: Schema.optionalKey(Schema.String),
  state: Schema.String,
  htmlHash: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
  /**
   * The last App context the call's View sent (`ui/update-model-context`) and whether it was delivered: what the card shows
   * as a chip. Absent when it sent none, or the build is older. A context a later build changes reads as absent.
   */
  context: Schema.optionalKey(McpAppContext).pipe(Schema.catchDecoding(() => Effect.succeedNone)),
  /** Epoch milliseconds the call completed. */
  at: Schema.Finite,
});

export type McpAppEntry = typeof McpAppEntry.Type;

/** Whether an entry's record can be mounted: `kept`; any other state, one a later build adds included, cannot. */
export const isKeptApp = (entry: Pick<McpAppEntry, "state">): boolean => entry.state === "kept";

/**
 * A conversation's App calls, whole: sent after the snapshot of each conversation a client `watch`es, and again each
 * time they change; each replaces the last one of that conversation. A conversation with none has an empty list.
 */
export const McpAppsMessage = Schema.Struct({
  type: Schema.Literal("mcp_apps"),
  conversationId: ConversationId,
  apps: Schema.Array(McpAppEntry),
});

/** An App tool of the inventory: what the page needs to know a call is an App's as it starts, and what an App View may call. */
export const McpAppTool = Schema.Struct({
  /** The tool's model-facing name (`mcp__<server>__<tool>`), which a tool call carries. */
  name: Schema.String,
  /** The server's configured name. */
  server: Schema.String,
  /** The tool, as the server names it. */
  tool: Schema.String,
  title: Schema.optionalKey(Schema.String),
  /** The `ui://` resource the tool declares. */
  uri: Schema.String,
  /**
   * The tool's `inputSchema`, for the View's `toolInfo`: left out when it is over `MAX_MCP_APP_SCHEMA_CHARS`, or once the
   * list's schemas have used `MAX_MCP_APP_SCHEMAS_CHARS`, since the list is sent whole on every connect and change.
   */
  inputSchema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  /** Its `_meta.ui.visibility`: `model`, `app`, or both, the default. */
  visibility: Schema.Array(Schema.String),
});

export type McpAppTool = typeof McpAppTool.Type;

/**
 * The inventory's App tools, whole: sent after `hello` on every connect (an empty list too) and to every client when the
 * inventory changes them. A server switched off or removed has none.
 */
export const McpAppToolsMessage = Schema.Struct({
  type: Schema.Literal("mcp_app_tools"),
  tools: Schema.Array(McpAppTool),
});

/** The longest `callId` or `hash` a client's message may carry. */
export const MAX_MCP_APP_KEY = 512;

/** The longest `requestId` or `method` of an App View's request a client's message may carry. */
export const MAX_MCP_APP_REQUEST_KEY = 128;

/** The most characters of an App View's log message (`notifications/message`) the client sends and the Session keeps for telemetry. */
export const MAX_MCP_APP_LOG_CHARS = 2048;

/** JSON-RPC's codes an App View's request is answered with, and the server-error code its refused, cancelled and unavailable ones are. */
export const MCP_APP_METHOD_NOT_FOUND = -32_601;
export const MCP_APP_INVALID_PARAMS = -32_602;
export const MCP_APP_INTERNAL_ERROR = -32_603;
export const MCP_APP_REFUSED = -32_000;

/** Why an App View's request failed: the `reason` of an error answer. A reason a later build adds reads as `failed`. */
export const McpAppReason = Schema.Literals([
  "sign_in",
  "hidden",
  "limit",
  "refused",
  "cancelled",
  "unavailable",
  "failed",
]);

export type McpAppReason = typeof McpAppReason.Type;

/**
 * What `mcp_app_request` answers (`docs/architecture/mcp-apps.md` → An App View's calls): the server's `result` (a
 * `CallToolResult` or a `ReadResourceResult`, redacted of the Secrets the Session holds, never shaped as the model's), or an
 * `error` the View is answered with as JSON-RPC's: `code` and `message`, and `reason`, which says why (`sign_in`, `hidden`,
 * `limit`, `refused`, `cancelled`, `unavailable`, `failed`; a reason this build does not know reads as `failed`). A
 * `sign_in` error names the `server`, and `stepUp` when the sign-in it has is not enough; the card links Sign in. `audit` is
 * the entry the Session kept of the request, for the card's details; absent when none was kept (a refused request leaves
 * none). A status this build does not know reads as an error.
 */
export const McpAppRequestResult = Schema.Struct({
  status: Schema.Literal("result"),
  result: Schema.Record(Schema.String, Schema.Json),
  audit: Schema.optionalKey(McpAppAuditEntry),
});

export type McpAppRequestResult = typeof McpAppRequestResult.Type;

export const McpAppRequestError = Schema.Struct({
  status: Schema.Literal("error"),
  code: Schema.Finite,
  message: Schema.String,
  reason: Schema.String,
  server: Schema.optionalKey(Schema.String),
  stepUp: Schema.optionalKey(Schema.Boolean),
  audit: Schema.optionalKey(McpAppAuditEntry),
});

export type McpAppRequestError = typeof McpAppRequestError.Type;

/** An error answer for an App View's request: `reason`, the words for the View, and the JSON-RPC `code` (a refusal's, unless it says otherwise). */
export const mcpAppError = (
  reason: McpAppReason,
  message: string,
  code: number = MCP_APP_REFUSED,
): McpAppRequestError => ({ status: "error", code, message, reason });

export const McpAppRequestAnswer = Schema.Union([
  McpAppRequestResult,
  McpAppRequestError,
  Schema.Struct({ status: Schema.String, message: Schema.optionalKey(Schema.String) }),
]);

export type McpAppRequestAnswer = typeof McpAppRequestAnswer.Type;

/**
 * What `mcp_app_mount` answers: the call's `record`, a `stub` (evicted: the summary only) or `none` (no record of the call:
 * it is still running, it was not an App's, or it came before records were kept). A status this build does not know reads as `none`.
 */
export const McpAppMounted = Schema.Union([
  Schema.Struct({ status: Schema.Literal("record"), record: McpAppRecord }),
  Schema.Struct({ status: Schema.Literal("stub"), stub: McpAppStub }),
  Schema.Struct({ status: Schema.Literal("none") }),
  Schema.Struct({ status: Schema.String }),
]);

export type McpAppMounted = typeof McpAppMounted.Type;

/** The page's `_meta.ui` the View is mounted with, as the host keeps it. */
export const McpAppPageMeta = Schema.Struct({
  csp: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  domain: Schema.optionalKey(Schema.String),
  prefersBorder: Schema.optionalKey(Schema.Boolean),
});

export type McpAppPageMeta = typeof McpAppPageMeta.Type;

/**
 * What `mcp_app_html` answers: the page (`html`, with its `meta`), or why there is none: `missing` (no record pins the hash,
 * or the host no longer keeps it: the mount reads it by its URI, later), `unsupported` (the host does not serve it) or
 * `failed`, or `unavailable` (the call's server is no longer the one that made it: shadowed, so no page is shown). A status
 * this build does not know reads as `failed`.
 *
 * A page comes with the `origin` its View is served on (`docs/architecture/mcp-apps.md` → The App sandbox): the Session
 * builds it from the host's `view` (the 26 characters that name the server's origin) and its own deploy-time label, and
 * leaves it out when the host gave no `view`, so the page cannot show the View: it fails to load, with Retry.
 */
export const McpAppHtmlAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("html"),
    hash: Schema.String,
    html: Schema.String,
    meta: McpAppPageMeta,
    view: Schema.optionalKey(Schema.String),
    origin: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("missing"), message: Schema.String }),
  Schema.Struct({ status: Schema.Literal("unsupported"), message: Schema.String }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String }),
  Schema.Struct({ status: Schema.Literal("unavailable"), message: Schema.String }),
  Schema.Struct({ status: Schema.String, message: Schema.optionalKey(Schema.String) }),
]);

export type McpAppHtmlAnswer = typeof McpAppHtmlAnswer.Type;

/**
 * A call's App record or stub as a Fork or Clone carries it to the new Session, with the page of entries that holds its
 * call (`ExportPage.apps`). Only an RPC's value, never a message to a client.
 */
export type McpAppCopy =
  | { readonly kind: "record"; readonly record: McpAppRecord }
  | { readonly kind: "stub"; readonly stub: McpAppStub }
  // A kind a newer Session sends: skipped, never an error that leaves a Fork half done.
  | { readonly kind: string };

/** What a Session does with the App records of a Fork or Clone (`ExportPage.apps`): what its calls' copies are, and keeping them. */
export type McpAppCopies = {
  /** The records and stubs of the calls whose result entry is among `callIds`, and of the calls nested in them. */
  readonly copiesFor: (callIds: ReadonlyArray<string>) => ReadonlyArray<McpAppCopy>;
  /** Keep the copies a Fork or Clone's source sent, as the calls of conversation `conversation`; the bounds apply. */
  readonly adopt: (copies: ReadonlyArray<McpAppCopy>, conversation: ConversationId) => void;
};

/**
 * What `mcp_app_context` answers: `held`, with the context the call now has as the Session holds it (cleaned, redacted and
 * cut to its bound; the one it had, when the text was the same as it held, or none when an empty text cleared a pending
 * one), or `refused` and why (the call has no record kept, too many contexts wait, the View is over its limit). A status
 * this build does not know is a refusal it can show.
 */
export const McpAppContextAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literal("held"), context: Schema.optionalKey(McpAppContext) }),
  Schema.Struct({ status: Schema.Literal("refused"), message: Schema.String }),
  Schema.Struct({ status: Schema.String, message: Schema.optionalKey(Schema.String) }),
]);

export type McpAppContextAnswer = typeof McpAppContextAnswer.Type;

/**
 * An App message the owner sent with a message (`submit.app`): the call whose View offered it, and the text the chip held
 * (what the owner sent, edited or not is the owner's: an edited one is no App message). The Session names the server from the
 * call's record, never from the message.
 */
export const AppMessageRef = Schema.Struct({
  callId: Schema.String.check(Schema.isMaxLength(MAX_MCP_APP_KEY)),
  text: Schema.String.check(Schema.isMaxLength(MAX_APP_MESSAGE_CHARS)),
});

export type AppMessageRef = typeof AppMessageRef.Type;

/**
 * An App message a sent message carries, as its `cloudpid.user` entry keeps it for the transcript's line "sent from the
 * <server> app": the call, the server's configured name, and the text, which is also a text part of the model's message.
 */
export const SentAppMessage = Schema.Struct({
  callId: Schema.String,
  /** The server's configured name; empty for a call whose record was gone when the message was sent. */
  server: Schema.String,
  text: Schema.String,
});

export type SentAppMessage = typeof SentAppMessage.Type;

// ---------------------------------------------------------------------------------------------------------------------
// Bounds

/** `text`'s length in UTF-8 bytes, counted without making them. */
const utf8Length = (text: string): number => {
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

/** What `record` weighs: its JSON, in UTF-8 bytes. */
export const appRecordBytes = (record: McpAppRecord): number => utf8Length(JSON.stringify(record));

/** Where an App message came from, as a phrase: "the docs app", or "an app" for one whose server is gone (an empty name). */
export const fromApp = (server: string): string => (server === "" ? "an app" : `the ${server} app`);

/** `text` cut to at most `max` UTF-8 bytes, at a character's end. */
export const cutUtf8 = (text: string, max: number): string => {
  let bytes = 0;
  let at = 0;

  while (at < text.length) {
    const unit = text.charCodeAt(at);
    const pair = unit >= 0xd800 && unit < 0xdc00 && at + 1 < text.length;
    const width = unit < 0x80 ? 1 : unit < 0x800 ? 2 : pair ? 4 : 3;

    if (bytes + width > max) break;

    bytes += width;
    at += pair ? 2 : 1;
  }

  return at === text.length ? text : text.slice(0, at);
};

type Json = Schema.Json;

type JsonRecord = { readonly [key: string]: Json };

const isRecord = (value: Json | undefined): value is JsonRecord =>
  Predicate.isObject(value) && !Array.isArray(value);

/** `result` with its `content` blocks mapped by `change`: `undefined` leaves a block as it is. */
const mapContent = (
  result: McpAppRecord["result"],
  change: (block: JsonRecord) => Json | undefined,
): McpAppRecord["result"] => {
  const { content } = result;

  if (!Array.isArray(content)) return result;

  return {
    ...result,
    // SAFETY: `result` is JSON, whose array `content` is an array of JSON values.
    content: Arr.map(content as ReadonlyArray<Json>, (block) =>
      isRecord(block) ? (change(block) ?? block) : block,
    ),
  };
};

/** Every text of the result cut to `MCP_APP_TEXT_CUT_BYTES`: a text block's, and an embedded resource's text. */
const cutTexts = (result: McpAppRecord["result"]): McpAppRecord["result"] =>
  mapContent(result, (block) => {
    const { text, resource } = block;

    if (block["type"] === "text" && Predicate.isString(text)) {
      return Object.assign({}, block, { text: cutUtf8(text, MCP_APP_TEXT_CUT_BYTES) });
    }

    if (
      block["type"] === "resource" &&
      isRecord(resource) &&
      Predicate.isString(resource["text"])
    ) {
      return Object.assign({}, block, {
        resource: Object.assign({}, resource, {
          text: cutUtf8(resource["text"], MCP_APP_TEXT_CUT_BYTES),
        }),
      });
    }

    return undefined;
  });

/** The binary payload of a content block, in characters: an image's or audio's `data`, an embedded resource's `blob`. */
const binaryLength = (block: JsonRecord): number => {
  const { data, resource } = block;

  if (Predicate.isString(data) && (block["type"] === "image" || block["type"] === "audio")) {
    return data.length;
  }

  return isRecord(resource) && Predicate.isString(resource["blob"]) ? resource["blob"].length : 0;
};

/** The largest binary block of the result replaced whole by a line that says so; the same result when it has none. */
const dropLargestBinary = (result: McpAppRecord["result"]): McpAppRecord["result"] => {
  const { content } = result;

  if (!Array.isArray(content)) return result;

  const blocks: ReadonlyArray<Json> = content;
  let largest = -1;
  let length = 0;

  blocks.forEach((block, index) => {
    const size = isRecord(block) ? binaryLength(block) : 0;

    if (size > length) {
      length = size;
      largest = index;
    }
  });

  if (largest === -1) return result;

  const dropped = blocks[largest];
  const kind = isRecord(dropped) ? dropped["type"] : undefined;

  return {
    ...result,
    content: Arr.map(blocks, (block, index) =>
      index === largest
        ? {
            type: "text",
            text: `[${Predicate.isString(kind) ? kind : "binary"} content omitted: too large for an App's record]`,
          }
        : block,
    ),
  };
};

const withoutKey = (value: McpAppRecord["result"], key: string): McpAppRecord["result"] =>
  Object.fromEntries(Object.entries(value).filter(([each]) => each !== key));

/** The keys of a `CallToolResult` (MCP): any other is a server's own, and is the first to go when a record is too large. */
const RESULT_KEYS: ReadonlyArray<string> = ["content", "structuredContent", "isError", "_meta"];

/** The line that stands in for the content blocks a record is too large to keep. */
const omitted = (count: number): Json => ({
  type: "text",
  text: `[${count} content block${count === 1 ? "" : "s"} omitted: too large for an App's record]`,
});

/** `result` with only its first `keep` content blocks and a line that says how many went. */
const keepBlocks = (result: McpAppRecord["result"], keep: number): McpAppRecord["result"] => {
  const { content } = result;

  if (!Array.isArray(content)) return result;

  // SAFETY: `result` is JSON, whose array `content` is an array of JSON values.
  const blocks = content as ReadonlyArray<Json>;

  return { ...result, content: [...Arr.take(blocks, keep), omitted(blocks.length - keep)] };
};

/**
 * What a record is brought to when the other steps leave it over the bound: the result's own keys only, then its content
 * blocks from the end replaced by a line, as many as it takes (found by halving, since a result may have tens of thousands),
 * and, if even one block is too much, a result that is the line alone, with its `isError`.
 */
const withinBound = (record: McpAppRecord): McpAppRecord => {
  const known = Object.fromEntries(
    Object.entries(record.result).filter(([key]) => RESULT_KEYS.includes(key)),
  );

  let current: McpAppRecord = { ...record, result: known };

  if (appRecordBytes(current) <= MAX_MCP_APP_RECORD_BYTES) return current;

  const { content } = current.result;
  let low = 0;
  let high = Array.isArray(content) ? content.length : 0;

  // The most blocks that fit beside the line, the line alone at least.
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);

    if (
      appRecordBytes({ ...current, result: keepBlocks(current.result, middle) }) <=
      MAX_MCP_APP_RECORD_BYTES
    ) {
      low = middle;
    } else high = middle - 1;
  }

  current = { ...current, result: keepBlocks(current.result, low) };

  if (appRecordBytes(current) <= MAX_MCP_APP_RECORD_BYTES) return current;

  const failed = current.result["isError"];

  return {
    ...current,
    result: Predicate.isBoolean(failed)
      ? { content: [omitted(Array.isArray(content) ? content.length : 0)], isError: failed }
      : { content: [omitted(Array.isArray(content) ? content.length : 0)] },
  };
};

/**
 * `record` held to `MAX_MCP_APP_RECORD_BYTES`. A record within it is returned as it is, after `redact` (which must give
 * the same value with the Secrets held replaced by their references; the default changes nothing). Over it, in this order
 * and only as far as it takes: the result's `structuredContent` is dropped (before `redact`, which then reads less); the
 * texts are cut to `MCP_APP_TEXT_CUT_BYTES` (after it, so a Secret is never cut into a piece `redact` cannot recognize);
 * the largest binary blocks are replaced by a line, the result's `_meta` dropped, and the call's arguments; and last, so
 * that the bound always holds, `withinBound`: the keys a `CallToolResult` does not have dropped, then content blocks from the
 * end. A record cut at all says `truncated: true`; the same record is what a live mount and a replay are given.
 */
export const boundAppRecord = (
  record: McpAppRecord,
  redact: <A>(value: A) => A = (value) => value,
): McpAppRecord => {
  let current = record;
  let cut = false;

  if (
    appRecordBytes(current) > MAX_MCP_APP_RECORD_BYTES &&
    current.result["structuredContent"] !== undefined
  ) {
    current = { ...current, result: withoutKey(current.result, "structuredContent") };
    cut = true;
  }

  current = redact(current);

  const steps: ReadonlyArray<(each: McpAppRecord) => McpAppRecord> = [
    (each) => ({ ...each, result: cutTexts(each.result) }),
    (each) => {
      let next = each;

      // One at a time, largest first: a small image may stay when the large one was the cost.
      while (appRecordBytes(next) > MAX_MCP_APP_RECORD_BYTES) {
        const result = dropLargestBinary(next.result);

        if (result === next.result) break;

        next = Object.assign({}, next, { result });
      }

      return next;
    },
    (each) => ({ ...each, result: withoutKey(each.result, "_meta") }),
    (each) => ({ ...each, arguments: {} }),
    withinBound,
  ];

  let size = appRecordBytes(current);

  for (const step of steps) {
    if (size <= MAX_MCP_APP_RECORD_BYTES) break;

    const next = step(current);
    const after = appRecordBytes(next);

    // A step that changed nothing leaves the record as it is, and not cut.
    if (after !== size) {
      current = next;
      size = after;
      cut = true;
    }
  }

  return cut ? { ...current, truncated: true } : current;
};

// ---------------------------------------------------------------------------------------------------------------------
// The audit log

/** The first text of a `CallToolResult`'s `content` or a `ReadResourceResult`'s `contents`: what an audit entry says of what came back. */
const firstTextOf = (result: JsonRecord): string | undefined => {
  for (const key of ["content", "contents"]) {
    const blocks = result[key];

    if (!Arr.isArray(blocks)) continue;

    // SAFETY: `result` is JSON, whose array is an array of JSON values.
    for (const block of blocks as ReadonlyArray<Json>) {
      if (isRecord(block) && Predicate.isString(block["text"])) return block["text"];
    }
  }

  return undefined;
};

/** `text` on one line: whitespace runs are a space, and at most `max` characters, `…` marking a cut. */
const oneLineCut = (text: string, max: number): string => {
  const line = text.replaceAll(/\s+/g, " ").trim();

  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

/** What an App View asked for and what came of it, as the audit log's summary (`MCP_APP_AUDIT_ARGS_BYTES`, `MCP_APP_AUDIT_TEXT_CHARS`). */
export type McpAppAuditSummary = {
  readonly method: string;
  /** The tool's name, or the resource's URI. */
  readonly target: string;
  readonly arguments?: Json | undefined;
  /** The answer: its `result`, or its error's `reason` and `message`. */
  readonly outcome:
    | { readonly status: "result"; readonly result: JsonRecord }
    | { readonly status: "error"; readonly reason: string; readonly message: string };
  /** What the server's questions during the call came to, one phrase each: never a value or what the server wrote. */
  readonly notes?: ReadonlyArray<string> | undefined;
};

/**
 * One line for the audit log (`docs/architecture/mcp-apps.md` → An App View's calls): `<method> <target> <arguments> →
 * <outcome>`, with the arguments' JSON cut to `MCP_APP_AUDIT_ARGS_BYTES` and the outcome's text to `MCP_APP_AUDIT_TEXT_CHARS`
 * characters. It names no more than the View sent and the server answered; the caller redacts the Secrets held.
 */
export const appAuditSummary = (what: McpAppAuditSummary): string => {
  const target = oneLineCut(what.target, 200);

  const sent =
    what.arguments === undefined ||
    (isRecord(what.arguments) && Object.keys(what.arguments).length === 0)
      ? ""
      : ` ${cutUtf8(JSON.stringify(what.arguments), MCP_APP_AUDIT_ARGS_BYTES)}`;

  const { outcome } = what;

  const text =
    outcome.status === "result"
      ? (() => {
          const first = firstTextOf(outcome.result);
          const label = outcome.result["isError"] === true ? "tool error" : "ok";

          return first === undefined
            ? label
            : `${label}: ${oneLineCut(first, MCP_APP_AUDIT_TEXT_CHARS)}`;
        })()
      : `${outcome.reason}: ${oneLineCut(outcome.message, MCP_APP_AUDIT_TEXT_CHARS)}`;

  const asked =
    what.notes === undefined || what.notes.length === 0
      ? ""
      : ` (${oneLineCut(what.notes.join("; "), MCP_APP_AUDIT_TEXT_CHARS)})`;

  return `${what.method} ${target}${sent} → ${text}${asked}`;
};
