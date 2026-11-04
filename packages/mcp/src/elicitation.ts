/**
 * An MCP server's question to cloudpid, and the form of an elicitation (`docs/architecture/mcp-server-requests.md` →
 * Questions, Elicitation requests → The form; ADR-0037, ADR-0041). Pure and SDK-free, so the Session, the `mcp`
 * extension, the engine's edge and the web app all import it (`./types`).
 *
 * - **The question's shape:** `McpInputRequest` is what the core hands the call's `onInput`, `McpInputAnswer` what it
 *   gets back; an elicitation's answer is the spec's own `ElicitResult`.
 * - **The normalizer** makes cloudpid's own `ElicitationForm` (`@cloudpid/protocol`) of the server's `requestedSchema`,
 *   checking it against the spec's flat subset, its bounds and the credential rule, so the web never reads raw JSON
 *   Schema and a form that is malformed or asks for a credential is refused without being shown.
 * - **The validator** checks the owner's values against the form, in the web before Submit and again in the Session.
 */
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over values, with loops that end early.
import {
  type ElicitationContent,
  type ElicitationField,
  type ElicitationForm,
  type ElicitationOption,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { isJsonObject, JsonObject } from "./json.ts";

/** How long a Legacy elicitation waits for the owner, from the ask: 10 minutes (`ctx.answers.inputWaitMs`). */
export const MCP_ELICITATION_WAIT_MS = 10 * 60 * 1000;

/**
 * How long a question waits for the owner during a prompt send's `prompts/get`, or an App View's `tools/call`, from the ask:
 * 5 minutes, in either era and both kinds (`docs/architecture/mcp-server-requests.md` → Questions). The get's or the call's
 * own bound pauses meanwhile.
 */
export const MCP_PROMPT_QUESTION_WAIT_MS = 5 * 60 * 1000;

/** The most requests of this kind one call may make (the Session cancels the rest). */
export const MCP_ELICITATIONS_PER_CALL = 10;

/**
 * How long a Legacy Sampling request may wait, from the ask (`ctx.answers.inputWaitMs`): the owner's 10 minutes and the
 * 2 minutes a sample may take (`docs/architecture/mcp-server-requests.md` → Sampling requests, Waiting).
 */
export const MCP_SAMPLING_WAIT_MS = 12 * 60 * 1000;

/** The JSON-RPC code a Sampling request turned down gets: `-1`, the spec's refusal. */
export const MCP_SAMPLING_REFUSED = -1;

/** The JSON-RPC code of a request that is invalid, or that cloudpid cannot serve. */
export const MCP_INVALID_PARAMS = -32602;

/** The JSON-RPC code of an internal error: a Sampling request whose model failed, or that the Session failed to answer. */
export const MCP_INTERNAL_ERROR = -32603;

/**
 * The Protocol era of the server that asked a question: Legacy (`2025-11-25` or earlier) or Modern (`2026-07-28` or
 * later). The client protocol's own `McpEra` (`@cloudpid/protocol/mcp-api`) is an open set that adds `unknown`.
 */
export const McpEra = Schema.Literals(["legacy", "modern"]);

export type McpEra = typeof McpEra.Type;

/**
 * A server's question, as the core surfaces it to a call's `onInput` (`mcp-server-requests.md` → Questions). `key` names
 * it within its call; `kind` says which it is, and `params` are the server's own: an elicitation's `message` and
 * `requestedSchema`, or the `sampling/createMessage` parameters of a Sampling request. `live` means it can be answered
 * only while its call waits (a Legacy server's), `deferrable` that it may be answered later (a Modern server's, or a
 * Legacy `-32042`'s page). `era` is the Protocol era of the server that asked, which the caller keeps in the question's
 * record: absent from a core from before it, which the Session reads as Modern for a form and Legacy for a page.
 */
export const McpInputRequest = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["elicitation", "sampling"]),
  params: JsonObject,
  mode: Schema.Literals(["live", "deferrable"]),
  era: Schema.optionalKey(McpEra),
});

export type McpInputRequest = typeof McpInputRequest.Type;

/** What the Session answers an elicitation with: the spec's `ElicitResult`. */
export const McpElicitResult = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Union([
        Schema.String,
        Schema.Finite,
        Schema.Boolean,
        Schema.Array(Schema.String).pipe(Schema.mutable),
      ]),
    ),
  ),
});

export type McpElicitResult = typeof McpElicitResult.Type;

/**
 * What the Session answers a Sampling request with: the spec's `CreateMessageResult` (the reply `content` as one block or
 * a list of them, with tool uses when the server offered tools). The core hands it to the SDK, which checks it against
 * the spec before the server sees it.
 */
export const McpSamplingResult = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Json,
  model: Schema.String,
  stopReason: Schema.optionalKey(Schema.String),
});

export type McpSamplingResult = typeof McpSamplingResult.Type;

/**
 * What a call's `onInput` answers. `answered` carries the result the server gets (an elicitation's `ElicitResult`),
 * `sampled` a Sampling request's `CreateMessageResult`;
 * `refused` is a question cloudpid cannot take (Legacy: a malformed form, the server getting a JSON-RPC error with
 * `code`, `-32602` unless it says otherwise; Modern: the call ends locally, the server told nothing). `defer` keeps a
 * `deferrable` question for later: the core answers the round's other questions, keeps them in the call's
 * `ResumeState`, and returns `input_required` (only to a call whose `ctx.answers.defer` is set; for any other, and for
 * a `live` question, it reads as `cancel`). A new member only gains: the engine reads an answer it does not know as
 * `refused`.
 */
export const McpInputAnswer = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("answered"), result: McpElicitResult }),
  Schema.Struct({ kind: Schema.Literal("sampled"), result: McpSamplingResult }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    message: Schema.String,
    code: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({ kind: Schema.Literal("defer") }),
]);

export type McpInputAnswer = typeof McpInputAnswer.Type;

/** What the engine's core, and the Session, read of an elicitation request's parameters. */
export const McpElicitParams = Schema.Struct({
  message: Schema.String,
  mode: Schema.optionalKey(Schema.String),
  requestedSchema: Schema.optionalKey(Schema.Json),
  /** URL mode: the page to open, and the id its completion notice names (a Legacy server's; `-32042`'s have one too). */
  url: Schema.optionalKey(Schema.String),
  elicitationId: Schema.optionalKey(Schema.String),
});

export type McpElicitParams = typeof McpElicitParams.Type;

export const decodeElicitParams = Schema.decodeUnknownOption(McpElicitParams);

/** The form's bounds (`mcp-server-requests.md` → The form → Bounds). */
export const ELICITATION_BOUNDS = {
  fields: 32,
  options: 100,
  schemaBytes: 64 * 1024,
  message: 4000,
  title: 120,
  description: 500,
  optionTitle: 200,
  valueBytes: 16 * 1024,
  answerBytes: 64 * 1024,
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------------------------------------------------

/** C0 and C1 control characters, the bidirectional marks and overrides, and zero-width characters, which server text never keeps. */
/* oxlint-disable no-control-regex -- the point: control characters are dropped. */
const UNSAFE_CHARS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/g;
/* oxlint-enable no-control-regex */

/** `text` cut to `max` characters, with an ellipsis. */
const cut = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

/** One line of server text: no control or bidi-override characters, whitespace collapsed, cut to `max`. */
export const plainLine = (text: string, max: number): string =>
  cut(text.replace(UNSAFE_CHARS, "").replace(/\s+/g, " ").trim(), max);

/**
 * `text`, a server's name for a field or the like, as one short line that is safe to put between quotes in words the
 * model reads: plain text, cut to `max`, with the quote marks, angle brackets and backslashes it could close a quote or
 * open a tag with dropped.
 */
export const safeName = (text: string, max = 60): string =>
  plainLine(text, max).replace(/[<>'`\\]/g, "");

/** `text` as a field's name between quotes, in words the model or the owner reads. */
export const quote = (text: string): string => `'${safeName(text)}'`;

/** Whether a server's message is longer than the owner is shown (`plainMessage` cuts it, and a note says so). */
export const messageIsCut = (text: string): boolean => plainMessage(text) !== plainWhole(text);

/** A server's message whole: no control, bidi-override or zero-width characters (newlines kept). */
const plainWhole = (text: string): string =>
  text.replace(UNSAFE_CHARS, "").replace(/\r\n?/g, "\n").trim();

/** A server's message, which may span lines: no control or bidi-override characters (newlines kept), cut to 4,000. */
export const plainMessage = (text: string): string =>
  cut(plainWhole(text), ELICITATION_BOUNDS.message);

// ---------------------------------------------------------------------------------------------------------------------
// The credential rule
// ---------------------------------------------------------------------------------------------------------------------

const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
  "password",
  "passwd",
  "passphrase",
  "token",
  "secret",
  "apikey",
  "cvv",
  "cvc",
]);

const CREDENTIAL_PHRASES: ReadonlySet<string> = new Set([
  "api key",
  "access key",
  "private key",
  "secret key",
  "card number",
]);

/** `text` as lowercase words, split at `_`, `-`, spaces, camelCase and acronym runs (`APIKey` → `api key`). */
const wordsOf = (text: string): ReadonlyArray<string> =>
  text
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase().replace(/\d+$/, ""))
    .filter((word) => word !== "");

/** Words a name may end in without changing what it asks for: `password_value`, `token_field`. */
const FILLER_WORDS: ReadonlySet<string> = new Set(["value", "field", "input", "text", "entry"]);

/** `word`, or its singular when it is a plural. */
const singular = (word: string) => (word.endsWith("s") ? word.slice(0, -1) : word);

/**
 * Whether `text`, a field's name or title, ends in a credential word or phrase (or a plural of one). Trailing digits
 * (`password2`), filler words (`password_value`) and a word split in two (`pass_word`) do not hide one.
 */
export const endsInCredential = (text: string): boolean => {
  const all = wordsOf(text);
  const trimmed = Arr.dropWhile(Arr.reverse(all), (word) => FILLER_WORDS.has(word));
  const words = Arr.reverse(trimmed);
  const last = words.at(-1);

  if (last === undefined) return false;

  if (CREDENTIAL_WORDS.has(last) || CREDENTIAL_WORDS.has(singular(last))) return true;

  const before = words.at(-2);

  if (before === undefined) return false;

  return (
    CREDENTIAL_PHRASES.has(`${before} ${last}`) ||
    CREDENTIAL_PHRASES.has(`${before} ${singular(last)}`) ||
    CREDENTIAL_WORDS.has(`${before}${last}`)
  );
};

// ---------------------------------------------------------------------------------------------------------------------
// Reading the server's schema
// ---------------------------------------------------------------------------------------------------------------------

const textOf = (object: JsonObject, key: string): string | undefined => {
  const value = object[key];

  return Predicate.isString(value) ? value : undefined;
};

const numberOf = (object: JsonObject, key: string): number | undefined => {
  const value = object[key];

  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;
};

/** A count: a whole number, zero or more. */
const countOf = (value: Schema.Json | undefined): number | undefined =>
  Predicate.isNumber(value) && Number.isInteger(value) && value >= 0 ? value : undefined;

type JsonArray = ReadonlyArray<Schema.Json>;

const isJsonArray = (value: Schema.Json | undefined): value is JsonArray => Arr.isArray(value);

const listOf = (object: JsonObject, key: string): JsonArray | undefined => {
  const value = object[key];

  return isJsonArray(value) ? value : undefined;
};

const objectOf = (object: JsonObject, key: string): JsonObject | undefined => {
  const value = object[key];

  return isJsonObject(value) ? value : undefined;
};

/** The keywords a property may carry that cloudpid reads; any other is ignored, with a note. */
const KNOWN_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "title",
  "description",
  "default",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "enum",
  "enumNames",
  "oneOf",
  "anyOf",
  "items",
  "minItems",
  "maxItems",
  "writeOnly",
]);

/** Keywords that put a property outside the spec's subset. */
const REFUSED_KEYWORDS = ["$ref", "allOf", "not", "if", "then", "else"] as const;

type TextField = Extract<
  ElicitationField,
  { kind: "text" | "email" | "url" | "date" | "date_time" }
>;

type NumberField = Extract<ElicitationField, { kind: "number" | "integer" }>;

type ChoiceField = Extract<ElicitationField, { kind: "choice" }>;

type MultiField = Extract<ElicitationField, { kind: "multi_choice" }>;

const STRING_FORMATS: ReadonlyMap<string, TextField["kind"]> = new Map([
  ["email", "email"],
  ["uri", "url"],
  ["date", "date"],
  ["date-time", "date_time"],
]);

/** A schema outside the subset: why, and nothing more. */
class Malformed {
  // Not a parameter property: the package runs under Node's type stripping, which takes none.
  readonly reason: string;

  constructor(reason: string) {
    this.reason = reason;
  }
}

/** A property that fails the subset throws this; the normalizer returns its reason. */
const refuse = (reason: string): never => {
  throw new Malformed(reason);
};

/** What a field was read as, and whether a text field could hold a free-form credential. */
type Read = { readonly field: ElicitationField; readonly freeText: boolean };

/** The notes a normalization keeps, and the keywords it ignored. */
type Notes = { readonly lines: Array<string>; readonly ignored: Set<string> };

const optionsOf = (name: string, raw: ReadonlyArray<Schema.Json>, notes: Notes) => {
  const options: Array<ElicitationOption> = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const choice = Predicate.isString(entry)
      ? { value: entry, title: entry }
      : isJsonObject(entry) && Predicate.isString(entry["const"])
        ? { value: entry["const"], title: textOf(entry, "title") ?? entry["const"] }
        : refuse(`${quote(name)} has an option that is not a string`);

    if (!seen.has(choice.value)) {
      seen.add(choice.value);
      options.push({
        value: choice.value,
        title: plainLine(choice.title, ELICITATION_BOUNDS.optionTitle),
      });
    }
  }

  if (raw.length === 0) refuse(`${quote(name)} has no options`);

  if (options.length > ELICITATION_BOUNDS.options) {
    refuse(`${quote(name)} has more than ${ELICITATION_BOUNDS.options} options`);
  }

  if (options.length < raw.length) {
    notes.lines.push(`${quote(name)} listed an option twice; the repeats were dropped`);
  }

  return options;
};

/** `options` titled by the legacy `enumNames` of `property`, when they match in number. */
const titled = (
  name: string,
  property: JsonObject,
  options: ReadonlyArray<ElicitationOption>,
  notes: Notes,
): ReadonlyArray<ElicitationOption> => {
  const names = property["enumNames"];

  if (names === undefined) return options;

  if (
    !isJsonArray(names) ||
    names.length !== options.length ||
    !Arr.every(names, Predicate.isString)
  ) {
    notes.lines.push(
      `${quote(name)} has enumNames that do not match its enum; the values are shown`,
    );

    return options;
  }

  return Arr.map(options, (option, index) => ({
    value: option.value,
    title: plainLine(names[index] ?? option.title, ELICITATION_BOUNDS.optionTitle),
  }));
};

const stringField = (name: string, property: JsonObject, notes: Notes, common: Common): Read => {
  const raw = listOf(property, "enum") ?? listOf(property, "oneOf");

  if (raw === undefined && (property["enum"] !== undefined || property["oneOf"] !== undefined)) {
    return refuse(`${quote(name)} has an enum that is not a list`);
  }

  if (raw !== undefined) {
    const options = titled(name, property, optionsOf(name, raw, notes), notes);
    const field: Mutable<ChoiceField> = { ...common, kind: "choice", options };
    const given = textOf(property, "default");

    if (given !== undefined && Arr.some(options, (option) => option.value === given)) {
      field.default = given;
    } else if (property["default"] !== undefined) {
      notes.lines.push(
        `${quote(name)} has a default that is not one of its options; it was dropped`,
      );
    }

    return { field, freeText: property["writeOnly"] === true };
  }

  const format = textOf(property, "format");
  const kind = format === undefined ? undefined : STRING_FORMATS.get(format);

  if (format !== undefined && kind === undefined && format !== "password") {
    notes.lines.push(
      `${quote(name)} has an unknown format ${quote(format)}; it is shown as plain text`,
    );
  }

  const field: Mutable<TextField> = { ...common, kind: kind ?? "text" };

  for (const key of ["minLength", "maxLength"] as const) {
    const bound = countOf(property[key]);

    if (bound !== undefined) field[key] = bound;
    else if (property[key] !== undefined) {
      notes.lines.push(`${quote(name)} has a ${key} that is not a count; it was ignored`);
    }
  }

  const given = textOf(property, "default");

  if (given !== undefined && (field.maxLength === undefined || given.length <= field.maxLength)) {
    field.default = given;
  } else if (property["default"] !== undefined) {
    notes.lines.push(`${quote(name)} has a default that does not fit it; it was dropped`);
  }

  return { field, freeText: kind === undefined };
};

const numberField = (
  name: string,
  property: JsonObject,
  notes: Notes,
  common: Common,
  kind: NumberField["kind"],
): Read => {
  const field: Mutable<NumberField> = { ...common, kind };

  for (const [key, to] of [
    ["minimum", "min"],
    ["maximum", "max"],
  ] as const) {
    const bound = numberOf(property, key);

    if (bound !== undefined) field[to] = bound;
    else if (property[key] !== undefined) {
      notes.lines.push(`${quote(name)} has a ${key} that is not a number; it was ignored`);
    }
  }

  const given = numberOf(property, "default");

  if (
    given !== undefined &&
    (kind === "number" || Number.isInteger(given)) &&
    (field.min === undefined || given >= field.min) &&
    (field.max === undefined || given <= field.max)
  ) {
    field.default = given;
  } else if (property["default"] !== undefined) {
    notes.lines.push(`${quote(name)} has a default that does not fit it; it was dropped`);
  }

  return { field, freeText: false };
};

const multiField = (name: string, property: JsonObject, notes: Notes, common: Common): Read => {
  const items = objectOf(property, "items");
  const raw = items === undefined ? undefined : (listOf(items, "enum") ?? listOf(items, "anyOf"));
  const itemType = items === undefined ? undefined : items["type"];

  if (
    items === undefined ||
    raw === undefined ||
    (itemType !== undefined && itemType !== "string")
  ) {
    return refuse(`${quote(name)} is a list of something other than choices`);
  }

  const options = titled(name, items, optionsOf(name, raw, notes), notes);
  const field: Mutable<MultiField> = { ...common, kind: "multi_choice", options };

  for (const key of ["minItems", "maxItems"] as const) {
    const bound = countOf(property[key]);

    if (bound !== undefined) field[key] = bound;
    else if (property[key] !== undefined) {
      notes.lines.push(`${quote(name)} has a ${key} that is not a count; it was ignored`);
    }
  }

  const given = listOf(property, "default");

  if (given !== undefined) {
    const chosen = Arr.filter(given, Predicate.isString);

    if (
      chosen.length === given.length &&
      Arr.every(chosen, (each) => Arr.some(options, (option) => option.value === each)) &&
      (field.maxItems === undefined || chosen.length <= field.maxItems)
    ) {
      field.default = chosen;
    } else {
      notes.lines.push(`${quote(name)} has a default that does not fit it; it was dropped`);
    }
  } else if (property["default"] !== undefined) {
    notes.lines.push(`${quote(name)} has a default that does not fit it; it was dropped`);
  }

  return { field, freeText: false };
};

type Common = {
  name: string;
  required: boolean;
  title?: string;
  description?: string;
};

/** One property as a field, or a throw naming why it is outside the subset. */
const readField = (
  name: string,
  property: Schema.Json | undefined,
  required: boolean,
  notes: Notes,
): Read => {
  if (!isJsonObject(property)) return refuse(`${quote(name)} is not a schema`);

  for (const keyword of REFUSED_KEYWORDS) {
    if (keyword in property)
      return refuse(`${quote(name)} uses ${keyword}, which is not supported`);
  }

  for (const key of Object.keys(property)) if (!KNOWN_KEYWORDS.has(key)) notes.ignored.add(key);

  const common: Common = { name, required };
  const title = textOf(property, "title");
  const description = textOf(property, "description");

  if (title !== undefined) common.title = plainLine(title, ELICITATION_BOUNDS.title);

  if (description !== undefined) {
    common.description = plainLine(description, ELICITATION_BOUNDS.description);
  }

  const type = property["type"];

  if (type === "string") return stringField(name, property, notes, common);

  if (type === "number" || type === "integer") {
    return numberField(name, property, notes, common, type);
  }

  if (type === "boolean") {
    const given = property["default"];

    const field: Mutable<Extract<ElicitationField, { kind: "boolean" }>> = {
      ...common,
      kind: "boolean",
    };

    if (Predicate.isBoolean(given)) field.default = given;
    else if (given !== undefined) {
      notes.lines.push(`${quote(name)} has a default that is not true or false; it was dropped`);
    }

    return { field, freeText: false };
  }

  if (type === "array") return multiField(name, property, notes, common);

  return refuse(
    type === undefined
      ? `${quote(name)} has no type`
      : `${quote(name)} has a type that is not supported (${Predicate.isString(type) ? quote(type) : "not a name"})`,
  );
};

/** Whether a read string field may hold a credential by its kind: free text, `format: "password"` or `writeOnly`. */
const mayHoldCredential = (property: JsonObject, read: Read) =>
  read.freeText || property["format"] === "password" || property["writeOnly"] === true;

/**
 * A server's form made into cloudpid's own, what was left out of it, and the credential it asks for, if any.
 */
export type NormalizedForm = {
  readonly form: ElicitationForm;
  /** What the Session ignored or changed, one line each: for the record and the card. */
  readonly notes: ReadonlyArray<string>;
  /** The shown name of the first field that asks for a credential: the form is declined unseen (ADR-0041). */
  readonly credential: string | undefined;
};

/**
 * The server's `requestedSchema` as cloudpid's `ElicitationForm`, or why it is malformed: a root that is not an
 * `object`, a property outside the spec's subset, a `required` naming no property, or a form over the bounds. What is
 * ignored (unknown keywords, an unknown `format`, an invalid default) goes in `notes`. A form asking for a credential
 * is returned with `credential` set, and is to be declined unseen.
 */
export const normalizeElicitationForm = (
  requested: Schema.Json | undefined,
): Result.Result<NormalizedForm, string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(requested ?? null)).byteLength;

  if (bytes > ELICITATION_BOUNDS.schemaBytes) return Result.fail("the schema is over 64 KiB");

  if (!isJsonObject(requested) || requested["type"] !== "object") {
    return Result.fail("the schema is not an object");
  }

  const properties = requested["properties"] ?? {};

  if (!isJsonObject(properties)) return Result.fail("its properties are not an object");

  const names = Object.keys(properties);

  if (names.length > ELICITATION_BOUNDS.fields) {
    return Result.fail(`it has more than ${ELICITATION_BOUNDS.fields} fields`);
  }

  // A name is the key the server reads the answer by, so it is never cleaned: one that is not plain is malformed.
  if (
    Arr.some(names, (name) => name === "" || plainLine(name, ELICITATION_BOUNDS.title) !== name)
  ) {
    return Result.fail(
      `a field has a name that is empty, over ${ELICITATION_BOUNDS.title} characters, or has control characters or extra spaces`,
    );
  }

  const required = requested["required"] ?? [];

  if (!isJsonArray(required)) return Result.fail("its required is not a list of names");

  const named = Arr.filter(required, Predicate.isString);

  if (named.length !== required.length) return Result.fail("its required is not a list of names");

  const missing = Arr.findFirst(named, (name) => !names.includes(name));

  if (Option.isSome(missing)) {
    return Result.fail(`it requires ${quote(missing.value)}, which is not a property`);
  }

  const notes: Notes = { lines: [], ignored: new Set() };
  const fields: Array<ElicitationField> = [];
  let credential: string | undefined;

  try {
    for (const name of names) {
      const property = properties[name];
      const read = readField(name, property, named.includes(name), notes);

      fields.push(read.field);

      if (
        credential === undefined &&
        isJsonObject(property) &&
        mayHoldCredential(property, read) &&
        (endsInCredential(name) ||
          (read.field.title !== undefined && endsInCredential(read.field.title)))
      ) {
        credential = read.field.title ?? read.field.name;
      }
    }
  } catch (error) {
    if (error instanceof Malformed) return Result.fail(error.reason);

    throw error;
  }

  if (notes.ignored.size > 0) {
    notes.lines.push(
      `ignored keywords: ${Arr.join(
        Arr.map(Arr.take([...notes.ignored], 10), (key) => safeName(key, 30)),
        ", ",
      )}`,
    );
  }

  return Result.succeed({ form: { fields }, notes: notes.lines, credential });
};

// ---------------------------------------------------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------------------------------------------------

/** What is wrong with each field the owner filled in, by field name; `""` is the answer as a whole. */
export type ElicitationErrors = Readonly<Record<string, string>>;

const encoder = new TextEncoder();

const byteLength = (text: string) => encoder.encode(text).byteLength;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** Whether `text` is a calendar date, `YYYY-MM-DD`. */
const isDate = (text: string) => {
  const match = DATE.exec(text);

  if (match === null) return false;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const days = month === 2 && isLeap(year) ? 29 : (DAYS[month - 1] ?? 0);

  return day >= 1 && day <= days;
};

/** Whether `text` is an RFC 3339 date and time: a zone, and seconds. */
const isDateTime = (text: string) => {
  const match = DATE_TIME.exec(text);

  if (match === null) return false;

  const [hour, minute, second, zoneHour, zoneMinute] = [
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  ];

  return (
    isDate(match[1] ?? "") &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 &&
    zoneHour <= 23 &&
    zoneMinute <= 59
  );
};

const isUrl = (text: string) => Option.isSome(Option.liftThrowable(() => new URL(text))());

/** The problem with `value` as the text field `field` takes, or undefined. */
const textProblem = (field: TextField, value: string): string | undefined => {
  if (field.minLength !== undefined && value.length < field.minLength) {
    return `must be at least ${field.minLength} characters`;
  }

  if (field.maxLength !== undefined && value.length > field.maxLength) {
    return `must be at most ${field.maxLength} characters`;
  }

  if (byteLength(value) > ELICITATION_BOUNDS.valueBytes) return "must be at most 16 KiB";

  switch (field.kind) {
    case "email":
      return EMAIL.test(value) ? undefined : "must be an email address";
    case "url":
      return isUrl(value) ? undefined : "must be a URL";
    case "date":
      return isDate(value) ? undefined : "must be a date (YYYY-MM-DD)";
    case "date_time":
      return isDateTime(value) ? undefined : "must be a date and time with a zone";
    case "text":
      return undefined;
  }
};

/** What the owner entered for a field: JSON, as it comes from the client. */
export type Entered = Readonly<Record<string, Schema.Json | undefined>>;

/** Whether `value` is empty as far as an optional field goes: nothing was entered. */
const isEmpty = (value: Schema.Json | undefined) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Arr.isArray(value) && value.length === 0);

type Checked = { readonly problem: string } | { readonly value: ElicitationContent[string] };

const checkNumber = (field: NumberField, value: Schema.Json | undefined): Checked => {
  if (!Predicate.isNumber(value) || !Number.isFinite(value)) return { problem: "must be a number" };

  if (field.kind === "integer" && !Number.isInteger(value)) {
    return { problem: "must be a whole number" };
  }

  if (field.min !== undefined && value < field.min)
    return { problem: `must be at least ${field.min}` };

  if (field.max !== undefined && value > field.max)
    return { problem: `must be at most ${field.max}` };

  return { value };
};

const checkMulti = (field: MultiField, value: Schema.Json | undefined): Checked => {
  if (!isJsonArray(value) || !Arr.every(value, Predicate.isString)) {
    return { problem: "must be a list of options" };
  }

  const chosen: ReadonlyArray<string> = Arr.filter(value, Predicate.isString);

  if (
    Arr.some(chosen, (each) => !Arr.some(field.options, (option) => option.value === each)) ||
    new Set(chosen).size !== chosen.length
  ) {
    return { problem: "must be some of the options, each once" };
  }

  if (field.minItems !== undefined && chosen.length < field.minItems) {
    return { problem: `must have at least ${field.minItems} chosen` };
  }

  if (field.maxItems !== undefined && chosen.length > field.maxItems) {
    return { problem: `must have at most ${field.maxItems} chosen` };
  }

  return { value: chosen };
};

/** The problem with `value` for `field`, or the value to send. */
const checkField = (field: ElicitationField, value: Schema.Json | undefined): Checked => {
  switch (field.kind) {
    case "text":
    case "email":
    case "url":
    case "date":
    case "date_time": {
      if (!Predicate.isString(value)) return { problem: "must be text" };

      const problem = textProblem(field, value);

      return problem === undefined ? { value } : { problem };
    }

    case "number":
    case "integer":
      return checkNumber(field, value);
    case "boolean":
      return Predicate.isBoolean(value) ? { value } : { problem: "must be yes or no" };
    case "choice":
      return Predicate.isString(value) &&
        Arr.some(field.options, (option) => option.value === value)
        ? { value }
        : { problem: "must be one of the options" };
    case "multi_choice":
      return checkMulti(field, value);
  }
};

/**
 * `values`, what the owner entered, as the content for `form`: required fields present, empty optional fields left out,
 * each value of its field's kind and within its bounds, and nothing for a name the form lacks. Otherwise what is wrong
 * with each field. A boolean is never empty (an unchecked box is `false`); an answer is at most 64 KiB.
 */
export const validateElicitation = (
  form: ElicitationForm,
  values: Entered,
): Result.Result<ElicitationContent, ElicitationErrors> => {
  // Built from entries, never by assigning to a name: a field called `__proto__` is a field, not a prototype.
  const errors: Array<readonly [string, string]> = [];
  const content: Array<readonly [string, ElicitationContent[string]]> = [];

  for (const name of Object.keys(values)) {
    if (!Arr.some(form.fields, (field) => field.name === name)) {
      errors.push([name, "is not a field of this form"]);
    }
  }

  for (const field of form.fields) {
    const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined;

    if (field.kind === "boolean" ? value === undefined : isEmpty(value)) {
      if (field.required) errors.push([field.name, "is required"]);

      continue;
    }

    const checked = checkField(field, value);

    if ("problem" in checked) errors.push([field.name, checked.problem]);
    else content.push([field.name, checked.value]);
  }

  const answered: ElicitationContent = Object.fromEntries(content);

  if (
    errors.length === 0 &&
    byteLength(JSON.stringify(answered)) > ELICITATION_BOUNDS.answerBytes
  ) {
    errors.push(["", "the answer is over 64 KiB"]);
  }

  return errors.length === 0 ? Result.succeed(answered) : Result.fail(Object.fromEntries(errors));
};

/** The names of the fields `content` answers, in the form's order: all a record keeps of an answer, never a value. */
export const answeredFields = (
  form: ElicitationForm,
  content: ElicitationContent,
): ReadonlyArray<string> =>
  Arr.map(
    Arr.filter(form.fields, (field) => Object.hasOwn(content, field.name)),
    (field) => field.name,
  );
