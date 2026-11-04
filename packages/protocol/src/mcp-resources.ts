// A resource link's live preview on the Session socket (`docs/architecture/mcp-in-a-session.md` → Resource links and
// embedded resources): the owner opens a chip on a tool call's card, and the Session reads the resource for them through
// the host, never starting a Container. Additive only: a status or reason a later build adds reads as the fallback member.
// @effect-diagnostics missingPipeableSignature:off -- a builder over plain values.
import * as Schema from "effect/Schema";

const MiB = 1024 * 1024;

/**
 * The most bytes of a preview's contents the Session sends: what a text or a base64 blob holds, summed over the read's
 * items. It is the 16 MiB every path of an MCP result is held to (`mcp-in-a-session.md` → Calls and results), so a
 * resource the model could read is one the owner can download. A read past it is answered `too_large`, never cut, since
 * half of a blob is no preview and half of a text is not what the owner would download. The card draws far less (a
 * preview is a look, a Download is the whole).
 */
export const MAX_MCP_RESOURCE_PREVIEW_BYTES = 16 * MiB;

/** The limits of a socket's previews: at once, and in a minute (an App View's are `MAX_MCP_APP_IN_FLIGHT` and `MAX_MCP_APP_PER_MINUTE`). */
export const MAX_MCP_RESOURCE_IN_FLIGHT = 4;
export const MAX_MCP_RESOURCE_PER_MINUTE = 30;

/**
 * The longest `server`, `uri` and `path` a client's `mcp_resource_read` may carry, and the longest URI a card's reference
 * keeps: a longer one is left out, since half of a URI names nothing.
 */
export const MAX_MCP_RESOURCE_KEY = 2048;

/**
 * The path of a Result Spill the MCP extension writes (`spill.ts`): a file `mcp-<uuid><suffix>` in a temporary directory
 * `tmp-<uuid>` of the harness's `/workspace/.cloudpid/tmp`. The Session reads no other path for a preview, however a client
 * asks, so a preview is never a way to read the Workspace.
 */
const SPILL_PATH =
  /^\/workspace\/\.cloudpid\/tmp\/tmp-[A-Za-z0-9-]+\/mcp-[A-Za-z0-9-]+\.[A-Za-z0-9]{1,8}$/;

export const isMcpSpillPath = (path: string): boolean => SPILL_PATH.test(path);

/** One item of a read's contents, as the server sent it, not redacted (a preview is the owner's own view): a `text` or a base64 `blob`. */
export const McpResourceContent = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  blob: Schema.optionalKey(Schema.String),
});

export type McpResourceContent = typeof McpResourceContent.Type;

/**
 * Why a preview was not read: `stopped` (a stdio server whose Container is not running, which a preview never starts),
 * `hidden` (the page is not visible, or the server is switched off or hidden), `limit`, `sign_in`, `input_required` (the
 * server asks a question a preview cannot answer: open it in a conversation), `too_large`, `host_unsupported` (the
 * Session's MCP host cannot promise it starts no Container), `session_unsupported` (the Session is older than previews:
 * said by the client, never by a Session), `cancelled`, `unavailable`, `failed`. A reason a later build adds reads as
 * `failed`.
 */
export const McpResourceReason = Schema.Literals([
  "stopped",
  "hidden",
  "limit",
  "sign_in",
  "input_required",
  "too_large",
  "host_unsupported",
  "session_unsupported",
  "cancelled",
  "unavailable",
  "failed",
]);

export type McpResourceReason = typeof McpResourceReason.Type;

export const McpResourcePreviewContents = Schema.Struct({
  status: Schema.Literal("contents"),
  contents: Schema.Array(McpResourceContent),
});

export type McpResourcePreviewContents = typeof McpResourcePreviewContents.Type;

export const McpResourcePreviewUnavailable = Schema.Struct({
  status: Schema.Literal("unavailable"),
  reason: Schema.String,
  message: Schema.String,
});

export type McpResourcePreviewUnavailable = typeof McpResourcePreviewUnavailable.Type;

/** What `mcp_resource_read` answers: the `contents`, or why there are none. A status this build does not know reads as unavailable. */
export const McpResourcePreviewAnswer = Schema.Union([
  McpResourcePreviewContents,
  McpResourcePreviewUnavailable,
  Schema.Struct({ status: Schema.String, message: Schema.optionalKey(Schema.String) }),
]);

export type McpResourcePreviewAnswer = typeof McpResourcePreviewAnswer.Type;

/** An unavailable answer: `reason` and the words for the owner. */
export const resourceUnavailable = (
  reason: McpResourceReason,
  message: string,
): McpResourcePreviewUnavailable => ({ status: "unavailable", reason, message });
