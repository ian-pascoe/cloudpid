// MCP argument completion (`docs/architecture/mcp-in-a-session.md` → Arguments and completions): what the argument form asks
// the Session for as the owner types (`McpCompletionRef`, `McpCompletionArgument`), and what the Session answers
// (`McpCompletion`). Completion is UI-only: the model gets no completion tool, and nothing here is stored or sent to a
// conversation. Everything here only gains: a status a later build adds reads as `failed` in an older client.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over short lists of strings.
import * as Schema from "effect/Schema";

/** The most suggestions a completion keeps, in the server's order. */
export const MAX_MCP_COMPLETION_VALUES = 100;

/** The longest suggestion kept, in characters: a longer one is dropped. */
export const MAX_MCP_COMPLETION_VALUE_CHARS = 1_000;

/**
 * The longest the typed value of the argument being completed, and a context value, may be, in characters. A context value
 * over it is left out by the form: a suggestion depends on identifiers, never on a long text.
 */
export const MAX_MCP_COMPLETE_ARGUMENT_VALUE_CHARS = 1_000;

/** The most other arguments a completion carries as context. */
export const MAX_MCP_COMPLETE_CONTEXT_ARGUMENTS = 32;

/** The longest a name (of a prompt, an argument or a field) and a template's URI may be in a request, in characters. */
export const MAX_MCP_COMPLETE_NAME_CHARS = 2_048;

/** The most completions one socket may have asked in a minute, and in flight at once: over either is answered `failed`, nothing sent. */
export const MAX_MCP_COMPLETE_PER_MINUTE = 600;

export const MAX_MCP_COMPLETE_IN_FLIGHT = 16;

/** What an argument being completed belongs to: a prompt by its name, or a resource template by its URI template. */
export const McpCompletionRef = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ref/prompt"),
    name: Schema.String.check(Schema.isMaxLength(MAX_MCP_COMPLETE_NAME_CHARS)),
  }),
  Schema.Struct({
    type: Schema.Literal("ref/resource"),
    uri: Schema.String.check(Schema.isMaxLength(MAX_MCP_COMPLETE_NAME_CHARS)),
  }),
]);

export type McpCompletionRef = typeof McpCompletionRef.Type;

/** The argument being completed and what the owner has typed of it. */
export const McpCompletionArgument = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(MAX_MCP_COMPLETE_NAME_CHARS)),
  value: Schema.String.check(Schema.isMaxLength(MAX_MCP_COMPLETE_ARGUMENT_VALUE_CHARS)),
});

export type McpCompletionArgument = typeof McpCompletionArgument.Type;

/** The other fields' non-empty values, for a server whose suggestions depend on them. */
export const McpCompletionContext = Schema.Struct({
  arguments: Schema.optionalKey(
    Schema.Record(
      Schema.String.check(Schema.isMaxLength(MAX_MCP_COMPLETE_NAME_CHARS)),
      Schema.String.check(Schema.isMaxLength(MAX_MCP_COMPLETE_ARGUMENT_VALUE_CHARS)),
    ).check(Schema.isMaxProperties(MAX_MCP_COMPLETE_CONTEXT_ARGUMENTS)),
  ),
});

export type McpCompletionContext = typeof McpCompletionContext.Type;

/**
 * How a completion came out. `ok`: the values are the server's. `unsupported`: the server does not declare completions, or
 * this Session cannot ask. `not_running`: a stdio server whose Container is not running, which a completion never starts.
 * `sign_in`: the server wants the owner signed in. `failed`: anything else, and a status a later build adds.
 */
export const MCP_COMPLETION_STATUS = {
  ok: "ok",
  unsupported: "unsupported",
  notRunning: "not_running",
  signIn: "sign_in",
  failed: "failed",
} as const;

/**
 * The Session's answer to `mcp_complete`, however it ends (an answer is never an `error` message). `values` are at most
 * `MAX_MCP_COMPLETION_VALUES`, in the server's order, each at most `MAX_MCP_COMPLETION_VALUE_CHARS` long and none twice
 * (`completionValues`); `total` and `hasMore` are the server's, and say there are more than `values` holds. `status` is a
 * string so a status a later build adds reaches an older client, which reads one it does not know as `failed`.
 */
export const McpCompletion = Schema.Struct({
  status: Schema.String,
  values: Schema.Array(Schema.String),
  total: Schema.optionalKey(Schema.Int),
  hasMore: Schema.Boolean,
});

export type McpCompletion = typeof McpCompletion.Type;

/** An answer with no suggestions, for `status`. */
export const noCompletion = (status: string): McpCompletion => ({
  status,
  values: [],
  hasMore: false,
});

const KNOWN_STATUSES: ReadonlySet<string> = new Set(Object.values(MCP_COMPLETION_STATUS));

/** `status` as a client reads it: the ones it knows, and `failed` for any other. */
export const completionStatusOf = (status: string): string =>
  KNOWN_STATUSES.has(status) ? status : MCP_COMPLETION_STATUS.failed;

/**
 * The suggestions of a server's `CompleteResult.completion` as a form shows them: strings only, those over
 * `MAX_MCP_COMPLETION_VALUE_CHARS` and repeats dropped, the first `MAX_MCP_COMPLETION_VALUES` kept, in the server's
 * order. `total` and `hasMore` pass when they are what an `Int` and a boolean are; a server that says `total` above what
 * it sent has more, whatever `hasMore` says.
 */
export const completionValues = (completion: {
  readonly values?: unknown;
  readonly total?: unknown;
  readonly hasMore?: unknown;
}): McpCompletion => {
  const seen = new Set<string>();
  const values: Array<string> = [];
  const given: ReadonlyArray<unknown> = Array.isArray(completion.values) ? completion.values : [];

  for (const value of given) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the server's own reply, read value by value
    if (typeof value !== "string" || value.length > MAX_MCP_COMPLETION_VALUE_CHARS) continue;

    if (seen.has(value)) continue;

    seen.add(value);

    if (values.length < MAX_MCP_COMPLETION_VALUES) values.push(value);
  }

  const total =
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the server's own reply, read value by value
    typeof completion.total === "number" && Number.isSafeInteger(completion.total)
      ? completion.total
      : undefined;

  const more = completion.hasMore === true || (total !== undefined && total > values.length);

  return total === undefined
    ? { status: MCP_COMPLETION_STATUS.ok, values, hasMore: more }
    : { status: MCP_COMPLETION_STATUS.ok, values, total, hasMore: more };
};
