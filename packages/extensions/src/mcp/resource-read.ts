// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- builders over plain values,
// and pi-durable's Promise-based tool seam.
// `read_mcp_resource` (`docs/architecture/mcp-in-a-session.md` → Resource tools): a read (`resources/read`) of a URI the
// model got from a list, a template or a link, listed or not. The model gets the contents as pi's tool gives them (a line
// naming each when there are several, text, images, and a Result Spill for any other blob, written through the call's
// environment so the Container never wakes for it), the script the `{ server, uri, contents }` value. The request is sent
// as a call is (`./exchange.ts`), a Legacy server's question included, but is a read: `replay: "safe"` with no `mcp.sent`
// memo, since sending it twice changes nothing. A Resource watch (`watch`) is #478's and is not declared here.
import { type McpExposure, normalizeMcpName } from "@cloudpid/config";
import type { JsonObject } from "@cloudpid/mcp/types";
import { utf8ByteLength } from "@earendil-works/chord/output";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { bytesOf, modelBlocks, oneLine, type Piece, refOf, suffixOf, textOf } from "./blocks.ts";
import type { McpHostClientService } from "./client.ts";
import type { McpDetails, McpResourceRef } from "./details.ts";
import { withElicitation } from "./elicit.ts";
import {
  contextOf,
  type Exchange,
  type McpCallOrigin,
  type McpToolOptions,
  send,
} from "./exchange.ts";
import { flagsOf } from "./exposure.ts";
import { serverNamed, unknownServer } from "./resource-targets.ts";
import { failedWith, modelResultOf, scriptResultOf } from "./result.ts";
import { type Spill, spillTo } from "./spill.ts";
import type { McpBuildServer } from "./tools.ts";
import { SCRIPT_VALUE_BUDGET } from "./value.ts";
import { cutStored, storedBytes } from "../stored-bytes.ts";

/** What a script's text ends with when it is cut to fit the value. */
const CUT_MARKER = "\n[cut to fit]";

/** What a script's `read_mcp_resource` value leaves for its keys besides the contents' texts. */
const VALUE_HEADROOM_BYTES = 8 * 1024;

/** The longest URI a line the model reads names. */
const URI_LINE_LIMIT = 2048;

/** The contents of a `resources/read` as the Session reads them: a text or a blob each, never `_meta`. */
const ReadContent = Schema.Union([
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
]);

type ReadContent = typeof ReadContent.Type;

const ReadValue = Schema.Struct({ contents: Schema.Json.pipe(Schema.Array) });

const decodeRead = Schema.decodeUnknownOption(ReadValue);

const decodeContent = Schema.decodeUnknownOption(ReadContent);

/** What a read's value holds: the contents this build reads, and how many it could not. */
type Read = { readonly contents: ReadonlyArray<ReadContent>; readonly unreadable: number };

const readOf = (value: Schema.Json): Read | undefined => {
  const read = decodeRead(value);

  if (Option.isNone(read)) return undefined;

  const decoded = Arr.map(read.value.contents, (entry) => decodeContent(entry));
  const contents = Arr.flatMap(decoded, (entry) => (Option.isSome(entry) ? [entry.value] : []));

  return { contents, unreadable: decoded.length - contents.length };
};

/** A text of the script's value, cut to the `left` of its budget (with the whole spilled when it could be). */
const scriptText = async (
  content: ReadContent & { readonly text: string },
  left: number,
  spill: Spill,
): Promise<{ readonly entry: Mutable<JsonObject>; readonly used: number }> => {
  const entry: Mutable<JsonObject> = { uri: content.uri };

  if (content.mimeType !== undefined) entry["mimeType"] = content.mimeType;

  const kept = cutStored(content.text, Math.max(0, left), CUT_MARKER);

  entry["text"] = kept;

  if (kept !== content.text) {
    entry["text_truncated"] = true;

    const saved = await spill(content.text, ".txt");

    if ("path" in saved) entry["full_output_path"] = saved.path;
  }

  return { entry, used: storedBytes(kept) };
};

/** A blob of the script's value: the Result Spill that holds it, or why there is none. */
const scriptBlob = async (
  content: ReadContent & { readonly blob: string },
  spill: Spill,
): Promise<{
  readonly entry: Mutable<JsonObject>;
  readonly size?: number;
  readonly path?: string;
}> => {
  const entry: Mutable<JsonObject> = { uri: content.uri };

  if (content.mimeType !== undefined) entry["mimeType"] = content.mimeType;

  let bytes: Uint8Array;

  try {
    bytes = bytesOf(content.blob);
  } catch {
    entry["save_error"] = "its data is not base64";

    return { entry };
  }

  entry["size"] = bytes.length;

  const saved = await spill(bytes, suffixOf(content.uri));

  if ("path" in saved) {
    entry["full_output_path"] = saved.path;

    return { entry, size: bytes.length, path: saved.path };
  }

  entry["save_error"] = saved.reason;

  return { entry, size: bytes.length };
};

/** The contents as the script gets them: texts within the value's budget, and blobs in Result Spills. */
const scriptContents = async (
  uri: string,
  contents: ReadonlyArray<ReadContent>,
  spill: Spill,
): Promise<{
  readonly value: ReadonlyArray<JsonObject>;
  readonly refs: ReadonlyArray<McpResourceRef>;
}> => {
  const value: Array<JsonObject> = [];
  const refs: Array<McpResourceRef> = [];
  let left = SCRIPT_VALUE_BUDGET - VALUE_HEADROOM_BYTES - storedBytes(uri);

  for (const [part, content] of contents.entries()) {
    if ("text" in content) {
      const text = await scriptText(content, left, spill);

      const ref = refOf(content.uri, "text", part, {
        mimeType: content.mimeType,
        size: utf8ByteLength(content.text),
      });

      left -= text.used;
      value.push(text.entry);

      if (ref !== undefined) refs.push(ref);
    } else {
      const blob = await scriptBlob(content, spill);

      const ref = refOf(content.uri, "spill", part, {
        mimeType: content.mimeType,
        size: blob.size,
        path: blob.path,
      });

      value.push(blob.entry);

      if (ref !== undefined) refs.push(ref);
    }
  }

  return { value, refs };
};

/** What the model reads of a read: a line naming each of several items, the items, and a line for any it could not read. */
const modelPieces = async (
  uri: string,
  read: Read,
  spill: Spill,
): Promise<ReadonlyArray<Piece>> => {
  const blocks = Arr.map(read.contents, (resource) => ({ type: "resource", resource }));
  const grouped = await modelBlocks(blocks, spill);

  const pieces: ReadonlyArray<Piece> = Arr.flatMap(grouped, (group, index) => {
    const content = read.contents[index];

    // Each item of several is named, so the model can tell where one ends.
    return read.contents.length > 1 && content !== undefined
      ? [{ content: textOf(`${oneLine(content.uri, URI_LINE_LIMIT)}:`), note: true }, ...group]
      : group;
  });

  const unreadable: ReadonlyArray<Piece> =
    read.unreadable > 0
      ? [
          {
            content: textOf(
              `[${read.unreadable} content item(s) omitted: this build cannot read them]`,
            ),
            note: true,
          },
        ]
      : [];

  const shown = [...pieces, ...unreadable];

  return shown.length > 0
    ? shown
    : [{ content: textOf(`[${oneLine(uri, URI_LINE_LIMIT)} has no contents]`), note: true }];
};

/** The schema of the read's value, for scripts. */
const READ_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    server: { type: "string" },
    uri: { type: "string" },
    contents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          uri: { type: "string" },
          mimeType: { type: "string" },
          text: { type: "string" },
          text_truncated: {
            type: "boolean",
            description: "The text was cut to fit; the whole is at full_output_path",
          },
          full_output_path: {
            type: "string",
            description: "A file of the whole text, or of a blob's bytes",
          },
          size: { type: "number", description: "A blob's bytes" },
          save_error: { type: "string", description: "Why a blob could not be saved" },
        },
        required: ["uri"],
        additionalProperties: false,
      },
    },
  },
  required: ["server", "uri", "contents"],
  additionalProperties: false,
};

/** What the read tool is made of. */
type ReadTool = {
  readonly name: string;
  readonly servers: ReadonlyArray<McpBuildServer>;
  readonly client: McpHostClientService;
  readonly origin: McpCallOrigin;
  readonly options: McpToolOptions;
};

/** The tool that reads a resource, at `exposure`. */
export const readTool = (
  tool: ReadTool,
  exposure: Exclude<McpExposure, "hidden">,
): ToolRegistration => ({
  name: tool.name,
  description:
    "Read a resource of an MCP server by its URI: a `uri` from list_mcp_resources, a filled-in resource template, or a resource link a tool result named. It need not be listed. `server` is the name the mcp_servers section gives (mcp__ left off). The text comes back as it is, images are shown, and any other binary data is saved to a file whose path is given; a long text is cut and saved whole.",
  parameters: Type.Object({
    server: Type.String({
      description: "The server the resource is of, as the mcp_servers section names it",
    }),
    uri: Type.String({
      description: "The resource's URI, expanded: a template is filled in first",
    }),
  }),
  structuredOutputSchema: READ_SCHEMA,
  replay: "safe",
  ...flagsOf(exposure),
  execute: async (args: { readonly server: string; readonly uri: string }, api, context) => {
    const target = serverNamed(tool.servers, args.server);

    if (target === undefined) {
      return failedWith(unknownServer(tool.servers, args.server), { server: "*", tool: tool.name });
    }

    const shown = normalizeMcpName(target.name);
    const details: McpDetails = { server: target.name, tool: tool.name };

    const exchange: Exchange = {
      client: tool.client,
      origin: tool.origin,
      server: target,
      options: tool.options,
      tool: tool.name,
      details,
      subject: "resource",
    };

    const sent = await send(
      exchange,
      api,
      context,
      (workspace, answers) => ({
        op: "resources/read",
        server: target.name,
        params: { uri: args.uri },
        ctx: contextOf(
          { ...tool.origin, workspace },
          { callId: api.callId, conversation: String(api.conversationId) },
          answers,
        ),
      }),
      async (value, _completed, caller): Promise<ToolExecutionResult<JsonValue>> => {
        const read = readOf(value);

        if (read === undefined) {
          return failedWith("The server answered with a result this build cannot read", details);
        }

        const spill = spillTo(api.env, context);

        if (caller === "script") {
          const scripted = await scriptContents(args.uri, read.contents, spill);
          const result: JsonObject = { server: shown, uri: args.uri, contents: scripted.value };

          // SAFETY: a `JsonObject` is JSON, which `JsonValue` describes.
          return scriptResultOf(
            `Read ${oneLine(args.uri, 200)}`,
            details,
            result as JsonValue,
            scripted.refs,
          );
        }

        const minimal: JsonObject = { server: shown, uri: args.uri, contents: [] };

        return modelResultOf(
          await modelPieces(args.uri, read, spill),
          { kind: "model", details, spill },
          // SAFETY: a `JsonObject` is JSON, which `JsonValue` describes.
          minimal as JsonValue,
        );
      },
    );

    return sent.ok ? withElicitation(sent.value, sent.asked) : sent.result;
  },
});
