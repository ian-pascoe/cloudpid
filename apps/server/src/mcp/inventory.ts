// The MCP inventory (`docs/architecture/mcp-connections.md` → Storage, Discovery and the MCP inventory): what a
// discovery keeps of a server, its bounds and problems, and the content-hash versions a Session rebuilds from. Pure: the
// host stores what `inventoryRows` gives and reads it back with `readInventory`.
//
// A discovery's tools are kept in list order, less those a Session must not register (an invalid `x-mcp-header`,
// `xMcpHeaderProblems`, on a Modern server; a Legacy tool whose `execution.taskSupport` is `"required"`) and those past
// the bounds (500 tools, 1 MiB of declarations), each with a problem; a tool whose schema the engine could not compile
// is kept, with its problem. Every part is stored as canonical JSON (keys sorted), so one content has one text and one
// hash, and a flip back brings the old version back.
// @effect-diagnostics missingPipeableSignature:off -- pure functions over plain values, not combinators.
import { sha256Hex, sortedJson } from "@cloudpid/config";
import {
  isJsonObject,
  type JsonObject,
  type McpEngineDiscovered,
  McpEra,
  McpInventoryProblem,
  type McpServerState,
  type McpToolDefinition,
  xMcpHeaderProblems,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import type { InventoryRows } from "./store.ts";
import { DAY_MS, MINUTE_MS } from "./time.ts";

/** Per server: at most 500 tools and 1 MiB of their declarations, in list order. */
export const MAX_TOOLS = 500;

export const MAX_TOOL_BYTES = 1024 * 1024;

/** A tool's description is cut at 4,000 characters. */
export const MAX_DESCRIPTION = 4000;

/** `instructions` are kept up to 16 KiB. */
export const MAX_INSTRUCTIONS_BYTES = 16 * 1024;

/** At most 100 prompts and 64 KiB of their metadata. */
export const MAX_PROMPTS = 100;

export const MAX_PROMPT_BYTES = 64 * 1024;

/** How long a list stays fresh: a Modern server's `ttlMs`, at least a minute and at most 24 h, else 10 min. */
export const DEFAULT_TTL_MS = 10 * MINUTE_MS;

export const MIN_TTL_MS = MINUTE_MS;

export const MAX_TTL_MS = DAY_MS;

const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

/** The `meta` part: what the server is, when and where it was discovered, until when it is fresh, and the problems. */
const InventoryMeta = Schema.Struct({
  era: McpEra,
  protocolVersion: Schema.String,
  serverInfo: Schema.optionalKey(JsonObjectSchema),
  instructions: Schema.optionalKey(Schema.String),
  capabilities: JsonObjectSchema,
  discoveredAt: Schema.Finite,
  discoveredIn: Schema.optionalKey(Schema.String),
  ttlUntil: Schema.Finite,
  problems: Schema.Array(McpInventoryProblem),
});

export type InventoryMeta = typeof InventoryMeta.Type;

/** A stored inventory, read back: its parts and the hashes of the tools and prompts parts. */
export type Inventory = {
  readonly tools: ReadonlyArray<JsonObject>;
  readonly prompts: ReadonlyArray<JsonObject>;
  readonly meta: InventoryMeta;
  readonly toolsPartHash: string;
  readonly promptsPartHash: string;
};

const utf8 = new TextEncoder();

const bytesOf = (value: Schema.Json): number => utf8.encode(JSON.stringify(value)).length;

/** `value` as canonical JSON text: every object's keys in order. */
export const canonicalJson = (value: Schema.Json): string => JSON.stringify(sortedJson(value));

/** `value` as a stored part: its canonical text and the SHA-256 of it. */
const toStoredPart = (value: Schema.Json) => {
  const json = canonicalJson(value);

  return { json, hash: sha256Hex(json) };
};

/** `text` cut to `limit` bytes of UTF-8, never inside a character. */
const cutToBytes = (text: string, limit: number): string => {
  if (utf8.encode(text).length <= limit) return text;

  let cut = text.slice(0, limit);

  while (utf8.encode(cut).length > limit) cut = cut.slice(0, -1);

  return cut;
};

/** A tool with its description cut to `MAX_DESCRIPTION`. */
const withDescriptionCut = (tool: McpToolDefinition): McpToolDefinition =>
  Predicate.isString(tool.description) && tool.description.length > MAX_DESCRIPTION
    ? { ...tool, description: tool.description.slice(0, MAX_DESCRIPTION) }
    : tool;

/** Whether `tool` declares the experimental `execution.taskSupport: "required"`. */
const requiresTasks = (tool: McpToolDefinition): boolean => {
  const { execution } = tool;

  return isJsonObject(execution) && execution.taskSupport === "required";
};

/** Why a Session must not register `tool` on a server of `era`, if it must not. */
const refusal = (tool: McpToolDefinition, era: McpEra): Option.Option<string> => {
  const headers = era === "modern" ? xMcpHeaderProblems(tool.inputSchema) : [];

  if (headers.length > 0) return Option.some(Arr.join(headers, "; "));

  return era === "legacy" && requiresTasks(tool)
    ? Option.some("it requires the experimental tasks, which a Legacy server is not offered")
    : Option.none();
};

/** The first items of `items` within `count` and `bytes`, in order, and how many were left out. */
const takeWithinBounds = <A extends Schema.Json>(
  items: ReadonlyArray<A>,
  count: number,
  bytes: number,
) => {
  const kept: Array<A> = [];
  let used = 0;

  for (const item of items) {
    const size = bytesOf(item);

    if (kept.length >= count || used + size > bytes) break;

    kept.push(item);
    used += size;
  }

  return { kept, dropped: items.length - kept.length };
};

/** How long `discovered`'s lists stay fresh. */
const ttlOf = (discovered: McpEngineDiscovered): number =>
  discovered.era === "modern" && discovered.ttlMs !== undefined
    ? Math.min(Math.max(discovered.ttlMs, MIN_TTL_MS), MAX_TTL_MS)
    : DEFAULT_TTL_MS;

/**
 * The rows a discovery stores, its bounds applied and its problems found. Its lists stay fresh from `now`, the host's
 * time of keeping them, so the engine's clock never decides a TTL.
 */
export const inventoryRows = (discovered: McpEngineDiscovered, now: number): InventoryRows => {
  const named = Arr.map(discovered.tools, withDescriptionCut);

  const refused = Arr.filterMap(named, (tool) =>
    Option.match(refusal(tool, discovered.era), {
      onNone: () => Result.failVoid,
      onSome: (problem) => Result.succeed({ tool: tool.name, problem }),
    }),
  );

  const refusedNames = new Set(Arr.map(refused, (each) => each.tool));
  const offered = Arr.filter(named, (tool) => !refusedNames.has(tool.name));
  const tools = takeWithinBounds(offered, MAX_TOOLS, MAX_TOOL_BYTES);
  const prompts = takeWithinBounds(discovered.prompts, MAX_PROMPTS, MAX_PROMPT_BYTES);

  const instructions =
    discovered.instructions === undefined
      ? undefined
      : cutToBytes(discovered.instructions, MAX_INSTRUCTIONS_BYTES);

  const problems: Array<McpInventoryProblem> = [
    ...Arr.map(refused, ({ tool, problem }) => ({ tool, problem: `not offered: ${problem}` })),
    ...Arr.map(discovered.problems, ({ tool, problem }) => ({ tool, problem })),
    ...(tools.dropped > 0
      ? [
          {
            problem: `${tools.dropped} tools past the bound (${MAX_TOOLS} tools, 1 MiB of declarations) were left out`,
          },
        ]
      : []),
    ...(prompts.dropped > 0
      ? [
          {
            problem: `${prompts.dropped} prompts past the bound (${MAX_PROMPTS} prompts, 64 KiB) were left out`,
          },
        ]
      : []),
    ...(instructions !== undefined && instructions !== discovered.instructions
      ? [{ problem: "instructions over 16 KiB were cut" }]
      : []),
  ];

  const meta: Mutable<InventoryMeta> = {
    era: discovered.era,
    protocolVersion: discovered.protocolVersion,
    capabilities: discovered.capabilities,
    discoveredAt: discovered.fetchedAt,
    ttlUntil: now + ttlOf(discovered),
    problems,
  };

  if (discovered.serverInfo !== undefined) meta.serverInfo = discovered.serverInfo;

  if (instructions !== undefined) meta.instructions = instructions;

  return {
    tools: toStoredPart(tools.kept),
    prompts: toStoredPart(prompts.kept),
    meta: toStoredPart(meta),
  };
};

const decodeTools = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(JsonObjectSchema)),
);

const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(InventoryMeta));

/** A stored inventory, or none when a part no longer reads (it is discovered again). */
export const readInventory = (rows: InventoryRows): Option.Option<Inventory> =>
  Option.all({
    tools: decodeTools(rows.tools.json),
    prompts: decodeTools(rows.prompts.json),
    meta: decodeMeta(rows.meta.json),
  }).pipe(
    Option.map((read) => ({
      ...read,
      toolsPartHash: rows.tools.hash,
      promptsPartHash: rows.prompts.hash,
    })),
  );

/** The coarse state the version covers: an inventory, being connected, or waiting for a sign-in. */
const coarseState = (inventory: Option.Option<Inventory>, state: McpServerState) => {
  if (Option.isSome(inventory)) return "inventory";

  return state === "sign_in" || state === "rejected" ? "sign_in" : "connecting";
};

/** A server, as the versions cover it. */
export type VersionedServer = {
  readonly name: string;
  /** The entry's hash: every key of its config, those that shape tools included. */
  readonly entryHash: string;
  readonly state: McpServerState;
  readonly inventory: Option.Option<Inventory>;
};

const hash128 = (value: Schema.Json): string => sha256Hex(canonicalJson(value)).slice(0, 32);

const isToolProblem = (problem: McpInventoryProblem) => problem.prompt === undefined;

const isPromptProblem = (problem: McpInventoryProblem) => problem.tool === undefined;

/** The server's own problems and its tools', which its `toolsHash` covers. */
const toolsProjection = (server: VersionedServer): Schema.Json => ({
  entry: server.entryHash,
  state: coarseState(server.inventory, server.state),
  ...Option.match(server.inventory, {
    onNone: () => ({}),
    onSome: (inventory) => ({
      tools: inventory.toolsPartHash,
      instructions: inventory.meta.instructions ?? null,
      problems: Arr.filter(inventory.meta.problems, isToolProblem),
      resources: Predicate.hasProperty(inventory.meta.capabilities, "resources"),
    }),
  }),
});

const promptsProjection = (server: VersionedServer): Schema.Json => ({
  entry: server.entryHash,
  ...Option.match(server.inventory, {
    onNone: () => ({}),
    onSome: (inventory) => ({
      prompts: inventory.promptsPartHash,
      problems: Arr.filter(inventory.meta.problems, isPromptProblem),
    }),
  }),
});

/** A server's `toolsHash` and `promptsHash`: 128 bits of SHA-256 over what each covers. */
export const serverHashes = (server: VersionedServer) => ({
  toolsHash: hash128(toolsProjection(server)),
  promptsHash: hash128(promptsProjection(server)),
});

/**
 * The inventory's `version` and `promptsVersion` over the servers in the set's order: each covers every server's name
 * and hash, so any change to a server's tools (or prompts) changes it, and a flip back brings the old one back.
 */
export const inventoryVersions = (servers: ReadonlyArray<VersionedServer>) => {
  const hashed = Arr.map(servers, (server) => ({ name: server.name, ...serverHashes(server) }));

  return {
    version: hash128(Arr.map(hashed, ({ name, toolsHash }) => [name, toolsHash])),
    promptsVersion: hash128(Arr.map(hashed, ({ name, promptsHash }) => [name, promptsHash])),
  };
};
