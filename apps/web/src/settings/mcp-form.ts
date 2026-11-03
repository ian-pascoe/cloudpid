// @effect-diagnostics missingPipeableSignature:off -- builders and checks of plain values, not combinators.

// The Add/Edit form of an MCP server (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section):
// the fields as the form holds them, the entry they make (pi's shape, as written: no default is filled in), and what is
// wrong with it before it is saved. The form and its raw-JSON tab are one value: `entryOfFields` and `fieldsOfEntry` go
// between them. A save is checked as the Registry checks it (`decodeMcpServerValue`), so a refusal there is rare.
//
// As built: the form keeps the keys it has no field for (`type`, and the `oauth` keys cloudpid ignores) as they were, and the
// JSON tab edits them. The Sign-in (OAuth) disclosure's fields are `McpOauthFields` (docs/architecture/mcp-sign-in.md → The
// `oauth` fields); the disclosure itself is `mcp-sign-in-form.tsx`.

import {
  decodeMcpServerValue,
  DEFAULT_MCP_TIMEOUT,
  isJsonObject,
  isMcpFullEntry,
  MCP_EXPOSURES,
  MCP_LIMITS,
  MCP_NAME,
  type McpCredentialLiteral,
  mcpCredentialLiterals,
  type McpExposure,
  type McpSampling,
  type McpServerValue,
  normalizeMcpName,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import {
  type McpNames,
  mcpMissingReferenceProblem,
  mcpMissingReferences,
  mcpReferencesOf,
  type McpReferenceNames,
  type McpRow,
  isRepoRow,
  repoBaseOf,
  repoDirectoryOf,
} from "./mcp-model.ts";

/** A `KEY=value` row of `env` or `headers`. */
export interface McpKeyValue {
  readonly key: string;
  readonly value: string;
}

/** A `toolExposure` row: a tool's name, or a `*` pattern, and how it reaches the model. */
export interface McpToolRow {
  readonly pattern: string;
  readonly exposure: McpExposure;
}

/** The `oauth` fields the form has an input for, in the order an entry writes them. */
export const MCP_OAUTH_TEXT_KEYS = [
  "clientId",
  "clientSecret",
  "privateKey",
  "keyId",
  "scope",
  "clientName",
] as const;

/** The `oauth` fields that pin the authorization server. */
export const MCP_OAUTH_PIN_KEYS = ["authServerMetadataUrl", "issuer"] as const;

export type McpOauthTextKey =
  | (typeof MCP_OAUTH_TEXT_KEYS)[number]
  | (typeof MCP_OAUTH_PIN_KEYS)[number];

/** How a client registers (`oauth.clientRegistration`). */
export const MCP_CLIENT_REGISTRATIONS = ["auto", "cimd", "dcr"] as const;

export type McpClientRegistration = (typeof MCP_CLIENT_REGISTRATIONS)[number];

/** How the server is signed in to (`oauth.grantType`). */
export const MCP_GRANT_TYPES = ["authorization_code", "client_credentials"] as const;

export type McpGrantType = (typeof MCP_GRANT_TYPES)[number];

/**
 * The "Sign-in (OAuth)" fields (→ The `oauth` fields), as typed. `clientSecret` and `privateKey` are `${NAME}` references:
 * the page never holds a value of a Secret. `kept` is the keys of `oauth` the form has no field for (the ignored
 * `callbackPort` and `callbackUrl`, and a value an older entry holds that is not one the form can show), as they were.
 */
export interface McpOauthFields {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: string;
  readonly keyId: string;
  readonly scope: string;
  readonly clientName: string;
  readonly authServerMetadataUrl: string;
  readonly issuer: string;
  readonly clientRegistration: McpClientRegistration;
  readonly grantType: McpGrantType;
  readonly kept: Schema.JsonObject;
}

/** No `oauth` fields: a server that signs in with no settings. */
export const EMPTY_MCP_OAUTH: McpOauthFields = {
  clientId: "",
  clientSecret: "",
  privateKey: "",
  keyId: "",
  scope: "",
  clientName: "",
  authServerMetadataUrl: "",
  issuer: "",
  clientRegistration: "auto",
  grantType: "authorization_code",
  kept: {},
};

const isRegistration = (value: Schema.Json | undefined): value is McpClientRegistration =>
  Arr.some(MCP_CLIENT_REGISTRATIONS, (known) => known === value);

const isGrantType = (value: Schema.Json | undefined): value is McpGrantType =>
  Arr.some(MCP_GRANT_TYPES, (known) => known === value);

/** The fields of the `oauth` object `written`: every string it holds, and the rest kept as it was. */
export const oauthFieldsOf = (written: Schema.Json | undefined): McpOauthFields => {
  if (written === undefined || !isJsonObject(written)) return EMPTY_MCP_OAUTH;

  const text = (key: McpOauthTextKey): string => {
    const value = written[key];

    return Predicate.isString(value) ? value : "";
  };

  const registration = written["clientRegistration"];
  const grant = written["grantType"];

  return {
    clientId: text("clientId"),
    clientSecret: text("clientSecret"),
    privateKey: text("privateKey"),
    keyId: text("keyId"),
    scope: text("scope"),
    clientName: text("clientName"),
    authServerMetadataUrl: text("authServerMetadataUrl"),
    issuer: text("issuer"),
    clientRegistration: isRegistration(registration) ? registration : "auto",
    grantType: isGrantType(grant) ? grant : "authorization_code",
    kept: Record.filter(written, (value, key) => {
      const known = Arr.contains(MCP_OAUTH_TEXT_KEYS, key) || Arr.contains(MCP_OAUTH_PIN_KEYS, key);

      if (known) return !Predicate.isString(value);

      if (key === "clientRegistration") return !isRegistration(value);

      if (key === "grantType") return !isGrantType(value);

      return true;
    }),
  };
};

/**
 * The `oauth` object the fields make, as written: a key only where it holds something (no default: `auto` and
 * `authorization_code` are left out), in the order of the spec, then `kept`. A field the grant type does not use is left out,
 * so one typed and then hidden is not saved: `privateKey` and `keyId` are for client credentials, `clientName` and
 * `clientRegistration` for an authorization code.
 */
export const oauthOfFields = (oauth: McpOauthFields): Schema.JsonObject => {
  const grant = oauth.grantType === "client_credentials";
  const written: Record<string, Schema.Json> = {};

  const put = (key: McpOauthTextKey) => {
    if (oauth[key] !== "") written[key] = oauth[key];
  };

  put("clientId");
  put("clientSecret");

  if (grant) {
    put("privateKey");
    put("keyId");
  }

  put("scope");

  if (!grant) put("clientName");

  if (!grant && oauth.clientRegistration !== "auto") {
    written["clientRegistration"] = oauth.clientRegistration;
  }

  put("authServerMetadataUrl");
  put("issuer");

  if (grant) written["grantType"] = oauth.grantType;

  return Record.union(written, oauth.kept, (_, kept) => kept);
};

/** The form's fields. */
export interface McpFields {
  readonly name: string;
  readonly kind: "stdio" | "http";
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly url: string;
  readonly env: ReadonlyArray<McpKeyValue>;
  readonly headers: ReadonlyArray<McpKeyValue>;
  /** Seconds, as typed; empty for the default. */
  readonly timeout: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly exposure: McpExposure;
  readonly sampling: McpSampling;
  readonly toolExposure: ReadonlyArray<McpToolRow>;
  /** The "Sign-in (OAuth)" fields of an HTTP server. */
  readonly oauth: McpOauthFields;
  /** The keys of the entry the form has no field for (`type`), kept as they were. */
  readonly kept: Schema.JsonObject;
}

/** A form with nothing in it, for a server of kind `kind`. */
export const emptyMcpFields = (kind: "stdio" | "http" = "http"): McpFields => ({
  name: "",
  kind,
  command: "",
  args: [],
  cwd: "",
  url: "",
  env: [],
  headers: [],
  timeout: "",
  description: "",
  enabled: true,
  exposure: "codemode",
  sampling: "ask",
  toolExposure: [],
  oauth: EMPTY_MCP_OAUTH,
  kept: {},
});

const pairsOf = (
  record: Readonly<Record<string, string>> | undefined,
): ReadonlyArray<McpKeyValue> =>
  Arr.map(Record.toEntries(record ?? {}), ([key, value]) => ({ key, value }));

/** The keys the form has a field for: the rest of an entry is `kept`. */
const FORM_KEYS: ReadonlyArray<string> = [
  "command",
  "args",
  "env",
  "cwd",
  "url",
  "headers",
  "timeout",
  "description",
  "enabled",
  "exposure",
  "sampling",
  "toolExposure",
  "oauth",
];

const codemodeOf = (exposure: McpExposure | "codemode-deferred"): McpExposure =>
  exposure === "codemode-deferred" ? "codemode" : exposure;

/**
 * The fields of the entry `written` of server `name`, as the Settings read it; for one that does not decode, empty
 * fields with the entry kept whole (the JSON tab then shows it).
 */
export const fieldsOfEntry = (name: string, written: Schema.JsonObject): McpFields => {
  const decoded = decodeMcpServerValue(written);

  if (Result.isFailure(decoded)) return { ...emptyMcpFields(), name, kept: written };

  const value = decoded.success;

  return {
    name,
    kind: value.command === undefined ? "http" : "stdio",
    command: value.command ?? "",
    args: value.args ?? [],
    cwd: value.cwd ?? "",
    url: value.url ?? "",
    env: pairsOf(value.env),
    headers: pairsOf(value.headers),
    timeout: value.timeout === undefined ? "" : String(value.timeout),
    description: value.description ?? "",
    enabled: value.enabled ?? true,
    exposure: codemodeOf(value.exposure ?? "codemode"),
    sampling: value.sampling ?? "ask",
    toolExposure: Arr.map(Record.toEntries(value.toolExposure ?? {}), ([pattern, exposure]) => ({
      pattern,
      exposure: codemodeOf(exposure),
    })),
    oauth: oauthFieldsOf(written["oauth"]),
    kept: Record.filter(written, (_, key) => !Arr.contains(FORM_KEYS, key)),
  };
};

const recordOf = (rows: ReadonlyArray<McpKeyValue>): Schema.JsonObject =>
  Record.fromEntries(
    Arr.map(
      Arr.filter(rows, ({ key, value }) => key !== "" || value !== ""),
      ({ key, value }) => [key, value] as const,
    ),
  );

/** `toolExposure` as an object, in the order of the rows: the first pattern that matches wins. */
export const toolExposureOfRows = (
  rows: ReadonlyArray<McpToolRow>,
): Readonly<Record<string, McpExposure>> =>
  Record.fromEntries(
    Arr.map(
      Arr.filter(rows, ({ pattern }) => pattern !== ""),
      ({ pattern, exposure }) => [pattern, exposure] as const,
    ),
  );

/** `toolExposure` as rows, in the order the entry has them. */
export const rowsOfToolExposure = (
  toolExposure: Readonly<Record<string, McpExposure>>,
): ReadonlyArray<McpToolRow> =>
  Arr.map(Record.toEntries(toolExposure), ([pattern, exposure]) => ({ pattern, exposure }));

/**
 * The entry the fields make, as written: a key only where it differs from its default (`enabled` when off, `exposure`
 * but `codemode`, `sampling` but `ask`), the keys of the other transport left out, and `kept` as it was.
 */
export const entryOfFields = (fields: McpFields): Schema.JsonObject => {
  const stdio = fields.kind === "stdio";
  const timeout = fields.timeout.trim() === "" ? Number.NaN : Number(fields.timeout);
  const env = recordOf(fields.env);
  const headers = recordOf(fields.headers);
  const toolExposure = toolExposureOfRows(fields.toolExposure);

  const entry: Record<string, Schema.Json> = Record.fromEntries(Record.toEntries(fields.kept));

  if (stdio) entry["command"] = fields.command;
  else entry["url"] = fields.url;

  if (stdio && fields.args.length > 0) entry["args"] = [...fields.args];

  if (stdio && !Record.isEmptyRecord(env)) entry["env"] = env;

  if (stdio && fields.cwd !== "") entry["cwd"] = fields.cwd;

  if (!stdio && !Record.isEmptyRecord(headers)) entry["headers"] = headers;

  if (!Number.isNaN(timeout)) entry["timeout"] = timeout;

  if (fields.description !== "") entry["description"] = fields.description;

  if (!fields.enabled) entry["enabled"] = false;

  if (fields.exposure !== "codemode") entry["exposure"] = fields.exposure;

  if (fields.sampling !== "ask") entry["sampling"] = fields.sampling;

  if (!Record.isEmptyRecord(toolExposure)) entry["toolExposure"] = toolExposure;

  const oauth = oauthOfFields(fields.oauth);

  // An HTTP server's sign-in; a stdio server has none (the entry would be refused).
  if (!stdio && !Record.isEmptyRecord(oauth)) entry["oauth"] = oauth;

  return entry;
};

/** `entry` as the JSON tab shows it. */
export const jsonOfEntry = (entry: Schema.JsonObject): string => JSON.stringify(entry, null, 2);

/** The entry the JSON tab's text is, or why it is not one. */
export const entryOfJson = (text: string): Result.Result<Schema.JsonObject, string> => {
  try {
    const parsed: Schema.Json = JSON.parse(text);

    return isJsonObject(parsed)
      ? Result.succeed(parsed)
      : Result.fail('The server is one JSON object, such as {"url": "https://…"}');
  } catch (error) {
    return Result.fail(`Not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** What an Add or an Edit at a Scope may call its server. */
export interface McpNameRules {
  readonly names: McpNames;
  /** Whether the Scope is Global. */
  readonly atGlobal: boolean;
  /** The server being edited, whose own name is allowed. */
  readonly editing: string | null;
}

/**
 * Why `name` cannot name a server at the Scope, or null. At an Environment Global's own name is allowed: the
 * Environment's entry replaces it there.
 */
export const mcpNameProblem = (
  name: string,
  { names, atGlobal, editing }: McpNameRules,
): string | null => {
  if (name === "") return "Name the server.";

  if (name.length > MCP_LIMITS.name || !MCP_NAME.test(name)) {
    return `A name is letters, digits, - and _, at most ${MCP_LIMITS.name} characters.`;
  }

  if (name === editing) return null;

  const own = atGlobal ? names.global : names.own;

  if (Arr.contains(own, name)) {
    return atGlobal
      ? "Global has a server of that name: edit it."
      : "This environment has its own server of that name: edit it.";
  }

  const others = [
    ...(atGlobal ? [] : Arr.filter(names.global, (held) => held !== name)),
    ...own,
    ...Arr.filter(names.adjusted, (held) => held !== name),
  ];

  return Option.match(
    Arr.findFirst(others, (held) => normalizeMcpName(held) === normalizeMcpName(name)),
    {
      onNone: () => null,
      onSome: (twin) =>
        `Clashes with "${twin}": names that differ only in case or in - and _ are one server.`,
    },
  );
};

/** What stands in the way of saving a server, and what to warn of. */
export interface McpFormCheck {
  /** The entry, when it decodes. */
  readonly entry: Schema.JsonObject | null;
  /** Each reason it cannot be saved. */
  readonly problems: ReadonlyArray<string>;
  /** Credential-shaped literals: a warning, not a refusal. */
  readonly warnings: ReadonlyArray<McpCredentialLiteral>;
  /** At Global, `${NAME}`s kept neither as a Secret nor as a Variable: a hint. */
  readonly hints: ReadonlyArray<string>;
}

const decodedProblems = (entry: Schema.JsonObject): ReadonlyArray<string> => {
  const decoded = decodeMcpServerValue(entry);

  if (Result.isFailure(decoded)) return Arr.map(decoded.failure, (problem) => problem.line);

  return isMcpFullEntry(decoded.success) ? [] : ["Give it a command (stdio) or a url (HTTP)."];
};

/**
 * Check the entry `entry` of server `name` at a Scope: the name's rules, the schema's (as the Registry decodes it), and
 * the `${NAME}`s it reads against `references`, which at an Environment must all resolve (the Registry refuses such an
 * entry from the agent, and the page holds it to the same) and at Global are a hint. `references` is null until the
 * Scope's Secrets and Variables are known.
 */
export const checkMcpEntry = (input: {
  readonly name: string;
  readonly entry: Schema.JsonObject;
  readonly rules: McpNameRules;
  readonly references: McpReferenceNames | null;
}): McpFormCheck => {
  const { name, entry, rules, references } = input;
  const nameProblem = mcpNameProblem(name, rules);
  const decoded = decodeMcpServerValue(entry);
  const value: McpServerValue | null = Result.isSuccess(decoded) ? decoded.success : null;
  const used = value === null ? [] : mcpReferencesOf(value);
  const missing = references === null ? [] : mcpMissingReferences(used, references);

  return {
    entry: value === null ? null : entry,
    problems: [
      ...(nameProblem === null ? [] : [nameProblem]),
      ...decodedProblems(entry),
      ...(rules.atGlobal ? [] : Arr.map(missing, mcpMissingReferenceProblem)),
    ],
    warnings: value === null ? [] : mcpCredentialLiterals(value),
    hints: rules.atGlobal
      ? Arr.map(
          missing,
          (reference) =>
            `${reference.where} reads \${${reference.name}}, which Global keeps neither as a Secret nor as a Variable: each environment that lacks it says so on its page.`,
        )
      : [],
  };
};

/** Why the fields cannot make an entry (a timeout that is no number, a pattern given twice), before it is checked. */
export const mcpFieldsProblems = (fields: McpFields): ReadonlyArray<string> => {
  const timeout = fields.timeout.trim();

  const patterns = Arr.filter(
    Arr.map(fields.toolExposure, ({ pattern }) => pattern),
    (pattern) => pattern !== "",
  );

  return [
    ...(timeout !== "" && !(Number(timeout) > 0)
      ? [`Timeout is seconds above zero (it is ${DEFAULT_MCP_TIMEOUT} when empty).`]
      : []),
    ...(Arr.dedupe(patterns).length < patterns.length
      ? ["A tool exposure pattern is given twice: only the first one counts."]
      : []),
  ];
};

/** The Exposures as a select names them. */
export const MCP_EXPOSURE_LABELS: Readonly<Record<McpExposure, string>> = {
  codemode: "Codemode",
  deferred: "Deferred",
  direct: "Direct",
  hidden: "Hidden",
};

/** Every Exposure, in the order a select offers them. */
export const MCP_EXPOSURE_OPTIONS: ReadonlyArray<McpExposure> = MCP_EXPOSURES;

/** "Model use" (`sampling`): the words of its select. */
export const MCP_SAMPLING_LABELS: Readonly<Record<McpSampling, string>> = {
  ask: "Ask",
  allow: "Allow",
  off: "Off",
};

/** The form of an Add or an Edit: its fields, which tab is shown, and the JSON tab's text. */
export interface McpFormDraft {
  readonly kind: "form";
  /**
   * `add`; `edit` of the Scope's own server `name`; `replace`, a copy of Global's `name` as this Environment's own; `copy`,
   * a copy of a Repo's server (`copiedFrom`) kept at the Scope.
   */
  readonly mode: "add" | "edit" | "replace" | "copy";
  /** For a `copy`, the directory of the Repo whose entry it is. */
  readonly copiedFrom?: string | undefined;
  readonly fields: McpFields;
  readonly tab: "form" | "json";
  readonly json: string;
  /** Why the JSON tab's text cannot be read into the form, while it is shown. */
  readonly jsonProblem: string | null;
}

/** The editor of a Global server's tool exposure at an Environment, which is an adjustment. */
export interface McpToolsDraft {
  readonly kind: "tools";
  readonly name: string;
  /** The rows the owner edits: all of the tool exposure, or for a Repo's server only what is added to its file's. */
  readonly rows: ReadonlyArray<McpToolRow>;
  /** A Repo's server only: the rows its file gives, which are not the owner's to change. */
  readonly fixed: ReadonlyArray<McpToolRow>;
}

/** What a form of mode `mode` starts from: empty fields for an Add, or the entry `written` of server `name`. */
export const newMcpForm = (
  mode: McpFormDraft["mode"],
  name: string,
  written: Schema.JsonObject | null,
  copiedFrom?: string,
): McpFormDraft => ({
  kind: "form",
  mode,
  copiedFrom,
  fields: written === null ? emptyMcpFields() : fieldsOfEntry(name, written),
  tab: "form",
  json: "",
  jsonProblem: null,
});

/**
 * The form `draft` after the owner shows tab `tab`: to JSON it writes the fields' entry out; back to the form it reads
 * the JSON into the fields, or stays on the JSON tab saying why it cannot.
 */
export const mcpFormShowing = (draft: McpFormDraft, tab: McpFormDraft["tab"]): McpFormDraft => {
  if (tab === draft.tab) return draft;

  if (tab === "json") {
    return { ...draft, tab, json: jsonOfEntry(entryOfFields(draft.fields)), jsonProblem: null };
  }

  const parsed = entryOfJson(draft.json);

  if (Result.isFailure(parsed)) return { ...draft, jsonProblem: parsed.failure };

  const decoded = decodeMcpServerValue(parsed.success);

  if (Result.isFailure(decoded)) {
    return {
      ...draft,
      jsonProblem: `The form cannot show it until it is fixed: ${Arr.join(
        Arr.map(decoded.failure, (problem) => problem.line),
        "; ",
      )}`,
    };
  }

  return {
    ...draft,
    tab,
    fields: fieldsOfEntry(draft.fields.name, parsed.success),
    jsonProblem: null,
  };
};

/**
 * The form of a copy of Repo server `row`'s entry, to keep at the Scope whose panel shows it: the entry as its file gives it
 * (`${NAME}` kept, `cwd` made absolute), the owner's from then on, checked as any entry of the Scope is.
 */
export const mcpCopyForm = (row: McpRow): McpFormDraft =>
  newMcpForm("copy", row.name, row.written, repoDirectoryOf(row) ?? undefined);

/**
 * The editor of server `row`'s tool exposure at an Environment: it starts from the exposure in force. For a Repo's server
 * the file's own rows are `fixed`, and the owner's rows are those in force beyond them: the owner can only add to them
 * (`mcpRepoToolExposure`).
 */
export const toolsDraftOf = (row: McpRow): McpToolsDraft => {
  if (!isRepoRow(row)) {
    return {
      kind: "tools",
      name: row.name,
      rows: rowsOfToolExposure(row.server.toolExposure),
      fixed: [],
    };
  }

  const base = repoBaseOf(row).toolExposure;

  return {
    kind: "tools",
    name: row.name,
    rows: rowsOfToolExposure(
      Record.filter(row.server.toolExposure, (exposure, pattern) => base[pattern] !== exposure),
    ),
    fixed: rowsOfToolExposure(base),
  };
};
