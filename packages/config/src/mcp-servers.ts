// MCP server entries (`docs/architecture/mcp-configuration.md` → Entries): the `mcp.servers` root of the settings, at both
// Scopes, and the entries of a Repo's `.pi/mcp.json`. An entry is read as written, with no default filled in, since an
// MCP server adjustment holds only the keys it changes and `{ ...base, ...adjustment }` must not meet a default
// (`normalizeMcpServer` gives the entry in force, with the defaults). Settings decode strictly: an entry that breaks a rule
// is refused with a problem. A Repo's file decodes leniently, an entry at a time: the entry that breaks a rule is skipped
// with a problem and the rest stand, except for the bounds, which skip the whole file.
// @effect-diagnostics missingPipeableSignature:off -- predicates and builders of plain values, not combinators.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { isJsonObject, utf8Bytes } from "./json.ts";
import { problemLines, problemsOf, type SettingsProblem } from "./schema-problems.ts";

/** The most an MCP server entry, and what holds entries, may be (D10 of the MCP server configuration design). */
export const MCP_LIMITS = {
  /** Servers per Scope and per Repo file; an Environment's adjustments are not servers and do not count. */
  servers: 50,
  /** A server's name, in characters. */
  name: 64,
  /** One entry as JSON, in bytes of UTF-8. */
  entryBytes: 16 * 1024,
  /** `env` keys, and `headers` keys. */
  keys: 64,
  toolExposureKeys: 200,
  /** A description, in bytes of UTF-8. */
  descriptionBytes: 1024,
  /** A Repo's `.pi/mcp.json`, in bytes of UTF-8. */
  repoFileBytes: 64 * 1024,
} as const;

/** How an MCP server's tools reach the model (`GLOSSARY.md` → Exposure). */
export const MCP_EXPOSURES = ["codemode", "deferred", "direct", "hidden"] as const;

export type McpExposure = (typeof MCP_EXPOSURES)[number];

/** pi's `codemode-deferred`, read as `codemode` (`normalizedExposure`). */
const CODEMODE_DEFERRED = "codemode-deferred";

/** Whether an MCP server may ask the owner's models for a reply (Sampling, D2). */
export const MCP_SAMPLING = ["ask", "allow", "off"] as const;

export type McpSampling = (typeof MCP_SAMPLING)[number];

/** The root of the MCP servers in the settings: `mcp.servers.<name>`. */
export const MCP_ROOT = "mcp";

/** The keys an MCP server adjustment holds; every other key is part of the MCP server definition. */
export const MCP_ADJUSTMENT_KEYS = ["enabled", "exposure", "toolExposure"] as const;

export type McpAdjustmentKey = (typeof MCP_ADJUSTMENT_KEYS)[number];

/** How a key is named in words (an Agent change's title, a result): `on/off`, `exposure`, `tool exposure`. */
export const MCP_KEY_LABELS: Readonly<Record<McpAdjustmentKey, string>> = {
  enabled: "on/off",
  exposure: "exposure",
  toolExposure: "tool exposure",
};

/** The field `mcp.servers.<name>.<key>` of one key of an MCP server. */
export const mcpKeyField = (name: string, key: McpAdjustmentKey): string =>
  `${MCP_ROOT}.servers.${name}.${key}`;

/** The keys of the MCP server definition: every key but those of an adjustment (`auth` is none, it is refused). */
export const MCP_DEFINITION_KEYS = [
  "type",
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "oauth",
  "timeout",
  "description",
  "sampling",
] as const;

/** What `samplingOf` says of a definition. */
export type McpSamplingMode = "allow" | "ask" | "off";

/** The modes whose requests are declared, and so answered: the ones a call decides by. */
export type McpSampledMode = Extract<McpSamplingMode, "allow" | "ask">;

/**
 * What a server's definition says to its Sampling requests, which is the one place that decides it
 * (`docs/architecture/mcp-server-requests.md` → Sampling requests): `"allow"` answers them on the owner's models without
 * asking, `"ask"` (the default) asks the owner on a card, and `"off"` declares nothing. A stdio server is read the same
 * way as an HTTP one (its bridge carries its requests as it carries a Legacy elicitation's). A Repo's `allow` was read
 * as `ask` before it got here (`resolveMcpServerSet`).
 */
export const samplingOf = (server: { readonly sampling?: unknown }): McpSamplingMode => {
  if (server.sampling === "off") return "off";

  return server.sampling === "allow" ? "allow" : "ask";
};

/** Whether a definition's Sampling requests are declared, and so answered: `allow` or `ask`. */
export const declaresSampling = (server: { readonly sampling?: unknown }): boolean =>
  samplingOf(server) !== "off";

/** What a server's name looks like: `^[A-Za-z0-9_-]+$`, at most 64 characters. */
export const MCP_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * The name as tool names spell it: lower case, with `-` as `_`. Names with one spelling clash across every layer, since
 * a tool is `mcp__<name>__<tool>` (MCP tools in a Session, D6).
 */
export const normalizeMcpName = (name: string): string => name.toLowerCase().replaceAll("-", "_");

const exposureSchema = Schema.Literals([...MCP_EXPOSURES, CODEMODE_DEFERRED]);

const stringList = Schema.Array(Schema.String);

const stringMap = Schema.Record(Schema.String, Schema.String);

const OAuth = Schema.Struct({
  clientId: Schema.optionalKey(Schema.String),
  clientSecret: Schema.optionalKey(Schema.String),
  privateKey: Schema.optionalKey(Schema.String),
  keyId: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  clientName: Schema.optionalKey(Schema.String),
  clientRegistration: Schema.optionalKey(Schema.Literals(["auto", "cimd", "dcr"])),
  authServerMetadataUrl: Schema.optionalKey(Schema.String),
  issuer: Schema.optionalKey(Schema.String),
  grantType: Schema.optionalKey(Schema.Literals(["authorization_code", "client_credentials"])),
  /** Accepted and ignored: cloudpid's redirect URI is its own. */
  callbackPort: Schema.optionalKey(Schema.Finite),
  callbackUrl: Schema.optionalKey(Schema.String),
});

/** The `oauth` fields cloudpid accepts and ignores: its redirect URI is its own (`mcpEntryHints`). */
const OAUTH_IGNORED = ["callbackPort", "callbackUrl"] as const;

/** Every `oauth` field, ignored or not. */
const OAUTH_FIELDS: ReadonlyArray<keyof McpOauth> = Record.keys(OAuth.fields);

/** The `oauth` fields that count: all but those cloudpid ignores. A new field is one edit, in the schema. */
export const MCP_OAUTH_KEYS: ReadonlyArray<keyof McpOauth> = Arr.filter(
  OAUTH_FIELDS,
  (key) => !Arr.contains(OAUTH_IGNORED, key),
);

/** The `oauth` fields of an entry, as written (`docs/architecture/mcp-sign-in.md` → The `oauth` fields). */
export type McpOauth = typeof OAuth.Type;

/**
 * An entry as written: a full entry (it has `command`, `url` or `type`) that defines a server, or an MCP server
 * adjustment (only `enabled`, `exposure` and `toolExposure`). Which it is, is `isMcpFullEntry`; the rules each has are
 * `entryProblems`.
 */
const McpServerFields = {
  type: Schema.optionalKey(
    Schema.Literals(["stdio", "http", "streamable-http"]).annotate({
      message:
        'must be "stdio", "http" or "streamable-http" ("sse" is refused: use Streamable HTTP)',
    }),
  ),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(stringList),
  env: Schema.optionalKey(stringMap),
  cwd: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(stringMap),
  oauth: Schema.optionalKey(OAuth),
  /** pi's own sign-in setting: refused (`entryProblems`), read here only to say so. */
  auth: Schema.optionalKey(Schema.Json),
  enabled: Schema.optionalKey(Schema.Boolean),
  exposure: Schema.optionalKey(exposureSchema),
  toolExposure: Schema.optionalKey(Schema.Record(Schema.String, exposureSchema)),
  timeout: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThan(0))),
  description: Schema.optionalKey(Schema.String),
  sampling: Schema.optionalKey(Schema.Literals(MCP_SAMPLING)),
};

const McpEntryStruct = Schema.Struct(McpServerFields);

/** An entry as written, full or an adjustment. */
export type McpServerValue = typeof McpEntryStruct.Type;

type McpWhere = "settings" | "repo";

const NAME_REFERENCE = /\$\{([^}]*)\}/g;

const VALID_REFERENCE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Whether `text` is exactly one `${NAME}`. */
const isSingleReference = (text: string): boolean => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(text);

/** The `${…}` of `text` that are not a valid `${NAME}`. */
const malformedReferences = (text: string): boolean =>
  Arr.some([...text.matchAll(NAME_REFERENCE)], ([, name]) => !VALID_REFERENCE.test(name ?? "")) ||
  /\$\{(?![^}]*\})/.test(text);

const tildePath = (text: string): boolean => /^~(\/|$)/.test(text);

/** Whether `value` has `command`, `url` or `type`: a full entry, whether or not it then decodes. */
export const isMcpFullEntry = (value: McpServerValue | Schema.JsonObject): boolean =>
  Predicate.hasProperty(value, "command") ||
  Predicate.hasProperty(value, "url") ||
  Predicate.hasProperty(value, "type");

/**
 * A relative `cwd` of a Repo's entry in `/workspace/<directory>` (`mcpRepoCwd`), or undefined where it leaves the
 * Repo, is absolute, or starts with `~`.
 */
export const mcpRepoCwd = (directory: string, cwd: string | undefined): string | undefined => {
  const base = `/workspace/${directory}`;

  if (cwd === undefined || cwd === "") return base;

  if (cwd.startsWith("/") || tildePath(cwd)) return undefined;

  const parts: Array<string> = [];

  for (const part of cwd.split("/")) {
    if (part === "" || part === ".") continue;

    if (part === "..") {
      if (parts.length === 0) return undefined;

      parts.pop();
    } else {
      parts.push(part);
    }
  }

  return parts.length === 0 ? base : `${base}/${Arr.join(parts, "/")}`;
};

const oauthProblems = (
  oauth: McpOauth,
  where: McpWhere,
  headers: Readonly<Record<string, string>> | undefined,
  kind: "stdio" | "http" | undefined,
): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = [];
  const at = (key: string, issue: string) => issues.push({ path: ["oauth", key], issue });
  const { clientId, clientSecret, privateKey, keyId, scope, clientName } = oauth;

  if (kind === "stdio") {
    issues.push({ path: ["oauth"], issue: "is for an HTTP server: a stdio server has no sign-in" });
  }

  if (Arr.some(Record.keys(headers ?? {}), (header) => header.toLowerCase() === "authorization")) {
    issues.push({
      path: ["oauth"],
      issue:
        "is refused beside an Authorization header: the server is sent that header, not signed in to",
    });
  }

  if (clientId !== undefined && !/^[^\s\p{Cc}]{1,256}$/u.test(clientId)) {
    at("clientId", "must be 1 to 256 printable characters, without whitespace");
  }

  if (clientSecret !== undefined) {
    if (clientId === undefined) at("clientSecret", "needs a clientId");

    if (where === "settings" && !isSingleReference(clientSecret)) {
      at(
        "clientSecret",
        "must be exactly one ${NAME}, never a literal: keep the value as a Secret",
      );
    }
  }

  if (privateKey !== undefined) {
    if (where === "settings" && !isSingleReference(privateKey)) {
      at("privateKey", "must be exactly one ${NAME} holding the key, never a literal");
    }

    if (oauth.grantType !== "client_credentials") {
      at("privateKey", 'is only for grantType "client_credentials"');
    }

    if (clientSecret !== undefined) at("privateKey", "is refused together with clientSecret");
  }

  if (oauth.grantType === "client_credentials") {
    // The grant has no owner to ask: it needs its client, the authorization server it may sign in at, and a way to prove
    // itself, and has no registration or client name of its own (→ Client Credentials).
    if (clientId === undefined) at("clientId", 'is needed for grantType "client_credentials"');

    if (oauth.issuer === undefined && oauth.authServerMetadataUrl === undefined) {
      at(
        "issuer",
        'or authServerMetadataUrl is needed to pin the authorization server for "client_credentials"',
      );
    }

    if (clientSecret === undefined && privateKey === undefined) {
      at("clientSecret", 'or privateKey is needed for grantType "client_credentials"');
    }

    if (oauth.clientRegistration !== undefined) {
      at("clientRegistration", 'is refused with grantType "client_credentials"');
    }

    if (clientName !== undefined)
      at("clientName", 'is refused with grantType "client_credentials"');
  }

  if (keyId !== undefined && (keyId.length < 1 || keyId.length > 256)) {
    at("keyId", "must be 1 to 256 characters");
  }

  if (scope !== undefined) {
    const tokens = Arr.filter(scope.split(/\s+/), (token) => token !== "");

    if (tokens.length > 64 || utf8Bytes(scope) > 1024) {
      at("scope", "must be at most 64 tokens and 1 KiB");
    }
  }

  if (clientName !== undefined && (clientName.length < 1 || clientName.length > 100)) {
    at("clientName", "must be 1 to 100 characters");
  }

  if (oauth.clientRegistration === "cimd" && (clientId !== undefined || clientName !== undefined)) {
    at("clientRegistration", '"cimd" is refused together with clientId or clientName');
  }

  for (const key of ["authServerMetadataUrl", "issuer"] as const) {
    const text = oauth[key];

    if (text === undefined) continue;

    const url = Option.getOrUndefined(Option.liftThrowable((href: string) => new URL(href))(text));

    if (url === undefined || url.protocol !== "https:" || text.length > 2048) {
      at(key, "must be an https URL of at most 2,048 characters");
    } else if (
      key === "issuer" &&
      (url.search !== "" || url.hash !== "" || text.includes("#") || text.includes("?"))
    ) {
      at(key, "must have no query or fragment");
    }
  }

  return issues;
};

/**
 * The size of an entry as written, in bytes, without `enabled` and `exposure`: they are not the server, and leaving
 * them out means switching a server off, which adds the key to an entry that lacks it, never makes it too big.
 */
export const mcpEntryBytes = (value: McpServerValue): number =>
  utf8Bytes(JSON.stringify(Struct.omit(value, ["enabled", "exposure"])));

/** Why `value`, an entry as written, breaks the bounds: one line each, or none. */
export const mcpEntryBoundsProblems = (value: McpServerValue): ReadonlyArray<string> => {
  const problems: Array<string> = [];

  if (mcpEntryBytes(value) > MCP_LIMITS.entryBytes) {
    problems.push(`is over ${MCP_LIMITS.entryBytes / 1024} KiB`);
  }

  for (const key of ["env", "headers"] as const) {
    if (Record.size(value[key] ?? {}) > MCP_LIMITS.keys) {
      problems.push(`${key} has more than ${MCP_LIMITS.keys} keys`);
    }
  }

  if (Record.size(value.toolExposure ?? {}) > MCP_LIMITS.toolExposureKeys) {
    problems.push(`toolExposure has more than ${MCP_LIMITS.toolExposureKeys} keys`);
  }

  if (
    value.description !== undefined &&
    utf8Bytes(value.description) > MCP_LIMITS.descriptionBytes
  ) {
    problems.push(`description is over ${MCP_LIMITS.descriptionBytes / 1024} KiB`);
  }

  return problems;
};

const ADJUSTMENT_ONLY = `an MCP server adjustment holds only ${Arr.join(MCP_ADJUSTMENT_KEYS, ", ")}`;

/**
 * Every rule an entry as written must meet, as problems at the keys they lie at: that a full entry defines a server and
 * is one kind of it, what pi has that cloudpid refuses (`auth`, `~`, `!command` values, `${NAME}` outside `env` and
 * `headers`), `oauth`, the directory, and the bounds. An adjustment may hold nothing but its three keys.
 */
const entryProblems = (
  value: McpServerValue,
  where: McpWhere,
): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = [];
  const refuse = (key: string, issue: string) => issues.push({ path: [key], issue });

  if (value.auth !== undefined) {
    refuse(
      "auth",
      'is not supported: cloudpid signs in through "oauth", or sends the header you write',
    );
  }

  for (const problem of mcpEntryBoundsProblems(value)) issues.push(problem);

  if (!isMcpFullEntry(value)) {
    for (const key of Arr.filter(MCP_DEFINITION_KEYS, (held) => value[held] !== undefined)) {
      refuse(
        key,
        `${ADJUSTMENT_ONLY}: ${key} is part of the definition, so it takes an entry of its own with a command or a url`,
      );
    }

    return issues;
  }

  const hasCommand = value.command !== undefined;
  const hasUrl = value.url !== undefined;
  const kind = hasCommand ? "stdio" : hasUrl ? "http" : undefined;

  if (hasCommand && hasUrl) {
    issues.push("has both a command and a url: an MCP server is one or the other");
  } else if (kind === undefined) {
    issues.push("does not define a server: give it a command (stdio) or a url (Streamable HTTP)");
  } else if ((value.type === "stdio") !== (kind === "stdio") && value.type !== undefined) {
    refuse("type", `is "${value.type}", but the entry has a ${hasCommand ? "command" : "url"}`);
  }

  if (kind === "stdio") {
    if (value.headers !== undefined) refuse("headers", "is for an HTTP server");
  } else if (kind === "http") {
    for (const key of ["args", "env", "cwd"] as const) {
      if (value[key] !== undefined) refuse(key, "is for a stdio server");
    }
  }

  if (value.command !== undefined && value.command === "") refuse("command", "is empty");

  const tilde = [
    ...(value.command === undefined ? [] : [["command", value.command] as const]),
    ...Arr.map(value.args ?? [], (arg, index) => [`args.${index}`, arg] as const),
    ...(value.cwd === undefined ? [] : [["cwd", value.cwd] as const]),
  ];

  for (const [key, text] of tilde) {
    if (tildePath(text)) refuse(key, "starts with ~, which is never expanded: write the path out");
  }

  if (
    value.cwd !== undefined &&
    where === "settings" &&
    !value.cwd.startsWith("/") &&
    !tildePath(value.cwd)
  ) {
    refuse("cwd", "must be an absolute path: the Session's default directory is used without one");
  }

  if (value.cwd !== undefined && where === "repo" && mcpRepoCwd("repo", value.cwd) === undefined) {
    refuse("cwd", "must be a relative path that stays inside the Repo");
  }

  if (value.url !== undefined) {
    const url = Option.getOrUndefined(
      Option.liftThrowable((href: string) => new URL(href))(value.url),
    );

    if (url === undefined || (url.protocol !== "https:" && url.protocol !== "http:")) {
      refuse("url", "must be an http or https URL");
    }
  }

  const references = [
    ...(value.command === undefined ? [] : [["command", value.command] as const]),
    ...Arr.map(value.args ?? [], (arg, index) => [`args.${index}`, arg] as const),
    ...(value.cwd === undefined ? [] : [["cwd", value.cwd] as const]),
    ...(value.url === undefined ? [] : [["url", value.url] as const]),
    ...Arr.flatMap(
      Arr.filter(OAUTH_FIELDS, (key) => key !== "clientSecret" && key !== "privateKey"),
      (key: keyof McpOauth) => {
        const field = value.oauth?.[key];

        return Predicate.isString(field) ? [[`oauth.${key}`, field] as const] : [];
      },
    ),
  ];

  for (const [key, text] of references) {
    if (text.includes("${")) {
      issues.push({
        path: key.split("."),
        issue:
          "reads ${NAME}, which is only read in the values of env and headers (and the secrets of oauth)",
      });
    }
  }

  for (const key of ["env", "headers"] as const) {
    for (const [name, text] of Record.toEntries(value[key] ?? {})) {
      if (name === "") issues.push({ path: [key], issue: "has an empty key" });

      if (text.startsWith("!")) {
        issues.push({
          path: [key, name],
          issue:
            "starts with !, which pi runs as a command and cloudpid never does: write the value, or ${NAME}",
        });
      } else if (malformedReferences(text)) {
        issues.push({ path: [key, name], issue: "has a ${…} that is not a ${NAME}" });
      }
    }
  }

  if (value.oauth !== undefined) {
    for (const issue of oauthProblems(value.oauth, where, value.headers, kind)) issues.push(issue);
  }

  for (const key of ["clientSecret", "privateKey"] as const) {
    const text = value.oauth?.[key];

    if (text !== undefined && where === "repo" && text.startsWith("!")) {
      issues.push({ path: ["oauth", key], issue: "starts with !, which cloudpid never runs" });
    }
  }

  return issues;
};

/** The schema of an entry as written, at Settings or in a Repo's file (which may hold a literal `oauth` secret). */
const serverSchema = (where: McpWhere) =>
  McpEntryStruct.check(Schema.makeFilter((value: McpServerValue) => entryProblems(value, where)));

const SettingsServer = serverSchema("settings");

const RepoServer = serverSchema("repo");

/** Why a name clashes with `twin`, which differs from it only in case or in `-`/`_`. */
export const mcpTwinClash = (twin: string): string =>
  `clashes with "${twin}": names that differ only in case or in - and _ are one server`;

/**
 * Why `name` is not a server's name here, or undefined: it is not one (`^[A-Za-z0-9_-]+$`, at most 64 characters), or it
 * differs only in case or in `-`/`_` from a name in `seen` (normalized name to the name as spelled).
 */
const nameProblem = (name: string, seen: ReadonlyMap<string, string>): string | undefined => {
  if (name.length > MCP_LIMITS.name || !MCP_NAME.test(name)) {
    return `is not a name: use letters, digits, - and _, at most ${MCP_LIMITS.name} characters`;
  }

  const twin = seen.get(normalizeMcpName(name));

  return twin === undefined ? undefined : mcpTwinClash(twin);
};

/** `servers`' problems: a name that is not one, and the names that differ from an earlier one only in case or in `-`/`_`. */
const nameProblems = (
  servers: Readonly<Record<string, unknown>>,
): ReadonlyArray<Schema.FilterIssue> => {
  const seen = new Map<string, string>();
  const issues: Array<Schema.FilterIssue> = [];

  for (const name of Record.keys(servers)) {
    const problem = nameProblem(name, seen);

    if (problem === undefined) {
      seen.set(normalizeMcpName(name), name);
    } else {
      issues.push({ path: [name], issue: problem });
    }
  }

  return issues;
};

/**
 * The `mcp.servers` of a document of settings: servers by name. Each name must be one, and none may be the twin of
 * another in case or in `-`/`_`. A set of servers over a Scope's 50 is `mcpLayerProblems`, since the settings of an
 * Environment hold Global's servers too.
 */
export const McpServers = Schema.Record(Schema.String, SettingsServer).check(
  Schema.makeFilter((servers: Readonly<Record<string, McpServerValue>>) => nameProblems(servers)),
);

export type McpServers = typeof McpServers.Type;

/** The `mcp` root of the settings: nothing but `servers` (pi's `autoEnableCodemode` has no key). */
export const McpSettings = Schema.Struct({
  servers: McpServers.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});

const decodeSettingsServer = Schema.decodeUnknownResult(SettingsServer, {
  onExcessProperty: "error",
  errors: "all",
});

const decodeRepoServer = Schema.decodeUnknownResult(RepoServer, {
  onExcessProperty: "error",
  errors: "all",
});

/**
 * The entry `value` as written, or why it is not one: every problem with the keys it lies at (relative to the entry).
 * `where` says whether it is in the Settings, which refuse a literal `oauth` secret, or in a Repo's file.
 */
export const decodeMcpServerValue = (
  value: Schema.Json,
  where: McpWhere = "settings",
): Result.Result<McpServerValue, ReadonlyArray<SettingsProblem>> =>
  Result.mapError(
    (where === "settings" ? decodeSettingsServer : decodeRepoServer)(value),
    problemsOf,
  );

/**
 * The keys of an MCP server's field `parts` (`mcp.servers.<name>`, or its `enabled`, `exposure` or `toolExposure`), or
 * undefined for a path that leads to none: a name that is not one, another key of an entry.
 */
export const mcpFieldPath = (parts: ReadonlyArray<string>): ReadonlyArray<string> | undefined => {
  const [, servers, name, key, ...rest] = parts;

  if (servers !== "servers" || name === undefined) return undefined;

  if (name.length > MCP_LIMITS.name || !MCP_NAME.test(name) || rest.length > 0) return undefined;

  return key === undefined || Arr.contains(MCP_ADJUSTMENT_KEYS, key) ? parts : undefined;
};

/**
 * The server and key a settings field names (`mcp.servers.<name>`, with a `key` null, or `mcp.servers.<name>.<key>` of
 * an adjustment's keys), or null for a field that is no MCP server's. The one parser of such a field.
 */
export const parseMcpField = (
  field: string,
): { readonly name: string; readonly key: McpAdjustmentKey | null } | null => {
  const parts = field.split(".");

  if (parts[0] !== MCP_ROOT || mcpFieldPath(parts) === undefined) return null;

  const [, , name = "", key] = parts;

  if (key === undefined) return { name, key: null };

  const found = Arr.findFirst(MCP_ADJUSTMENT_KEYS, (each) => each === key);

  return Option.isSome(found) ? { name, key: found.value } : null;
};

/** Whether a settings field is an MCP server's (or one of its adjustment's keys): its change is the McpHosts' upkeep too. */
export const isMcpField = (field: string): boolean => parseMcpField(field) !== null;

/** The `mcp.servers` of a document of settings or of Overrides, as written; none where it has none. */
export const mcpServersOf = (document: Schema.Json): Schema.Json | undefined => {
  const mcp = isJsonObject(document) ? document[MCP_ROOT] : undefined;

  return mcp === undefined || !isJsonObject(mcp) ? undefined : mcp["servers"];
};

/** The problems of the servers one layer holds, as the settings' strict reads refuse them. */
export type McpLayerScope = "global" | "environment";

/**
 * The problems of `servers` (the `mcp.servers` of Global's document or of an Environment's Overrides) that the schema
 * cannot see, since the settings an Environment resolves to hold Global's servers as well as its own: more than 50
 * servers, and, at Global, an MCP server adjustment, which has no lower layer to adjust. An Environment's adjustments
 * are not servers and do not count toward its 50 (they are bounded by the servers they adjust; counting them would
 * stop an Environment with 50 servers of its own from switching Global's off).
 */
export const mcpLayerProblems = (
  servers: Schema.Json | undefined,
  scope: McpLayerScope,
): ReadonlyArray<SettingsProblem> => {
  if (servers === undefined || !isJsonObject(servers)) return [];

  const problems: Array<SettingsProblem> = [];
  let count = 0;

  for (const [name, value] of Record.toEntries(servers)) {
    const adjustment = isJsonObject(value) && !isMcpFullEntry(value);
    const keys = ["mcp", "servers", name];

    if (adjustment) {
      if (scope === "global") {
        problems.push({
          keys,
          line: `${Arr.join(keys, ".")}: ${GLOBAL_ADJUSTMENT}`,
        });
      }

      continue;
    }

    count += 1;

    if (count > MCP_LIMITS.servers) {
      problems.push({
        keys,
        line: `${Arr.join(keys, ".")}: ${overServers}`,
      });
    }
  }

  return problems;
};

const GLOBAL_ADJUSTMENT = "Global holds no MCP server adjustment: it has no lower layer to adjust";

const overServers = `is over the ${MCP_LIMITS.servers} MCP servers a Scope may have`;

/** Something wrong with an entry of a layer, or with a key of its adjustment (`keys` below the entry). */
export type McpLayerProblem = {
  readonly name: string;
  readonly keys: ReadonlyArray<string>;
  /** What is wrong, without where. */
  readonly text: string;
};

/** The Settings' problem for `problem`: its keys from the root, and its line as `mcp.servers.<name>[.<keys>]: <text>`. */
export const mcpLayerProblemOf = ({ name, keys, text }: McpLayerProblem): SettingsProblem => {
  const path = ["mcp", "servers", name, ...keys];

  return { keys: path, line: `${Arr.join(path, ".")}: ${text}` };
};

/** An entry or an adjustment, by its name, as the schema reads it: of an owner's layer or a Repo's file. */
export type McpNamedEntry = { readonly name: string; readonly value: McpServerValue };

/** What one owner's layer of MCP servers holds once every part that does not stand is left out. */
export type McpLayerRead = {
  /** The full entries that stand, in order. */
  readonly entries: ReadonlyArray<McpNamedEntry>;
  /** The adjustments that stand, with only the keys that do: each key stands alone. */
  readonly adjustments: ReadonlyArray<McpNamedEntry>;
  /** What was left out, in order. */
  readonly problems: ReadonlyArray<McpLayerProblem>;
  /** The `mcp.servers` document of what stands, as written, in order. */
  readonly servers: Schema.JsonObject;
};

/**
 * One owner's layer of MCP servers read leniently, as the Settings read it and as the MCP server set reads it, so
 * that the two cannot differ: every full entry that decodes stands, in order, up to 50 (what does not decode does not
 * count, and does not make its twin a clash); an adjustment (an Environment's only, Global has none) stands key by key,
 * each key being an Override field of its own; a name that is not one or is the twin of an earlier standing name is left
 * out. `servers` is the layer's `mcp.servers` as written.
 */
export const readMcpLayer = (
  servers: Schema.Json | undefined,
  scope: McpLayerScope,
): McpLayerRead => {
  const entries: Array<McpNamedEntry> = [];
  const adjustments: Array<McpNamedEntry> = [];
  const problems: Array<McpLayerProblem> = [];
  const standing: Array<readonly [string, Schema.Json]> = [];
  const seen = new Map<string, string>();

  if (servers !== undefined && isJsonObject(servers)) {
    for (const [name, written] of Record.toEntries(servers)) {
      const refuse = (keys: ReadonlyArray<string>, text: string) =>
        problems.push({ name, keys, text });

      const refuseDecode = (failure: ReadonlyArray<SettingsProblem>) => {
        for (const problem of failure) {
          const own = Arr.join(problem.keys, ".");

          refuse(problem.keys, own === "" ? problem.line : problem.line.slice(own.length + 2));
        }
      };

      const named = nameProblem(name, seen);

      if (named !== undefined) {
        refuse([], named);

        continue;
      }

      if (!isJsonObject(written) || isMcpFullEntry(written)) {
        const decoded = decodeMcpServerValue(written);

        if (Result.isFailure(decoded)) {
          refuseDecode(decoded.failure);
        } else if (entries.length >= MCP_LIMITS.servers) {
          refuse([], overServers);
        } else {
          entries.push({ name, value: decoded.success });
          standing.push([name, written]);
          seen.set(normalizeMcpName(name), name);
        }

        continue;
      }

      if (scope === "global") {
        refuse([], GLOBAL_ADJUSTMENT);

        continue;
      }

      const kept = Arr.filter(Record.toEntries(written), ([key, value]) => {
        const alone = decodeMcpServerValue(Record.fromEntries([[key, value]]));

        if (Result.isFailure(alone)) refuseDecode(alone.failure);

        return Result.isSuccess(alone);
      });

      const adjustment = Record.fromEntries(kept);
      const decoded = decodeMcpServerValue(adjustment);

      if (Result.isFailure(decoded)) {
        refuseDecode(decoded.failure);
      } else if (kept.length > 0) {
        adjustments.push({ name, value: decoded.success });
        standing.push([name, adjustment]);
        seen.set(normalizeMcpName(name), name);
      }
    }
  }

  return { entries, adjustments, problems, servers: Record.fromEntries(standing) };
};

/** `document` with `servers` as the `mcp.servers` of its `mcp` root, `mcp`. */
const withServers = (
  document: Schema.JsonObject,
  mcp: Schema.JsonObject,
  servers: Schema.JsonObject,
): Schema.JsonObject =>
  Record.map(document, (entry, key) =>
    key === MCP_ROOT
      ? Record.map(mcp, (held, name) => (name === "servers" ? servers : held))
      : entry,
  );

/** A document with its MCP servers read as a layer, and the Settings' problems for what that left out. */
export type McpLayerDocument = {
  readonly document: Schema.JsonObject;
  readonly problems: ReadonlyArray<SettingsProblem>;
};

/**
 * `document` (the settings, or an Environment's Overrides) with its `mcp.servers` read as `readMcpLayer` reads them,
 * and the Settings' problems for what that left out. A document with no `mcp.servers` is as it was.
 */
export const withMcpLayerRead = (
  document: Schema.JsonObject,
  scope: McpLayerScope,
): McpLayerDocument => {
  const mcp = document[MCP_ROOT];

  if (mcp === undefined || !isJsonObject(mcp) || mcp["servers"] === undefined) {
    return { document, problems: [] };
  }

  const read = readMcpLayer(mcp["servers"], scope);

  return {
    document: withServers(document, mcp, read.servers),
    problems: Arr.map(read.problems, mcpLayerProblemOf),
  };
};

/** Which layer's saved document a problem is in. */
export type McpProblemSource = "global" | "environment";

/** The layer a problem's `source` names, or undefined for one a later build adds: a reader shows such a one as it is. */
export const readMcpProblemSource = (source: string): McpProblemSource | undefined =>
  source === "global" || source === "environment" ? source : undefined;

/**
 * An MCP entry (or a key of one) that a lenient read left out, for the Settings page to show on its row: the layer it is
 * in (`McpProblemSource`, a string on the wire so that a later layer is not a decode failure: `readMcpProblemSource`),
 * the server's name, the keys below the entry (none for the entry as a whole), what is wrong, and the Override fields
 * whose Reset clears it (an adjustment key held over the entry bound). The Registry's `getSettings` and
 * `getSettingsOverrides` carry it as `mcpProblems`.
 */
export const McpSettingsProblem = Schema.Struct({
  source: Schema.String,
  name: Schema.String,
  keys: Schema.Array(Schema.String),
  message: Schema.String,
  reset: Schema.Array(Schema.String),
});

export type McpSettingsProblem = typeof McpSettingsProblem.Type;

/** The problems of `problems` that lie in `mcp.servers.<name>`, as the page reads them, with `source` the layer they are in. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a mapping of plain problems, not a combinator.
export const mcpSettingsProblems = (
  problems: ReadonlyArray<SettingsProblem>,
  source: McpProblemSource,
): ReadonlyArray<McpSettingsProblem> =>
  Arr.flatMap(problems, ({ keys, line }) => {
    const [root, servers, name, ...below] = keys;

    if (root !== MCP_ROOT || servers !== "servers" || name === undefined) return [];

    const message = line.slice(Arr.join(keys, ".").length + 2);
    const [key] = below;

    return [
      {
        source,
        name,
        keys: below,
        message,
        reset:
          source === "environment" &&
          below.length === 1 &&
          key !== undefined &&
          message === MCP_ADJUSTMENT_OVER
            ? [`mcp.servers.${name}.${key}`]
            : [],
      },
    ];
  });

/** A Global server that an Environment's own entry shadows by a twin name, and why it is left out. */
export type McpShadowedTwin = {
  readonly global: string;
  readonly environment: string;
  /** What the Settings and the set both say of Global's, which is left out. */
  readonly text: string;
};

/**
 * The Environment's own entries that shadow one of Global's by a twin name, differing from it only in case or in
 * `-`/`_`: the Environment has the last word, so Global's is left out of its set and of its settings alike. Names that
 * are the same replace instead, and are not here.
 */
export const mcpShadowedTwins = (
  globalNames: ReadonlyArray<string>,
  environmentNames: ReadonlyArray<string>,
): ReadonlyArray<McpShadowedTwin> =>
  Arr.filterMap(globalNames, (global) => {
    const twin = Arr.findFirst(
      environmentNames,
      (held) => held !== global && normalizeMcpName(held) === normalizeMcpName(global),
    );

    return Option.isSome(twin)
      ? Result.succeed({
          global,
          environment: twin.value,
          text: `is left out: this Environment's own "${twin.value}" is a name that differs only in case or in - and _, and it has the last word`,
        })
      : Result.failVoid;
  });

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** One key of an adjustment, as it changes the entry it adjusts. */
export type McpAdjustmentStep = {
  readonly key: string;
  readonly set: (entry: Writable<McpServerValue>) => void;
};

/** What an adjustment's key refused for: it would make the entry over its bound once applied. */
export const MCP_ADJUSTMENT_OVER = `makes the entry over ${MCP_LIMITS.entryBytes / 1024} KiB once applied over the server it adjusts`;

/**
 * The steps of an owner's adjustment `adjustment`: each key it holds replaces the entry's own, `{ ...base, ...value }`.
 */
export const mcpAdjustmentSteps = (
  adjustment: McpServerValue,
): ReadonlyArray<McpAdjustmentStep> => {
  const steps: Array<McpAdjustmentStep> = [];

  if (adjustment.enabled !== undefined) {
    const enabled = adjustment.enabled;

    steps.push({ key: "enabled", set: (entry) => void (entry.enabled = enabled) });
  }

  if (adjustment.exposure !== undefined) {
    const exposure = adjustment.exposure;

    steps.push({ key: "exposure", set: (entry) => void (entry.exposure = exposure) });
  }

  if (adjustment.toolExposure !== undefined) {
    const toolExposure = adjustment.toolExposure;

    steps.push({ key: "toolExposure", set: (entry) => void (entry.toolExposure = toolExposure) });
  }

  return steps;
};

/** An entry with an adjustment applied, and the keys of it that were refused. */
export type McpAdjusted = {
  readonly value: McpServerValue;
  readonly refused: ReadonlyArray<string>;
};

/**
 * `base`, an entry that stands, with `steps` applied in order, each only while the entry stays within its bound
 * (16 KiB): a key that would grow it over is `refused` and left out, so the keys that fit still apply. The bound
 * is measured without `enabled` and `exposure` (`mcpEntryBytes`), so switching a server off is always possible and
 * only `toolExposure` growth is fitted; a key that does not grow the entry is never refused, which matters for a
 * Repo's entry, held with the `cwd` it was given and so over the bound by it. The Settings and the set both apply
 * adjustments through this, so they agree on what a Global entry that grew, or an adjustment that is large, leaves
 * in force.
 */
export const applyMcpAdjustmentSteps = (
  base: McpServerValue,
  steps: ReadonlyArray<McpAdjustmentStep>,
): McpAdjusted => {
  let value = base;
  const refused: Array<string> = [];

  for (const step of steps) {
    const next: Writable<McpServerValue> = { ...value };

    step.set(next);

    const size = mcpEntryBytes(next);

    if (size > MCP_LIMITS.entryBytes && size > mcpEntryBytes(value)) {
      refused.push(step.key);
    } else {
      value = next;
    }
  }

  return { value, refused };
};

/**
 * `document` with each adjustment of its `mcp.servers` (an Environment's Overrides) that has a base in `inherited`
 * (Global's, as the settings hold them) held to the entry bound once applied over it (`applyMcpAdjustmentSteps`): a key
 * that makes the entry too big is left out, as the Override field of its own that it is, and the Settings' problem says
 * so. An adjustment of a server `inherited` lacks (a Repo's) is as it was: the Settings do not see the Repo's.
 */
export const withMcpAdjustmentsFitted = (
  inherited: Schema.JsonObject,
  document: Schema.JsonObject,
): McpLayerDocument => {
  const mcp = document[MCP_ROOT];
  const servers = mcpServersOf(document);
  const bases = mcpServersOf(inherited);

  if (mcp === undefined || !isJsonObject(mcp) || !isJsonObject(servers) || !isJsonObject(bases)) {
    return { document, problems: [] };
  }

  const problems: Array<SettingsProblem> = [];
  const kept: Array<readonly [string, Schema.Json]> = [];

  for (const [name, written] of Record.toEntries(servers)) {
    const base = bases[name];
    const given = isJsonObject(written) && !isMcpFullEntry(written);
    const decodedBase = base === undefined ? undefined : decodeMcpServerValue(base);
    const decoded = given ? decodeMcpServerValue(written) : undefined;

    if (
      !given ||
      decodedBase === undefined ||
      Result.isFailure(decodedBase) ||
      decoded === undefined ||
      Result.isFailure(decoded)
    ) {
      kept.push([name, written]);

      continue;
    }

    const { refused } = applyMcpAdjustmentSteps(
      decodedBase.success,
      mcpAdjustmentSteps(decoded.success),
    );

    for (const key of refused) {
      problems.push(mcpLayerProblemOf({ name, keys: [key], text: MCP_ADJUSTMENT_OVER }));
    }

    const left = Arr.filter(Record.toEntries(written), ([key]) => !Arr.contains(refused, key));

    if (left.length > 0) kept.push([name, Record.fromEntries(left)]);
  }

  return { document: withServers(document, mcp, Record.fromEntries(kept)), problems };
};

/** An entry in force: what an MCP server is, with every default applied. */
type McpCommon = {
  readonly enabled: boolean;
  readonly exposure: McpExposure;
  readonly toolExposure: Readonly<Record<string, McpExposure>>;
  readonly timeout: number;
  readonly description?: string | undefined;
  readonly sampling: McpSampling;
};

/** A command the Workspace's Container runs. */
export type McpStdioServer = McpCommon & {
  readonly type: "stdio";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
};

/** A Streamable HTTP server. */
export type McpHttpServer = McpCommon & {
  readonly type: "http";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly oauth?: McpOauth | undefined;
};

/** An MCP server as the set holds it, with `${NAME}` unresolved. */
export type McpServerEntry = McpStdioServer | McpHttpServer;

/** pi's `codemode-deferred` is `codemode`. */
export const normalizedExposure = (exposure: McpExposure | typeof CODEMODE_DEFERRED): McpExposure =>
  exposure === CODEMODE_DEFERRED ? "codemode" : exposure;

/** The default `timeout`, in seconds. */
export const DEFAULT_MCP_TIMEOUT = 60;

const oauthInForce = (oauth: McpOauth | undefined): McpOauth | undefined =>
  oauth === undefined
    ? undefined
    : {
        ...oauth,
        clientRegistration: oauth.clientRegistration ?? "auto",
        grantType: oauth.grantType ?? "authorization_code",
      };

/** `exposures` with `codemode-deferred` read as `codemode`. */
const exposuresInForce = (
  exposures: Readonly<Record<string, McpExposure | typeof CODEMODE_DEFERRED>> | undefined,
): Readonly<Record<string, McpExposure>> => Record.map(exposures ?? {}, normalizedExposure);

/**
 * The entry in force of a full entry as written (one that decoded): its type read from `command` or `url`, the defaults
 * applied (`enabled`, `exposure` `codemode`, `timeout` 60, `sampling` `ask`), `streamable-http` as `http`. Undefined for
 * an MCP server adjustment.
 */
export const normalizeMcpServer = (value: McpServerValue): McpServerEntry | undefined => {
  const common = {
    enabled: value.enabled ?? true,
    exposure: normalizedExposure(value.exposure ?? "codemode"),
    toolExposure: exposuresInForce(value.toolExposure),
    timeout: value.timeout ?? DEFAULT_MCP_TIMEOUT,
    description: value.description,
    sampling: value.sampling ?? "ask",
  };

  if (value.command !== undefined) {
    return {
      ...common,
      type: "stdio",
      command: value.command,
      args: value.args ?? [],
      env: value.env ?? {},
      cwd: value.cwd,
    };
  }

  if (value.url !== undefined) {
    return {
      ...common,
      type: "http",
      url: value.url,
      headers: value.headers ?? {},
      oauth: oauthInForce(value.oauth),
    };
  }

  return undefined;
};

/**
 * A note on an entry that is accepted as it is: not a problem, and nothing is skipped. `kind` must gain a fallback member
 * before a hint crosses an RPC edge (`docs/architecture/mcp.md` → Deploys: every state carries one), so that a newer
 * kind reads on an older Worker. `oauth-callback-ignored`:
 * `callbackPort` or `callbackUrl` is read and ignored, since cloudpid signs in at its own redirect URI.
 */
export type McpEntryHint = {
  readonly kind: "oauth-callback-ignored";
  /** The ignored `oauth` keys the entry holds. */
  readonly keys: ReadonlyArray<string>;
  readonly message: string;
};

/** A hint on the entry of that name. */
export type McpNamedHint = McpEntryHint & { readonly name: string };

/**
 * The hints for entry `value` as written. The redirect URI itself depends on the stage's app origin, which is not known
 * here: the Settings page's Sign-in disclosure shows it beside the fields (`docs/architecture/mcp-sign-in.md`), and says so
 * where it shows this hint.
 */
export const mcpEntryHints = (value: McpServerValue): ReadonlyArray<McpEntryHint> => {
  const keys = Arr.filter(OAUTH_IGNORED, (key) => value.oauth?.[key] !== undefined);

  return keys.length === 0
    ? []
    : [
        {
          kind: "oauth-callback-ignored",
          keys,
          message: `oauth.${Arr.join(keys, " and oauth.")} ${keys.length === 1 ? "is" : "are"} accepted and ignored: cloudpid signs in at its own redirect URI, which the Settings page shows beside the oauth fields`,
        },
      ];
};

/** Why a Repo's file, or an entry of it, is skipped or read otherwise: the entry's name, or none for the file. */
export type McpFileProblem = { readonly name: string | null; readonly message: string };

/**
 * What a Repo's `.pi/mcp.json` gives: the entries that stand, a problem for each that does not or reads otherwise, and
 * the hints on those that stand.
 */
export type McpRepoFile = {
  readonly entries: ReadonlyArray<McpNamedEntry>;
  readonly problems: ReadonlyArray<McpFileProblem>;
  readonly hints: ReadonlyArray<McpNamedHint>;
};

const parseJson = (text: string): Option.Option<Schema.Json> =>
  Result.getSuccess(
    Result.try({
      try: (): Schema.Json => JSON.parse(text),
      catch: () => "not JSON",
    }),
  );

const SWITCH_OFF_PROBLEM =
  "a Repo's adjustment may only switch off (enabled: false, exposure: hidden, hidden in toolExposure)";

/** Whether `value` (a decoded adjustment) only switches off. */
const onlySwitchesOff = (value: McpServerValue): boolean =>
  (value.enabled === undefined || value.enabled === false) &&
  (value.exposure === undefined || value.exposure === "hidden") &&
  Arr.every(Record.values(value.toolExposure ?? {}), (exposure) => exposure === "hidden");

/** Whether `value` holds something to apply. */
const holdsAdjustment = (value: McpServerValue): boolean =>
  Arr.some(MCP_ADJUSTMENT_KEYS, (key) => value[key] !== undefined);

/**
 * The servers of a Repo's `.pi/mcp.json` (`text`, the file as read), for the Repo in directory `directory`: the
 * Repo's entries and adjustments, or why they are skipped (ADR-0029, D6 and D10 of the MCP server configuration design).
 *
 * - A file that is over 64 KiB, not JSON, or without an `mcpServers` object gives no servers, with a problem; so does one
 *   over a bound (more than 50 servers, a name over 64 characters, an entry over its bounds).
 * - An entry that is not an object, has a name that is not one or that is the twin of an earlier entry's, breaks a
 *   rule of Settings (an unknown key, `sse`, `auth`, `~`, a `!command` value, a bad `oauth`), or has a `cwd` that is
 *   absolute or leaves the Repo is skipped with its problem. `cwd` is made absolute, `/workspace/<directory>/<cwd>`, and
 *   is the Repo's directory for a stdio entry without one. A literal `oauth` secret stands: the file is public already.
 * - `sampling: "allow"` is read as `ask`, with a problem saying to copy the entry into the Settings.
 * - An adjustment that does more than switch off is skipped with a problem.
 * - `oauth.callbackPort` and `oauth.callbackUrl` are read and ignored, with a hint (`mcpEntryHints`).
 */
export const readMcpRepoFile = (text: string, directory: string): McpRepoFile => {
  const skipped = (message: string): McpRepoFile => ({
    entries: [],
    problems: [{ name: null, message }],
    hints: [],
  });

  if (utf8Bytes(text) > MCP_LIMITS.repoFileBytes) {
    return skipped(`is over ${MCP_LIMITS.repoFileBytes / 1024} KiB`);
  }

  const parsed = parseJson(text);

  if (Option.isNone(parsed)) return skipped("is not valid JSON");

  const servers = isJsonObject(parsed.value) ? parsed.value["mcpServers"] : undefined;

  if (servers === undefined || !isJsonObject(servers)) {
    return skipped("has no mcpServers object");
  }

  const given = Record.toEntries(servers);

  if (given.length > MCP_LIMITS.servers) {
    return skipped(`has more than ${MCP_LIMITS.servers} servers`);
  }

  const overName = Arr.findFirst(given, ([name]) => name.length > MCP_LIMITS.name);

  if (Option.isSome(overName)) {
    return skipped(`has a server name over ${MCP_LIMITS.name} characters`);
  }

  for (const [name, value] of given) {
    if (!isJsonObject(value)) continue;

    // SAFETY: the bounds read only the keys of the schema, each of which is there or not; the decode below checks types.
    const over = mcpEntryBoundsProblems(value as McpServerValue);

    if (over.length > 0) return skipped(`${name} ${over[0]}`);
  }

  const base = `/workspace/${directory}`;
  const entries: Array<McpNamedEntry> = [];
  const problems: Array<McpFileProblem> = [];
  const hints: Array<McpNamedHint> = [];
  const seen = new Map<string, string>();

  for (const [name, written] of given) {
    const skip = (message: string) => problems.push({ name, message });

    const unnamed = nameProblem(name, seen);

    if (unnamed !== undefined) {
      skip(`is skipped: ${unnamed}`);

      continue;
    }

    if (!isJsonObject(written)) {
      skip("is skipped: an entry is an object");

      continue;
    }

    const value =
      written["sampling"] === "allow"
        ? Record.map(written, (entry, key) => (key === "sampling" ? "ask" : entry))
        : written;

    if (written["sampling"] === "allow") {
      skip('has sampling "allow", read as "ask": copy it into the Settings to allow it');
    }

    const decoded = decodeMcpServerValue(value, "repo");

    if (Result.isFailure(decoded)) {
      skip(`is skipped: ${problemLines(decoded.failure, "; ")}`);

      continue;
    }

    const entry = decoded.success;

    if (isMcpFullEntry(entry)) {
      for (const hint of mcpEntryHints(entry)) hints.push({ ...hint, name });

      seen.set(normalizeMcpName(name), name);

      entries.push({
        name,
        value:
          entry.command === undefined
            ? entry
            : { ...entry, cwd: mcpRepoCwd(directory, entry.cwd) ?? base },
      });
    } else if (!holdsAdjustment(entry)) {
      skip("is skipped: it holds nothing");
    } else if (!onlySwitchesOff(entry)) {
      skip(`is skipped: ${SWITCH_OFF_PROBLEM}`);
    } else {
      seen.set(normalizeMcpName(name), name);
      entries.push({ name, value: entry });
    }
  }

  return { entries, problems, hints };
};
