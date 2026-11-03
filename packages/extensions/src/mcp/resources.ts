// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- builders over plain values,
// and pi-durable's Promise-based tool seam.
// The resource tools of the `mcp` extension (`docs/architecture/mcp-in-a-session.md` → Resource tools): pi's
// `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource`, one set for all servers, registered when the
// host lists the `resources` feature and an enabled, non-`hidden` server has resources, at the widest Exposure of those
// servers (`direct` > `deferred` > `codemode`, each server's own `exposure` only, and `tools.offered` lifting a tool on its
// own). They are no server's and so are never `mcp__`-named, never wrapped by `tool_search`, never in `deferred_tools`.
//
// **Lists** ask the host for one page at a time (`resources/list`, `resources/templates/list`: the host keeps a Modern
// server's page for its `ttlMs`), and the Session joins the pages of one or every server within 1,000 items and 256 KiB:
// whole pages only, `truncated` when it stopped short and `incomplete: [{ server, next_cursor? }]` for each server it
// left unfinished, the `next_cursor` going back in with that server. A page that fails is an `errors` entry for an
// all-server listing and the call's error for one server's. `ui://` and `profile=mcp-app` resources are left out, `icons`
// and `_meta` dropped, `annotations` passed through.
//
// **A read** (`resources/read`) takes a URI the model got from a list, a template or a link, listed or not. The model gets
// the contents as `read_mcp_resource` gives them (a line naming each when there are several, text, images, and a Result
// Spill for any other blob, written through the call's environment so the Container never wakes for it), the script the
// `{ server, uri, contents }` value. The request is sent as a call is (`./exchange.ts`), a Legacy server's question
// included, but is a read: `replay: "safe"` with no `mcp.sent` memo, since sending it twice changes nothing.
// A Resource watch (`watch`) is #478's and is not declared here.
import {
  type McpExposure,
  MCP_RESOURCE_TOOL_NAMES,
  normalizeMcpName,
  resolveExposure,
} from "@cloudpid/config";
import type { JsonObject } from "@cloudpid/mcp/types";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { utf8ByteLength } from "@earendil-works/chord/output";
import { bytesOf, modelBlocks, oneLine, refOf, suffixOf, textOf, type Piece } from "./blocks.ts";
import type { McpHostClientService } from "./client.ts";
import { MAX_RESOURCE_REFS, type McpDetails, type McpResourceRef } from "./details.ts";
import { withElicitation } from "./elicit.ts";
import {
  contextOf,
  type Exchange,
  type McpCallOrigin,
  type McpToolOptions,
  send,
} from "./exchange.ts";
import { exposureKeys, flagsOf, isReachable } from "./exposure.ts";
import { failedWith, refsOf, withinLimits } from "./result.ts";
import { spillTo, type Spill } from "./spill.ts";
import type { McpBuild, McpBuildServer } from "./tools.ts";
import { SCRIPT_VALUE_BUDGET } from "./value.ts";
import { cutStored, storedBytes } from "../stored-bytes.ts";

/** The host feature the resource tools need: a host without it has no `resources/*` requests, and gets no tools. */
export const MCP_RESOURCE_FEATURE = "resources";

/** The most items one listing holds, across servers. */
export const MAX_LISTED_ITEMS = 1000;

/** The most one listing's items weigh, stored as JSON in UTF-8 bytes, across servers. */
export const MAX_LISTED_BYTES = 256 * 1024;

/** The most pages one listing asks the host for, so a server whose cursors never end cannot hold the call. */
const MAX_LISTED_PAGES = 50;

/** What a text a script's value cut ends with. */
const CUT_MARKER = "\n[cut to fit]";

/** What a script's `read_mcp_resource` value leaves for its keys besides the contents' texts. */
const VALUE_HEADROOM_BYTES = 8 * 1024;

type ResourceKind = "resources" | "templates";

/** Whether the resource tools reach `server`: it is enabled, not `hidden`, and offers resources. */
const hasResources = (server: McpBuildServer): boolean =>
  server.resources === true && isReachable(server);

/** `ui://` and `profile=mcp-app` resources are an App's, which the lists leave out (`docs/architecture/mcp-apps.md`). */
const isAppResource = (uri: string, mimeType: string | undefined): boolean =>
  uri.startsWith("ui://") ||
  (mimeType?.toLowerCase().replaceAll(" ", "").includes("profile=mcp-app") ?? false);

const Annotated = {
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  annotations: Schema.optionalKey(Schema.Json),
};

const ListedResource = Schema.Struct({
  uri: Schema.String,
  name: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Finite),
  ...Annotated,
});

const ListedTemplate = Schema.Struct({
  uriTemplate: Schema.String,
  name: Schema.optionalKey(Schema.String),
  ...Annotated,
});

const decodeResource = Schema.decodeUnknownOption(ListedResource);

const decodeTemplate = Schema.decodeUnknownOption(ListedTemplate);

/** One page of a list as the host answers it. */
const ListPage = Schema.Struct({
  resources: Schema.Json.pipe(Schema.Array, Schema.optionalKey),
  resourceTemplates: Schema.Json.pipe(Schema.Array, Schema.optionalKey),
  nextCursor: Schema.optionalKey(Schema.String),
});

const decodePage = Schema.decodeUnknownOption(ListPage);

/** The listed fields of `item`, in the order they are shown, under `server`'s name; `annotations` as the server sent them. */
const shownItem = (server: string, item: JsonObject): JsonObject => {
  const shown: Mutable<JsonObject> = { server };

  for (const key of [
    "name",
    "uri",
    "uriTemplate",
    "title",
    "description",
    "mimeType",
    "size",
    "annotations",
  ]) {
    const value = item[key];

    if (value !== undefined) shown[key] = value;
  }

  return shown;
};

/** A page's visible items under `server`'s name, and its cursor: an App's resources, `icons` and `_meta` are left out. */
const pageItems = (
  kind: ResourceKind,
  server: string,
  value: Schema.Json,
): { readonly items: ReadonlyArray<JsonObject>; readonly nextCursor?: string } | undefined => {
  const page = decodePage(value);

  if (Option.isNone(page)) return undefined;

  const raw = (kind === "resources" ? page.value.resources : page.value.resourceTemplates) ?? [];

  const items = Arr.flatMap(raw, (entry): ReadonlyArray<JsonObject> => {
    if (kind === "resources") {
      const resource = decodeResource(entry);

      return Option.isNone(resource) || isAppResource(resource.value.uri, resource.value.mimeType)
        ? []
        : [shownItem(server, resource.value)];
    }

    const template = decodeTemplate(entry);

    return Option.isNone(template) ||
      isAppResource(template.value.uriTemplate, template.value.mimeType)
      ? []
      : [shownItem(server, template.value)];
  });

  return page.value.nextCursor === undefined
    ? { items }
    : { items, nextCursor: page.value.nextCursor };
};

/** The server of the resource tools a model's `wanted` names: its normalized name, its configured one, or `mcp__<name>`. */
const serverNamed = (
  servers: ReadonlyArray<McpBuildServer>,
  wanted: string,
): McpBuildServer | undefined => {
  const trimmed = wanted.trim();

  const key = normalizeMcpName(
    trimmed.startsWith("mcp__") ? trimmed.slice("mcp__".length) : trimmed,
  );

  return Arr.findFirst(servers, (server) => normalizeMcpName(server.name) === key).pipe(
    Option.getOrUndefined,
  );
};

/** Why `wanted` is no server the resource tools reach, saying which are. */
const unknownServer = (servers: ReadonlyArray<McpBuildServer>, wanted: string): string => {
  const names = Arr.map(servers, (server) => normalizeMcpName(server.name));

  return `No MCP server named ${JSON.stringify(oneLine(wanted, 100))} has resources. Servers with resources: ${Arr.join(names, ", ")}.`;
};

/** The text of the first block of a result that says why it failed, for an `errors` entry. */
const messageOf = (result: ToolExecutionResult<JsonValue>): string => {
  const first = result.output?.[0];

  return first?.type === "text" ? oneLine(first.text, 500) : "The request failed";
};

// ---------------------------------------------------------------------------------------------------------------------
// Lists

/** What a listing is made of so far, and what it left unfinished. */
type Listing = {
  readonly items: Array<JsonObject>;
  readonly incomplete: Array<{ readonly server: string; readonly next_cursor?: string }>;
  readonly errors: Array<{ readonly server: string; readonly error: string }>;
  truncated: boolean;
  bytes: number;
  pages: number;
};

/** The payload a listing gives: the items under their key, and what it did not finish or could not do. */
const payloadOf = (kind: ResourceKind, listing: Listing): JsonObject => {
  const payload: Mutable<JsonObject> = {
    [kind === "resources" ? "resources" : "resource_templates"]: listing.items,
  };

  if (listing.truncated) payload["truncated"] = true;

  if (listing.incomplete.length > 0) payload["incomplete"] = listing.incomplete;

  if (listing.errors.length > 0) payload["errors"] = listing.errors;

  return payload;
};

/** `payload` for the model, cut to its head and spilled whole, and for a script, whole. */
const listResult = async (
  payload: JsonObject,
  details: McpDetails,
  kind: "model" | "script",
  spill: Spill,
  minimal: JsonObject,
): Promise<ToolExecutionResult<JsonValue>> => {
  const text = JSON.stringify(payload);

  if (kind === "script") {
    // SAFETY: a `JsonObject` is JSON, which `JsonValue` describes.
    return { output: [textOf(text)], details, structuredOutput: payload as JsonValue };
  }

  const piece: Piece = { content: textOf(text), note: false };
  const call = { kind: "model", details, spill } as const;
  const limited = await withinLimits([piece], call);
  const kept: Mutable<McpDetails> = { ...details };

  if (limited.fullOutputPath !== undefined) kept.full_output_path = limited.fullOutputPath;

  const result: Mutable<ToolExecutionResult<JsonValue>> = {
    output: [...limited.output],
    details: kept,
    // SAFETY: a `JsonObject` is JSON, which `JsonValue` describes.
    structuredOutput: minimal as JsonValue,
  };

  if (limited.diagnostics.length > 0) result.diagnostics = [...limited.diagnostics];

  return result;
};

type ListArgs = { readonly server?: string; readonly cursor?: string };

/** The list tool for `kind`, over `servers` (those the resource tools reach), at `exposure`. */
const listTool = (
  kind: ResourceKind,
  name: string,
  exposure: Exclude<McpExposure, "hidden">,
  servers: ReadonlyArray<McpBuildServer>,
  client: McpHostClientService,
  origin: McpCallOrigin,
  options: McpToolOptions,
): ToolRegistration => {
  const key = kind === "resources" ? "resources" : "resource_templates";
  const noun = kind === "resources" ? "resources" : "resource templates";
  const op = kind === "resources" ? "resources/list" : "resources/templates/list";

  return {
    name,
    description: [
      `List the ${noun} the owner's MCP servers offer, as JSON under \`${key}\`: each item's \`server\` (the name read_mcp_resource takes), \`uri${kind === "templates" ? "Template" : ""}\`, \`name\`, and its \`title\`, \`description\`, \`mimeType\`${kind === "resources" ? " and `size`" : ""} when it has them.`,
      "Without `server`, every server marked · resources in the mcp_servers section is listed, a page after a page, until 1000 items or 256 KiB; then `truncated` is true and `incomplete` names each server left unfinished, with the `next_cursor` to pass back as `cursor` with that `server`.",
      `A server that could not be listed is an \`errors\` entry. ${kind === "resources" ? "Read a resource with read_mcp_resource; its URI need not be listed." : "A template's URI is filled in and read with read_mcp_resource."}`,
    ].join(" "),
    parameters: Type.Object({
      server: Type.Optional(
        Type.String({
          description: "The server to list, as the mcp_servers section names it; all when absent",
        }),
      ),
      cursor: Type.Optional(
        Type.String({
          description: "A page's `next_cursor`, to continue that server's listing; needs `server`",
        }),
      ),
    }),
    structuredOutputSchema: listSchema(key),
    replay: "safe",
    ...flagsOf(exposure),
    execute: async (args: ListArgs, api, context) => {
      const base = (server: string): McpDetails => ({ server, tool: name });

      if (args.cursor !== undefined && args.server === undefined) {
        return failedWith(
          "`cursor` goes with a `server`: pass the server it came from.",
          base("*"),
        );
      }

      const named = args.server === undefined ? undefined : serverNamed(servers, args.server);

      if (args.server !== undefined && named === undefined) {
        return failedWith(unknownServer(servers, args.server), base("*"));
      }

      const targets = named === undefined ? servers : [named];

      const listing: Listing = {
        items: [],
        incomplete: [],
        errors: [],
        truncated: false,
        bytes: 0,
        pages: 0,
      };

      let kindOfCall: "model" | "script" = "model";
      let single: ToolExecutionResult<JsonValue> | undefined;

      for (const [index, server] of targets.entries()) {
        const shownName = normalizeMcpName(server.name);

        const exchange: Exchange = {
          client,
          origin,
          server,
          options,
          tool: name,
          details: base(server.name),
          subject: "resource",
          remember: false,
        };

        let cursor = index === 0 ? args.cursor : undefined;
        const seen = new Set<string>();

        for (;;) {
          if (listing.pages >= MAX_LISTED_PAGES) {
            listing.truncated = true;
            listing.incomplete.push(
              cursor === undefined
                ? { server: shownName }
                : { server: shownName, next_cursor: cursor },
            );
            break;
          }

          listing.pages += 1;

          const sent = await send(
            exchange,
            api,
            context,
            (workspace) => ({
              op,
              server: server.name,
              params: cursor === undefined ? {} : { cursor },
              ctx: contextOf(
                { ...origin, workspace },
                { callId: api.callId, conversation: String(api.conversationId) },
              ),
            }),
            (value, _completed, who) => {
              kindOfCall = who;

              return Promise.resolve(pageItems(kind, shownName, value));
            },
          );

          if (!sent.ok) {
            // Stop, or a request for one server: the call's own end. Otherwise the server is an error of the listing.
            if (named !== undefined || context.abortSignal?.aborted === true) single = sent.result;
            else listing.errors.push({ server: shownName, error: messageOf(sent.result) });

            break;
          }

          const page = sent.value;

          if (page === undefined) {
            if (named !== undefined) {
              single = failedWith(
                "The server answered with a list this build cannot read",
                exchange.details,
              );
            } else {
              listing.errors.push({
                server: shownName,
                error: "The server answered with a list this build cannot read",
              });
            }

            break;
          }

          const weight = Arr.reduce(page.items, 0, (sum, item) => sum + storedBytes(item));

          const fits =
            listing.items.length + page.items.length <= MAX_LISTED_ITEMS &&
            listing.bytes + weight <= MAX_LISTED_BYTES;

          if (!fits) {
            listing.truncated = true;

            if (listing.items.length === 0) {
              // A page that alone is over the limits is cut to them: no cursor leads into the middle of a page.
              for (const item of page.items) {
                const itemBytes = storedBytes(item);

                if (
                  listing.items.length >= MAX_LISTED_ITEMS ||
                  listing.bytes + itemBytes > MAX_LISTED_BYTES
                )
                  break;

                listing.items.push(item);
                listing.bytes += itemBytes;
              }

              listing.incomplete.push(
                page.nextCursor === undefined
                  ? { server: shownName }
                  : { server: shownName, next_cursor: page.nextCursor },
              );
            } else {
              // Whole pages only: this one is asked for again from where it began.
              listing.incomplete.push(
                cursor === undefined
                  ? { server: shownName }
                  : { server: shownName, next_cursor: cursor },
              );
            }

            break;
          }

          listing.items.push(...page.items);
          listing.bytes += weight;

          if (page.nextCursor === undefined) break;

          // A cursor the server gives twice would never end.
          if (seen.has(page.nextCursor)) break;

          seen.add(page.nextCursor);
          cursor = page.nextCursor;
        }

        if (single !== undefined) return single;

        if (listing.truncated) {
          // The servers after it were not asked.
          for (const later of targets.slice(index + 1)) {
            listing.incomplete.push({ server: normalizeMcpName(later.name) });
          }

          break;
        }
      }

      const details = base(named === undefined ? "*" : named.name);
      const spill = spillTo(api.env, context);
      const minimal: JsonObject = { [key]: [] };

      return listResult(payloadOf(kind, listing), details, kindOfCall, spill, minimal);
    },
  };
};

/** The schema of a list tool's value, for scripts. */
const listSchema = (key: string): JsonObject => ({
  type: "object",
  properties: {
    [key]: {
      type: "array",
      items: {
        type: "object",
        properties: {
          server: { type: "string", description: "The name read_mcp_resource takes" },
          name: { type: "string" },
          uri: { type: "string" },
          uriTemplate: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          mimeType: { type: "string" },
          size: { type: "number" },
          annotations: {},
        },
        required: ["server"],
        additionalProperties: true,
      },
    },
    truncated: { type: "boolean", description: "The listing stopped short of its end" },
    incomplete: {
      type: "array",
      description: "The servers left unfinished, with the cursor to continue each",
      items: {
        type: "object",
        properties: { server: { type: "string" }, next_cursor: { type: "string" } },
        required: ["server"],
        additionalProperties: false,
      },
    },
    errors: {
      type: "array",
      description: "The servers that could not be listed",
      items: {
        type: "object",
        properties: { server: { type: "string" }, error: { type: "string" } },
        required: ["server", "error"],
        additionalProperties: false,
      },
    },
  },
  required: [key],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------------------------------------------------
// Reads

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
const readOf = (
  value: Schema.Json,
): { readonly contents: ReadonlyArray<ReadContent>; readonly unreadable: number } | undefined => {
  const read = decodeRead(value);

  if (Option.isNone(read)) return undefined;

  const decoded = Arr.map(read.value.contents, (entry) => decodeContent(entry));
  const contents = Arr.flatMap(decoded, (entry) => (Option.isSome(entry) ? [entry.value] : []));

  return { contents, unreadable: decoded.length - contents.length };
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
    const entry: Mutable<JsonObject> = { uri: content.uri };

    if (content.mimeType !== undefined) entry["mimeType"] = content.mimeType;

    if ("text" in content) {
      const kept = cutStored(content.text, Math.max(0, left), CUT_MARKER);

      entry["text"] = kept;
      left -= storedBytes(kept);

      if (kept !== content.text) {
        entry["text_truncated"] = true;

        const saved = await spill(content.text, ".txt");

        if ("path" in saved) entry["full_output_path"] = saved.path;
      }

      const ref = refOf(content.uri, "text", part, {
        mimeType: content.mimeType,
        size: utf8ByteLength(content.text),
      });

      if (ref !== undefined) refs.push(ref);
    } else {
      let path: string | undefined;
      let size: number | undefined;

      try {
        const bytes = bytesOf(content.blob);

        size = bytes.length;

        const saved = await spill(bytes, suffixOf(content.uri));

        if ("path" in saved) {
          path = saved.path;
          entry["full_output_path"] = saved.path;
        } else {
          entry["save_error"] = saved.reason;
        }
      } catch {
        entry["save_error"] = "its data is not base64";
      }

      if (size !== undefined) entry["size"] = size;

      const ref = refOf(content.uri, "spill", part, { mimeType: content.mimeType, size, path });

      if (ref !== undefined) refs.push(ref);
    }

    value.push(entry);
  }

  return { value, refs };
};

/** The tool that reads a resource, at `exposure`. */
const readTool = (
  exposure: Exclude<McpExposure, "hidden">,
  servers: ReadonlyArray<McpBuildServer>,
  client: McpHostClientService,
  origin: McpCallOrigin,
  options: McpToolOptions,
): ToolRegistration => {
  const name = "read_mcp_resource";

  return {
    name,
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
    structuredOutputSchema: {
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
    },
    replay: "safe",
    ...flagsOf(exposure),
    execute: async (args: { readonly server: string; readonly uri: string }, api, context) => {
      const target = serverNamed(servers, args.server);

      if (target === undefined) {
        return failedWith(unknownServer(servers, args.server), { server: "*", tool: name });
      }

      const shownName = normalizeMcpName(target.name);
      const details: McpDetails = { server: target.name, tool: name };

      const exchange: Exchange = {
        client,
        origin,
        server: target,
        options,
        tool: name,
        details,
        subject: "resource",
        remember: false,
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
            { ...origin, workspace },
            { callId: api.callId, conversation: String(api.conversationId) },
            answers,
          ),
        }),
        async (value, _completed, kind): Promise<ToolExecutionResult<JsonValue>> => {
          const read = readOf(value);

          if (read === undefined) {
            return failedWith("The server answered with a result this build cannot read", details);
          }

          const spill = spillTo(api.env, context);
          const minimal: JsonObject = { server: shownName, uri: args.uri, contents: [] };

          if (kind === "script") {
            const scripted = await scriptContents(args.uri, read.contents, spill);
            const kept: Mutable<McpDetails> = { ...details };
            const refs = Arr.take(scripted.refs, MAX_RESOURCE_REFS);

            if (refs.length > 0) kept.resources = refs;

            const result: JsonObject = {
              server: shownName,
              uri: args.uri,
              contents: scripted.value,
            };

            return {
              output: [textOf(`Read ${oneLine(args.uri, 200)}`)],
              details: kept,
              // SAFETY: a `JsonObject` is JSON, which `JsonValue` describes.
              structuredOutput: result as JsonValue,
            };
          }

          const blocks = Arr.map(read.contents, (resource) => ({ type: "resource", resource }));
          const grouped = await modelBlocks(blocks, spill);

          const pieces: ReadonlyArray<Piece> = Arr.flatMap(grouped, (group, index) => {
            const content = read.contents[index];

            // Each item of several is named, so the model can tell where one ends.
            return read.contents.length > 1 && content !== undefined
              ? [{ content: textOf(`${oneLine(content.uri, 2048)}:`), note: true }, ...group]
              : group;
          });

          const extra: ReadonlyArray<Piece> =
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

          const shown: ReadonlyArray<Piece> = [...pieces, ...extra];

          const whole: ReadonlyArray<Piece> =
            shown.length > 0
              ? shown
              : [{ content: textOf(`[${oneLine(args.uri, 2048)} has no contents]`), note: true }];

          const limited = await withinLimits(whole, { kind: "model", details, spill });
          const kept: Mutable<McpDetails> = { ...details };
          const refs = refsOf(whole);

          if (limited.fullOutputPath !== undefined) kept.full_output_path = limited.fullOutputPath;

          if (refs.length > 0) kept.resources = refs;

          const result: Mutable<ToolExecutionResult<JsonValue>> = {
            output: [...limited.output],
            details: kept,
            // SAFETY: a `JsonObject` is JSON, which `JsonValue` describes.
            structuredOutput: minimal as JsonValue,
          };

          if (limited.diagnostics.length > 0) result.diagnostics = [...limited.diagnostics];

          return result;
        },
      );

      return sent.ok ? withElicitation(sent.value, sent.asked) : sent.result;
    },
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// Registration

/** How wide an Exposure reaches: `direct` is in the tool list, `deferred` is reached by `tool_search` and scripts, `codemode` by scripts. */
const REACH: Record<Exclude<McpExposure, "hidden">, number> = {
  codemode: 1,
  deferred: 2,
  direct: 3,
};

/**
 * The Exposure of resource tool `name`: the widest of those the servers give it. Each server's own `exposure` counts, not
 * its `toolExposure` (which names its own tools), and `tools.offered` lifts the tool to `direct` as it does any other.
 */
const widestExposure = (
  servers: ReadonlyArray<McpBuildServer>,
  name: string,
  offered: ReadonlyArray<string>,
): Exclude<McpExposure, "hidden"> => {
  let widest: Exclude<McpExposure, "hidden"> = "codemode";

  for (const server of servers) {
    const { exposure } = resolveExposure({
      server: { exposure: exposureKeys(server).exposure, toolExposure: {} },
      tool: name,
      modelName: name,
      offered,
    });

    if (exposure !== "hidden" && REACH[exposure] > REACH[widest]) widest = exposure;
  }

  return widest;
};

/**
 * The resource tools of `build`: none unless the host lists `resources` and a server the tools reach has resources.
 * Built purely from the inventory and the offered tools, so equal builds give byte-identical declarations.
 */
export const resourceTools = (
  build: McpBuild,
  client: McpHostClientService,
  origin: McpCallOrigin,
  options: McpToolOptions,
): ReadonlyArray<ToolRegistration> => {
  if (!(build.features ?? []).includes(MCP_RESOURCE_FEATURE)) return [];

  const servers = Arr.filter(build.servers, hasResources);

  if (servers.length === 0) return [];

  const exposureOf = (name: string) => widestExposure(servers, name, build.offered);

  const [listName, templatesName, readName] = MCP_RESOURCE_TOOL_NAMES;

  return [
    listTool(
      "resources",
      listName ?? "list_mcp_resources",
      exposureOf(listName ?? ""),
      servers,
      client,
      origin,
      options,
    ),
    listTool(
      "templates",
      templatesName ?? "list_mcp_resource_templates",
      exposureOf(templatesName ?? ""),
      servers,
      client,
      origin,
      options,
    ),
    readTool(exposureOf(readName ?? ""), servers, client, origin, options),
  ];
};
