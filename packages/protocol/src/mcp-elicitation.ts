// An MCP server's form as the owner sees it (`docs/architecture/mcp-server-requests.md` → Elicitation requests, The
// form): cloudpid's own `ElicitationForm`, which the Session makes of the server's `requestedSchema` and the web draws,
// so the web never reads raw JSON Schema. The normalizer that makes one and the validator that checks an answer against
// it are in `@cloudpid/mcp/types` (`elicitation.ts`); the schemas are here because the socket's messages carry them.
import * as Schema from "effect/Schema";
import { ConversationId } from "./conversation-id.ts";

/** The kinds of field a form has: a string by its format, a number or an integer, a boolean, one choice or several. */
export const ELICITATION_FIELD_KINDS = [
  "text",
  "email",
  "url",
  "date",
  "date_time",
  "number",
  "integer",
  "boolean",
  "choice",
  "multi_choice",
] as const;

export type ElicitationFieldKind = (typeof ELICITATION_FIELD_KINDS)[number];

/** One option of a choice: the value sent, and the title shown. */
export const ElicitationOption = Schema.Struct({
  value: Schema.String,
  title: Schema.String,
});

export type ElicitationOption = typeof ElicitationOption.Type;

/** What every field has: its name (the key of its value), its title and description as plain text, and whether it is required. */
const Common = {
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  required: Schema.Boolean,
};

/** A field of a form, by kind. Text is plain: the Session has stripped control and bidi-override characters. */
export const ElicitationField = Schema.Union([
  Schema.Struct({
    ...Common,
    kind: Schema.Literals(["text", "email", "url", "date", "date_time"]),
    default: Schema.optionalKey(Schema.String),
    minLength: Schema.optionalKey(Schema.Int),
    maxLength: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literals(["number", "integer"]),
    default: Schema.optionalKey(Schema.Finite),
    min: Schema.optionalKey(Schema.Finite),
    max: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("boolean"),
    default: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("choice"),
    options: Schema.Array(ElicitationOption),
    default: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("multi_choice"),
    options: Schema.Array(ElicitationOption),
    default: Schema.Array(Schema.String).pipe(Schema.optionalKey),
    minItems: Schema.optionalKey(Schema.Int),
    maxItems: Schema.optionalKey(Schema.Int),
  }),
]);

export type ElicitationField = typeof ElicitationField.Type;

/** A form: its fields, in the order the server listed them. A form with none is a confirmation gate. */
export const ElicitationForm = Schema.Struct({
  fields: Schema.Array(ElicitationField),
});

export type ElicitationForm = typeof ElicitationForm.Type;

/** What the owner enters for one field, as it goes to the server: a string, a number, a boolean, or a list of strings. */
export const ElicitationValue = Schema.Union([
  Schema.String,
  Schema.Finite,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);

export type ElicitationValue = typeof ElicitationValue.Type;

/** The values of a form by field name; an empty optional field is left out. */
export const ElicitationContent = Schema.Record(Schema.String, ElicitationValue);

export type ElicitationContent = typeof ElicitationContent.Type;

/** How the owner closes a form: Submit, Decline, or a quiet Cancel. */
export const ElicitationAction = Schema.Literals(["accept", "decline", "cancel"]);

export type ElicitationAction = typeof ElicitationAction.Type;

/**
 * What the owner sends for a question (`mcp_elicitation_answer`): how a form closes, or, for a question with a `page`,
 * `opened` (Open's click) and `done` ("Done, try again").
 */
export const McpElicitationAction = Schema.Union([
  ElicitationAction,
  Schema.Literals(["opened", "done"]),
]);

export type McpElicitationAction = typeof McpElicitationAction.Type;

/** Where the server's definition is: Global, the Environment, or a Repo's `.pi/mcp.json` (then its `owner/repo`). */
export const McpElicitationSource = Schema.Struct({
  kind: Schema.String,
  slug: Schema.optionalKey(Schema.String),
});

export type McpElicitationSource = typeof McpElicitationSource.Type;

/**
 * The page a URL-mode question asks the owner to open (`docs/architecture/mcp-server-requests.md` → Elicitation
 * requests, URL mode). `url` is the address as the browser will open it, `host` its host in ASCII (punycode) and
 * `domain` the registrable domain the card emphasizes; `warning` says the host is an internationalized one (`idn`) or
 * mixes scripts (`mixed_script`). `opened` is whether the owner opened it (from any client). `retry` says the call ends
 * and is sent again ("Done, try again", a Legacy `-32042`); without it the server goes on by itself when the owner
 * finishes there. `again` says the server asked for this page before and it was opened ("Not finished at <host> yet").
 * `finished` says the server told cloudpid the owner finished there (`notifications/elicitation/complete`): the card
 * reads "Finished at <host>" for a moment before it goes.
 */
export const McpElicitationPage = Schema.Struct({
  url: Schema.String,
  host: Schema.String,
  domain: Schema.String,
  warning: Schema.optionalKey(Schema.Literals(["idn", "mixed_script"])),
  opened: Schema.Boolean,
  retry: Schema.optionalKey(Schema.Literal(true)),
  again: Schema.optionalKey(Schema.Literal(true)),
  finished: Schema.optionalKey(Schema.Literal(true)),
});

export type McpElicitationPage = typeof McpElicitationPage.Type;

/**
 * One waiting question (`mcp_elicitation_requests`), as the card shows it. Every string is plain text. `deadline` is
 * the moment, in epoch milliseconds, the Session answers `cancel` for the owner, so the countdown follows the Session's
 * clock; a question with `waits: "owner"` has none, and its `deadline` is only for a client from before `waits` (a far
 * one).
 */
export const McpElicitationRequest = Schema.Struct({
  /** What the answer names: unique within the Session. */
  id: Schema.String,
  /** The call that waits for it. */
  callId: Schema.String,
  /** The conversation whose call it is: the root agent's or a subagent's. */
  conversationId: ConversationId,
  /** The server's configured name, never what it calls itself. */
  server: Schema.String,
  /** Where the definition is, for the card's badge; absent when the Session does not know. */
  source: Schema.optionalKey(McpElicitationSource),
  /** The model-facing name of the tool the call is to (`mcp__<server>__<tool>`). */
  tool: Schema.String,
  /** The server's message, cut and cleaned. */
  message: Schema.String,
  /** A page question's `form` has no fields: the card draws `page` instead. */
  form: ElicitationForm,
  /** The page to open, when the server asks the owner to (URL mode); a client from before it shows a form with no fields. */
  page: Schema.optionalKey(McpElicitationPage),
  /** What the Session ignored or changed in the server's schema, one line each. */
  notes: Schema.Array(Schema.String),
  deadline: Schema.Finite,
  /**
   * `"owner"` for a Modern server's question, which waits for the owner with no deadline (it is answered in the call's
   * resume): the card says so, and ignores `deadline`.
   */
  waits: Schema.optionalKey(Schema.Literal("owner")),
});

export type McpElicitationRequest = typeof McpElicitationRequest.Type;
