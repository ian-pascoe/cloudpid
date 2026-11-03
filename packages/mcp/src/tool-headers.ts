/**
 * `xMcpHeaderProblems`: what is wrong with a tool's `x-mcp-header` declarations (SEP-2243, `2026-07-28` Streamable
 * HTTP, "Schema Extension"), re-exported by `@cloudpid/mcp/types`, so it never loads the SDK.
 *
 * A Modern client MUST leave out a tool whose declarations break the spec's rules, so `McpHost`'s discovery does not
 * register one, and lists why as the tool's problem (`docs/architecture/mcp-connections.md` → Discovery and the MCP
 * inventory; `mcp-in-a-session.md` → Exposure). The rules are the SDK's own (`scanXMcpHeaderDeclarations`, which its
 * `listTools` applies but the core's `list` does not, since it lists through `client.request`): a declaration is a
 * non-empty RFC 9110 token, case-insensitively unique, on a `string`, `integer` or `boolean` property reached from the
 * root through `properties` alone; one anywhere else (under `items`, `oneOf`, `$defs`…) makes the tool invalid.
 */
// @effect-diagnostics missingPipeableSignature:off -- a check over a plain value, not a combinator.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import { isJsonObject, type JsonObject } from "./json.ts";

const X_MCP_HEADER = "x-mcp-header";

/** RFC 9110 §5.1 `token`: no space, control character or delimiter. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** The JSON Schema types a declaration may sit on; `number` is not one. */
const PRIMITIVE_TYPES: ReadonlyArray<string> = ["string", "integer", "boolean"];

/** Keywords whose subschemas a `properties` chain never passes through: a declaration under one is invalid. */
const UNREACHABLE_KEYWORDS: ReadonlyArray<string> = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "patternProperties",
  "dependentSchemas",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$defs",
  "definitions",
];

/** Of those, the ones whose value maps names to subschemas. */
const NAMED_KEYWORDS: ReadonlyArray<string> = [
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
];

const isJsonArray = (value: Schema.Json): value is ReadonlyArray<Schema.Json> => Arr.isArray(value);

const pathName = (path: ReadonlyArray<string>): string =>
  path.length === 0 ? "<root>" : Arr.join(path, ".");

/** A header declared at `path`, for the uniqueness check. */
interface Declared {
  readonly header: string;
  readonly path: ReadonlyArray<string>;
}

/** What a part of a schema declares, and the problems found in it. */
interface Scan {
  readonly declared: ReadonlyArray<Declared>;
  readonly problems: ReadonlyArray<string>;
}

const scanOf = (declared: ReadonlyArray<Declared>, problems: ReadonlyArray<string>): Scan => ({
  declared,
  problems,
});

/** The declaration `node` makes itself, if any, and its own problems. */
const declarationAt = (node: JsonObject, path: ReadonlyArray<string>, reachable: boolean): Scan => {
  if (!(X_MCP_HEADER in node)) return scanOf([], []);

  const at = pathName(path);

  if (!reachable || path.length === 0) {
    return scanOf(
      [],
      [`${at}: x-mcp-header is only allowed on a property reached through 'properties' alone`],
    );
  }

  const header = node[X_MCP_HEADER];

  if (!Predicate.isString(header) || header.length === 0) {
    return scanOf([], [`${at}: x-mcp-header must be a non-empty string`]);
  }

  if (!TOKEN.test(header)) {
    return scanOf([], [`${at}: x-mcp-header '${header}' is not an HTTP token`]);
  }

  const type = Predicate.isString(node.type) ? node.type : undefined;

  return scanOf(
    [{ header, path }],
    type !== undefined && PRIMITIVE_TYPES.includes(type)
      ? []
      : [
          `${at}: x-mcp-header is only allowed on a string, integer or boolean (got ${type ?? "none"})`,
        ],
  );
};

/** The subschemas of `node` under `keyword`: one, a list, or a map of them. */
const branchesOf = (node: JsonObject, keyword: string): ReadonlyArray<Schema.Json> => {
  const sub = node[keyword];

  if (sub === undefined) return [];

  if (isJsonArray(sub)) return sub;

  return isJsonObject(sub) && NAMED_KEYWORDS.includes(keyword) ? Record.values(sub) : [sub];
};

/** Every declaration under `node` and every problem with one, walking `properties` and the unreachable keywords. */
const walk = (node: Schema.Json, path: ReadonlyArray<string>, reachable: boolean): Scan => {
  if (!isJsonObject(node)) return scanOf([], []);

  const { properties } = node;

  const scans = [
    declarationAt(node, path, reachable),
    ...(isJsonObject(properties)
      ? Arr.map(Record.toEntries(properties), ([key, child]) =>
          walk(child, [...path, key], reachable),
        )
      : []),
    ...Arr.flatMap(UNREACHABLE_KEYWORDS, (keyword) =>
      Arr.map(branchesOf(node, keyword), (branch) =>
        walk(branch, [...path, `<${keyword}>`], false),
      ),
    ),
  ];

  return scanOf(
    Arr.flatMap(scans, (scan) => scan.declared),
    Arr.flatMap(scans, (scan) => scan.problems),
  );
};

/** A header declared again, case-insensitively, after an earlier declaration. */
const duplicateProblem = (
  declared: ReadonlyArray<Declared>,
  each: Declared,
  index: number,
): Option.Option<string> =>
  Arr.findFirst(
    Arr.take(declared, index),
    (earlier) => earlier.header.toLowerCase() === each.header.toLowerCase(),
  ).pipe(
    Option.map(
      (earlier) =>
        `${pathName(each.path)}: x-mcp-header '${each.header}' is also declared as '${earlier.header}'`,
    ),
  );

/**
 * What is wrong with the `x-mcp-header` declarations of a tool's `inputSchema`: empty when nothing is (no declaration
 * is fine), else one line per problem, naming the property. A tool with any problem is left out.
 */
export const xMcpHeaderProblems = (inputSchema: Schema.Json): ReadonlyArray<string> => {
  const { declared, problems } = walk(inputSchema, [], true);

  return [
    ...problems,
    ...Arr.getSomes(Arr.map(declared, (each, index) => duplicateProblem(declared, each, index))),
  ];
};

/** The prefix of a header that mirrors a tool argument. */
const PARAM_HEADER_PREFIX = "Mcp-Param-";

const BASE64_SENTINEL_PREFIX = "=?base64?";

const BASE64_SENTINEL_SUFFIX = "?=";

/** An argument's value as header text: a string, a boolean or a safe integer; anything else is no header. */
const primitiveText = (value: Schema.Json | undefined): string | undefined => {
  if (Predicate.isString(value)) return value;

  if (Predicate.isBoolean(value)) return value ? "true" : "false";

  if (Predicate.isNumber(value) && Number.isSafeInteger(value)) return String(value);

  return undefined;
};

/** Whether `text` cannot go in a header as it is: empty, padded, outside printable ASCII, or looking like an encoding. */
const needsBase64 = (text: string): boolean => {
  if (text.length === 0) return true;

  if (text.startsWith(BASE64_SENTINEL_PREFIX) && text.endsWith(BASE64_SENTINEL_SUFFIX)) return true;

  if (text !== text.trim()) return true;

  return Arr.some(Arr.fromIterable(text), (char) => {
    const code = char.codePointAt(0) ?? 0;

    return code !== 9 && (code < 32 || code > 126);
  });
};

/** `text` as a header value: as it is, or `=?base64?<UTF-8 in base64>?=`. */
const encodeHeaderValue = (text: string): string => {
  if (!needsBase64(text)) return text;

  const binary = Arr.join(
    Arr.map(Arr.fromIterable(new TextEncoder().encode(text)), (byte) => String.fromCodePoint(byte)),
    "",
  );

  return `${BASE64_SENTINEL_PREFIX}${btoa(binary)}${BASE64_SENTINEL_SUFFIX}`;
};

/** The value at `path` in `root`, if every step is an object that has it. */
const valueAt = (root: Schema.Json, path: ReadonlyArray<string>): Schema.Json | undefined => {
  let node: Schema.Json | undefined = root;

  for (const key of path) {
    if (node === undefined || !isJsonObject(node)) return undefined;

    node = node[key];
  }

  return node;
};

/**
 * The `Mcp-Param-<Name>` headers a Modern `tools/call` carries (SEP-2243): for each property of the tool's
 * `inputSchema` that declares `x-mcp-header`, its value in `args`, as it is or base64-wrapped when it is not plain
 * ASCII. A property that is absent, `null` or not a string, boolean or safe integer has no header. The core sends a
 * task-capable call on a transport of its own, which has to build them as the SDK's client does for any other
 * (`docs/architecture/mcp-server-requests.md` → MCP tasks, The wire).
 */
export const xMcpHeaders = (
  inputSchema: Schema.Json,
  args: Schema.Json,
): Readonly<Record<string, string>> => {
  const { declared } = walk(inputSchema, [], true);

  return Record.fromEntries(
    Arr.getSomes(
      Arr.map(declared, ({ header, path }) =>
        Option.map(
          Option.fromNullishOr(primitiveText(valueAt(args, path))),
          (text) => [`${PARAM_HEADER_PREFIX}${header}`, encodeHeaderValue(text)] as const,
        ),
      ),
    ),
  );
};
