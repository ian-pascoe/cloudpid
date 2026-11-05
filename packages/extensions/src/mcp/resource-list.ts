// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off -- builders over plain values,
// and pi-durable's Promise-based tool seam.
// `list_mcp_resources` and `list_mcp_resource_templates` (`docs/architecture/mcp-in-a-session.md` → Resource tools):
// the host answers one page at a time (`resources/list`, `resources/templates/list`: it keeps a Modern server's page for
// its `ttlMs`), and the Session joins the pages of one or every server within `MAX_LISTED_ITEMS` and `MAX_LISTED_BYTES`:
// whole pages only, `truncated` when it stopped short and `incomplete: [{ server, next_cursor? }]` for each server it left
// unfinished, the `next_cursor` going back in with that server. A page that fails is an `errors` entry for an all-server
// listing and the call's error for one server's. `ui://` and `profile=mcp-app` resources are left out, `icons` and
// `_meta` dropped, `annotations` passed through.
import { type McpExposure, normalizeMcpName } from "@cloudpid/config";
import { type JsonObject, MCP_APP_PROFILE } from "@cloudpid/mcp/types";
import type { JsonValue } from "@earendil-works/chord";
import type { ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { isAppResourceUri } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { oneLine, textOf } from "./blocks.ts";
import type { McpHostClientService } from "./client.ts";
import type { McpDetails } from "./details.ts";
import {
  type Caller,
  contextOf,
  type Exchange,
  type McpCallOrigin,
  type McpToolOptions,
  send,
} from "./exchange.ts";
import { flagsOf } from "./exposure.ts";
import { serverNamed, unknownServer } from "./resource-targets.ts";
import { failedWith, modelResultOf, scriptResultOf } from "./result.ts";
import { spillTo } from "./spill.ts";
import type { McpBuildServer } from "./tools.ts";
import { storedBytes } from "../stored-bytes.ts";
import { obj, opt, str } from "@earendil-works/pi-schema";

/** The most items one listing holds, across servers. */
export const MAX_LISTED_ITEMS = 1000;

/** The most one listing's items weigh, stored as JSON in UTF-8 bytes, across servers. */
export const MAX_LISTED_BYTES = 256 * 1024;

/** The most pages one listing asks the host for, so a server whose cursors never end cannot hold the call. */
const MAX_LISTED_PAGES = 50;

/** What a list tool lists: a server's resources, or its resource templates. */
type Listed = "resources" | "templates";

type ListArgs = { readonly server?: string; readonly cursor?: string };

// ---------------------------------------------------------------------------------------------------------------------
// Pages

/** `ui://` and `profile=mcp-app` resources are an App's, which the lists leave out (`docs/architecture/mcp-apps.md`). */
export const isAppResource = (uri: string, mimeType: string | undefined): boolean =>
  isAppResourceUri(uri) ||
  (mimeType?.toLowerCase().replaceAll(" ", "").includes(MCP_APP_PROFILE) ?? false);

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

/** A page: its visible items, and where the next one is. */
type Page = { readonly items: ReadonlyArray<JsonObject>; readonly nextCursor?: string };

/** The visible item of one entry of a page, none for one an App's or one this build cannot read. */
const itemOf = (what: Listed, server: string, entry: Schema.Json): ReadonlyArray<JsonObject> => {
  if (what === "resources") {
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
};

/** A page's visible items under `server`'s name, and its cursor: an App's resources, `icons` and `_meta` are left out. */
const pageOf = (what: Listed, server: string, value: Schema.Json): Page | undefined => {
  const page = decodePage(value);

  if (Option.isNone(page)) return undefined;

  const entries =
    (what === "resources" ? page.value.resources : page.value.resourceTemplates) ?? [];

  const items = Arr.flatMap(entries, (entry) => itemOf(what, server, entry));

  return page.value.nextCursor === undefined
    ? { items }
    : { items, nextCursor: page.value.nextCursor };
};

// ---------------------------------------------------------------------------------------------------------------------
// The listing

/** A server the listing left unfinished, and the cursor to go on from. */
type Unfinished = { readonly server: string; readonly next_cursor?: string };

/** What a listing has gathered so far, and what it left unfinished. */
type Listing = {
  readonly items: Array<JsonObject>;
  readonly incomplete: Array<Unfinished>;
  readonly errors: Array<{ readonly server: string; readonly error: string }>;
  truncated: boolean;
  bytes: number;
  pages: number;
};

/** `server` unfinished from `cursor`: no cursor for a server not asked, or asked from its start. */
const unfinished = (server: string, cursor: string | undefined): Unfinished =>
  cursor === undefined ? { server } : { server, next_cursor: cursor };

/** The first line of what a failed request says, for an `errors` entry. */
const messageOf = (result: ToolExecutionResult<JsonValue>): string => {
  const first = result.output?.[0];

  return first?.type === "text" ? oneLine(first.text, 500) : "The request failed";
};

/** The payload a listing gives: the items under their key, and what it did not finish or could not do. */
const payloadOf = (what: Listed, listing: Listing): JsonObject => {
  const payload: Mutable<JsonObject> = {
    [what === "resources" ? "resources" : "resource_templates"]: listing.items,
  };

  if (listing.truncated) payload["truncated"] = true;

  if (listing.incomplete.length > 0) payload["incomplete"] = listing.incomplete;

  if (listing.errors.length > 0) payload["errors"] = listing.errors;

  return payload;
};

/** Adds as many of `page`'s items as the limits leave room for, and says whether it was all of them. */
const addPage = (listing: Listing, server: string, cursor: string | undefined, page: Page) => {
  const weight = Arr.reduce(page.items, 0, (sum, item) => sum + storedBytes(item));

  const fits =
    listing.items.length + page.items.length <= MAX_LISTED_ITEMS &&
    listing.bytes + weight <= MAX_LISTED_BYTES;

  if (fits) {
    listing.items.push(...page.items);
    listing.bytes += weight;

    return true;
  }

  listing.truncated = true;

  // Whole pages only: this one is asked for again from where it began.
  if (listing.items.length > 0) {
    listing.incomplete.push(unfinished(server, cursor));

    return false;
  }

  // A page that alone is over the limits is cut to them: no cursor leads into the middle of a page.
  for (const item of page.items) {
    const itemBytes = storedBytes(item);

    if (listing.items.length >= MAX_LISTED_ITEMS || listing.bytes + itemBytes > MAX_LISTED_BYTES) {
      break;
    }

    listing.items.push(item);
    listing.bytes += itemBytes;
  }

  listing.incomplete.push(unfinished(server, page.nextCursor));

  return false;
};

/** What a list tool is made of: what it lists and how it reaches the servers. */
type ListTool = {
  readonly what: Listed;
  readonly name: string;
  readonly servers: ReadonlyArray<McpBuildServer>;
  readonly client: McpHostClientService;
  readonly origin: McpCallOrigin;
  readonly options: McpToolOptions;
};

/** The state of one call: what its servers are listed into, and who it is for. */
type Walk = {
  readonly tool: ListTool;
  readonly listing: Listing;
  /** Set when the call asked for one server, whose failure is then the call's own. */
  readonly only: McpBuildServer | undefined;
  /** Whether the call is a model's or a script's, as the last page said. */
  caller: Caller;
  /** The call's own end, when a request for its one server failed or Stop came. */
  ended: ToolExecutionResult<JsonValue> | undefined;
};

/** Lists `server` into the walk, a page at a time from `from`, until its end, a limit or a failure. */
const walkServer = async (
  walk: Walk,
  server: McpBuildServer,
  from: string | undefined,
  api: Parameters<ToolRegistration["execute"]>[1],
  context: Parameters<ToolRegistration["execute"]>[2],
): Promise<void> => {
  const { tool, listing } = walk;
  const shown = normalizeMcpName(server.name);

  const exchange: Exchange = {
    client: tool.client,
    origin: tool.origin,
    server,
    options: tool.options,
    tool: tool.name,
    details: { server: server.name, tool: tool.name },
    subject: "resource",
  };

  /** A server that could not be listed: the call's own end when it is the one asked for, else an entry of the listing. */
  const failed = (result: ToolExecutionResult<JsonValue>) => {
    if (walk.only !== undefined || context.abortSignal?.aborted === true) walk.ended = result;
    else listing.errors.push({ server: shown, error: messageOf(result) });
  };

  const op = tool.what === "resources" ? "resources/list" : "resources/templates/list";
  // The cursor the listing starts from is one the server must not lead back to.
  const seen = new Set<string>(from === undefined ? [] : [from]);
  let cursor = from;

  for (;;) {
    if (listing.pages >= MAX_LISTED_PAGES) {
      listing.truncated = true;
      listing.incomplete.push(unfinished(shown, cursor));

      return;
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
          { ...tool.origin, workspace },
          { callId: api.callId, conversation: String(api.conversationId) },
        ),
      }),
      (value, _completed, caller) => {
        walk.caller = caller;

        return Promise.resolve(pageOf(tool.what, shown, value));
      },
    );

    if (!sent.ok) return failed(sent.result);

    if (sent.value === undefined) {
      return failed(
        failedWith("The server answered with a list this build cannot read", exchange.details),
      );
    }

    if (!addPage(listing, shown, cursor, sent.value)) return;

    const { nextCursor } = sent.value;

    if (nextCursor === undefined) return;

    // A cursor the server gives twice would never end: this server's listing fails as a failed page does, and the
    // next server is listed. What its earlier pages gave stays.
    if (seen.has(nextCursor)) {
      return failed(
        failedWith("The server's pages repeat a cursor, so its listing stopped", exchange.details),
      );
    }

    seen.add(nextCursor);
    cursor = nextCursor;
  }
};

/** The script's value for a list: its payload. The model's own is the minimal one that fits the schema. */
const resultOf = (
  walk: Walk,
  details: McpDetails,
  spill: ReturnType<typeof spillTo>,
): Promise<ToolExecutionResult<JsonValue>> | ToolExecutionResult<JsonValue> => {
  const payload = payloadOf(walk.tool.what, walk.listing);
  // SAFETY: a `JsonObject` is JSON, which `JsonValue` describes.
  const value = payload as JsonValue;
  const text = JSON.stringify(payload);

  if (walk.caller === "script") return scriptResultOf(text, details, value);

  const key = walk.tool.what === "resources" ? "resources" : "resource_templates";

  return modelResultOf(
    [{ content: textOf(text), note: false }],
    { kind: "model", details, spill },
    { [key]: [] },
  );
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

const describe = (what: Listed): string => {
  const templates = what === "templates";
  const noun = templates ? "resource templates" : "resources";
  const key = templates ? "resource_templates" : "resources";

  return [
    `List the ${noun} the owner's MCP servers offer, as JSON under \`${key}\`: each item's \`server\` (the name read_mcp_resource takes), \`uri${templates ? "Template" : ""}\`, \`name\`, and its \`title\`, \`description\`, \`mimeType\`${templates ? "" : " and `size`"} when it has them.`,
    "Without `server`, every server marked · resources in the mcp_servers section is listed, a page after a page, until 1000 items or 256 KiB; then `truncated` is true and `incomplete` names each server left unfinished, with the `next_cursor` to pass back as `cursor` with that `server`.",
    `A server that could not be listed is an \`errors\` entry. ${templates ? "A template's URI is filled in and read with read_mcp_resource." : "Read a resource with read_mcp_resource; its URI need not be listed."}`,
  ].join(" ");
};

/** The list tool for `tool.what`, over the servers the resource tools reach, at `exposure`. */
export const listTool = (
  tool: ListTool,
  exposure: Exclude<McpExposure, "hidden">,
): ToolRegistration => ({
  name: tool.name,
  description: describe(tool.what),
  parameters: obj({
    server: opt(
      str({
        description: "The server to list, as the mcp_servers section names it; all when absent",
      }),
    ),
    cursor: opt(
      str({
        description: "A page's `next_cursor`, to continue that server's listing; needs `server`",
      }),
    ),
  }),
  structuredOutputSchema: listSchema(
    tool.what === "resources" ? "resources" : "resource_templates",
  ),
  replay: "safe",
  ...flagsOf(exposure),
  execute: async (args: ListArgs, api, context) => {
    const wholeCall: McpDetails = { server: "*", tool: tool.name };

    if (args.cursor !== undefined && args.server === undefined) {
      return failedWith("`cursor` goes with a `server`: pass the server it came from.", wholeCall);
    }

    const only = args.server === undefined ? undefined : serverNamed(tool.servers, args.server);

    if (args.server !== undefined && only === undefined) {
      return failedWith(unknownServer(tool.servers, args.server), wholeCall);
    }

    const walk: Walk = {
      tool,
      listing: { items: [], incomplete: [], errors: [], truncated: false, bytes: 0, pages: 0 },
      only,
      caller: "model",
      ended: undefined,
    };

    const targets = only === undefined ? tool.servers : [only];

    for (const [index, server] of targets.entries()) {
      await walkServer(walk, server, index === 0 ? args.cursor : undefined, api, context);

      if (walk.ended !== undefined) return walk.ended;

      if (walk.listing.truncated) {
        // The servers after it were not asked.
        for (const later of targets.slice(index + 1)) {
          walk.listing.incomplete.push(unfinished(normalizeMcpName(later.name), undefined));
        }

        break;
      }
    }

    const details: McpDetails =
      only === undefined ? wholeCall : { server: only.name, tool: tool.name };

    return resultOf(walk, details, spillTo(api.env, context));
  },
});
