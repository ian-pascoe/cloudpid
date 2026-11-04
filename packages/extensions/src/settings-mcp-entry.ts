// What the agent's MCP server definitions are checked and made of, before anything is asked (`docs/architecture/mcp-configuration.md`
// → Approval, Values before asking; The tools; Copying a Repo's server): the texts an entry keeps (for the plain-value check),
// the credential-shaped literals it is refused for, the `${NAME}`s it reads, the entry an `update`'s `set` makes, and the
// entry a Repo's copy makes. Pure over JSON, so every refusal can name a key and never echo a value.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferSchemaOverJson:off preferEffectRecord:off -- builders over plain values.
import {
  isJsonObject,
  MCP_DEFINITION_KEYS,
  MCP_ADJUSTMENT_KEYS,
  type McpServerValue,
  mcpRepoCwd,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

/** Every text an entry keeps: its string values and its keys, for the check that none holds a Secret or a credential. */
export const entryTexts = (value: Schema.Json): ReadonlyArray<string> => {
  if (Predicate.isString(value)) return [value];

  if (Array.isArray(value)) {
    // SAFETY: `Array.isArray` narrows a `Json` array to `any[]`; its elements are `Json` by the type of `value`.
    return Arr.flatMap(value as ReadonlyArray<Schema.Json>, entryTexts);
  }

  if (isJsonObject(value)) {
    return Arr.flatMap(Record.toEntries(value), ([key, each]) => [key, ...entryTexts(each)]);
  }

  return [];
};

const REFERENCE = /\$\{[^}]*\}/g;

/** The headers whose value is a credential whatever the key says, in lower case. */
const CREDENTIAL_HEADERS: ReadonlyArray<string> = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "api-key",
];

/** The endings of a key that name a credential, with `-` and `_` left out and in lower case. */
const CREDENTIAL_ENDINGS: ReadonlyArray<string> = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "accesskey",
  "privatekey",
];

const plainOf = (key: string): string => key.toLowerCase().replaceAll(/[-_]/g, "");

/**
 * Whether `text` holds a literal once its `${…}` are taken out: for a header that always holds a credential, after an
 * optional scheme word (`Bearer `).
 */
const hasLiteral = (text: string, scheme: boolean): boolean => {
  const rest = text.replaceAll(REFERENCE, "");

  return (scheme ? rest.replace(/^\s*[A-Za-z][A-Za-z0-9_-]*\s+/, "") : rest).trim() !== "";
};

/** The string values of `entry`'s `section` (`env` or `headers`) by key; none where it is no object of text. */
const sectionOf = (
  entry: Schema.JsonObject,
  section: "env" | "headers",
): ReadonlyArray<readonly [string, string]> => {
  const held = entry[section];

  return isJsonObject(held)
    ? Arr.filterMap(Record.toEntries(held), ([key, text]) =>
        Predicate.isString(text) ? Result.succeed([key, text] as const) : Result.failVoid,
      )
    : [];
};

/**
 * The keys, as `env.NAME` or `headers.Name`, whose value is a credential written out: literal text outside `${…}` in a
 * credential header, or in a key that ends `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `APIKEY`, `ACCESS_KEY` or
 * `PRIVATE_KEY` (any case, `-` and `_` ignored). Other literals are allowed. Never the values. With `base`, the entry as it
 * is kept now, only the keys the change adds or gives another value (an owner's literal that the agent leaves alone is the
 * owner's plain Setting, accepted).
 */
export const credentialLiterals = (
  entry: Schema.JsonObject,
  base?: Schema.JsonObject,
): ReadonlyArray<string> =>
  Arr.flatMap(["env", "headers"] as const, (section) => {
    const before = new Map(base === undefined ? [] : sectionOf(base, section));

    return Arr.filterMap(sectionOf(entry, section), ([key, text]) => {
      const header = section === "headers" && Arr.contains(CREDENTIAL_HEADERS, key.toLowerCase());
      const named = Arr.some(CREDENTIAL_ENDINGS, (ending) => plainOf(key).endsWith(ending));

      return (header || named) && hasLiteral(text, header) && before.get(key) !== text
        ? Result.succeed(`${section}.${key}`)
        : Result.failVoid;
    });
  });

/** One `${NAME}` an entry reads and where. */
export type EntryReference = { readonly name: string; readonly where: string };

/** The `${NAME}`s an entry reads, once for each place: in `env` and `headers` values and `oauth`'s two secrets. */
export const entryReferences = (entry: McpServerValue): ReadonlyArray<EntryReference> => {
  const places: ReadonlyArray<readonly [string, string]> = [
    ...Arr.map(Record.toEntries(entry.env ?? {}), ([key, text]) => [`env.${key}`, text] as const),
    ...Arr.map(
      Record.toEntries(entry.headers ?? {}),
      ([key, text]) => [`headers.${key}`, text] as const,
    ),
    ...Arr.flatMap(["clientSecret", "privateKey"] as const, (key) => {
      const text = entry.oauth?.[key];

      return text === undefined ? [] : [[`oauth.${key}`, text] as const];
    }),
  ];

  return Arr.flatMap(places, ([where, text]) =>
    Arr.map(
      Arr.dedupe(
        Arr.map([...text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)], ([, name]) => name ?? ""),
      ),
      (name) => ({ name, where }),
    ),
  );
};

/** `entry` with `key` set to `value`: in place when it is there, after the rest when it is not. */
const withKey = (entry: Schema.JsonObject, key: string, value: Schema.Json): Schema.JsonObject => {
  const held = Record.toEntries(entry);

  return Record.fromEntries(
    Arr.some(held, ([each]) => each === key)
      ? Arr.map(held, ([each, kept]) => [each, each === key ? value : kept] as const)
      : [...held, [key, value] as const],
  );
};

const without = (entry: Schema.JsonObject, key: string): Schema.JsonObject =>
  Record.fromEntries(Arr.filter(Record.toEntries(entry), ([held]) => held !== key));

/** The keys of an entry that merge key by key in an `update`'s `set`. */
const MERGED_KEYS: ReadonlyArray<string> = ["env", "headers", "oauth"];

/** `set`'s keys that are no part of the definition, with the tool that changes each. */
export const KEYS_OF_OTHER_TOOLS: Readonly<Record<string, string>> = {
  enabled: "settings_mcp_enable or settings_mcp_disable",
  exposure: "settings_mcp_exposure_set",
  toolExposure: "settings_mcp_tool_exposure_set",
};

/** Why `set` is no definition change, or undefined: it names a key another tool changes, or is empty. */
export const setProblem = (set: Schema.JsonObject): string | undefined => {
  const other = Arr.findFirst(Object.keys(set), (key) => Arr.contains(MCP_ADJUSTMENT_KEYS, key));

  if (Option.isSome(other)) {
    return `${other.value} is no part of the definition: ${KEYS_OF_OTHER_TOOLS[other.value]} changes it`;
  }

  return Record.isEmptyRecord(set) ? "set has no key to change" : undefined;
};

/**
 * `entry` with `set` applied: a key replaces its value and null removes it; `env`, `headers` and `oauth` merge key by
 * key, null removing one key (an object left empty is removed); `args` is replaced whole. The keys of the definition are
 * kept in the order of the entry, and a new one goes after them. Or why it cannot be (a key that merges was given a
 * value that is no object).
 */
export const entryWithSet = (
  entry: Schema.JsonObject,
  set: Schema.JsonObject,
): { readonly entry: Schema.JsonObject } | { readonly problem: string } => {
  let next: Schema.JsonObject = entry;

  for (const [key, value] of Record.toEntries(set)) {
    if (value === null) {
      next = without(next, key);

      continue;
    }

    if (Arr.contains(MERGED_KEYS, key)) {
      if (!isJsonObject(value)) return { problem: `${key} merges key by key: give an object` };

      const held = next[key];
      const base: Schema.JsonObject = isJsonObject(held) ? held : {};

      const merged = Record.fromEntries(
        Arr.filter(
          Record.toEntries(
            Arr.reduce(Record.toEntries(value), base, (kept, [each, given]) =>
              withKey(kept, each, given),
            ),
          ),
          ([, each]) => each !== null,
        ),
      );

      next = Record.isEmptyRecord(merged) ? without(next, key) : withKey(next, key, merged);

      continue;
    }

    next = withKey(next, key, value);
  }

  return { entry: next };
};

/** The keys an `update`'s `set` may name that this build knows; any other fails the strict decode with its own message. */
export const SET_KEYS: ReadonlyArray<string> = MCP_DEFINITION_KEYS;

/**
 * The full entry of a Repo's server as the Settings keep it for a copy: as written, with a relative `cwd` made absolute
 * (`/workspace/<directory>[/<cwd>]`, a Repo's `cwd` meaning its directory), and the key written even when the Repo's
 * entry left it out, so a stdio copy runs where its Repo is. Or why it cannot be (a `cwd` that leaves the Repo).
 */
export const copiedEntry = (
  entry: Schema.JsonObject,
  directory: string,
):
  | { readonly entry: Schema.JsonObject; readonly cwd: string | null }
  | { readonly problem: string } => {
  const stdio = entry.command !== undefined;
  const cwd = Predicate.isString(entry.cwd) ? entry.cwd : undefined;

  if (!stdio) return { entry, cwd: null };

  const absolute = mcpRepoCwd(directory, cwd);

  return absolute === undefined
    ? {
        problem: `its cwd (${JSON.stringify(cwd)}) leaves the Repo or is absolute: write it in an entry instead`,
      }
    : { entry: withKey(entry, "cwd", absolute), cwd: absolute };
};

/** A value of an entry as text for a line: a string as it is, anything else as JSON. */
export const textOf = (value: Schema.Json | undefined): string =>
  Predicate.isString(value) ? value : value === undefined ? "" : JSON.stringify(value);

/** The entry a decode made, as JSON again: the decoded value holds strings, numbers, booleans, arrays and objects only. */
export const entryJson = (value: McpServerValue): Schema.JsonObject =>
  // SAFETY: a decoded server value is made of JSON values only (`McpServerValue` is a Json-shaped schema type).
  Record.fromEntries(Record.toEntries(value as Record<string, Schema.Json>));
