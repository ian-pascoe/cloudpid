// MCP prompts as Slash commands (`docs/architecture/mcp-in-a-session.md` → Prompts, ADR-0033): what the composer's `/`
// menu offers (`McpPromptEntry`, in the catalog), what a send names (`McpPromptRef`, in `submit`), what the owner's entry
// keeps of one (`McpPromptData`, in `UserEntryData`), and the codes a refused send carries. Everything here only gains: a
// client that does not know a field or a code ignores it.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over short strings and records.
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

/** The most arguments a prompt may declare to be offered (more, and the host leaves it out at discovery). */
export const MAX_MCP_PROMPT_ARGUMENTS = 16;

/** The longest a prompt's own name may be to be offered. */
export const MAX_MCP_PROMPT_NAME = 128;

/** The longest an argument's value, in UTF-8 bytes: 64 KiB. */
export const MAX_MCP_PROMPT_ARGUMENT_BYTES = 64 * 1024;

/** The most all of a prompt's argument values may hold together, in UTF-8 bytes: 128 KiB. */
export const MAX_MCP_PROMPT_ARGUMENTS_BYTES = 128 * 1024;

/** The most a prompt's `description` of its result is kept at, in characters. */
export const MAX_MCP_PROMPT_RESULT_DESCRIPTION = 1_000;

/** The most references a message's `mcpPrompt` data keeps (`resources`). */
export const MAX_MCP_PROMPT_RESOURCES = 20;

/** What every prompt's Slash command starts with: `/mcp__<server>__<prompt>`. */
export const MCP_PROMPT_COMMAND_PREFIX = "/mcp__";

/** One argument of a prompt, as the form shows it. */
export const McpPromptArgument = Schema.Struct({
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  required: Schema.Boolean,
});

export type McpPromptArgument = typeof McpPromptArgument.Type;

/**
 * A prompt the `/` menu offers, from the Environment's MCP inventory (never read from a server): the Slash command
 * (`/mcp__<server>__<prompt>`), the configured `server` name and where its definition is (`owner`, or `repo:<owner/repo>`
 * for a Repo's `.pi/mcp.json`), the prompt's own `name`, its text, its arguments in declared order, and whether its
 * arguments complete (`completions`: the server declares the capability, so the form asks it for suggestions).
 */
export const McpPromptEntry = Schema.Struct({
  command: Schema.String,
  server: Schema.String,
  source: Schema.String,
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  description: Schema.String,
  arguments: Schema.Array(McpPromptArgument),
  completions: Schema.Boolean,
});

export type McpPromptEntry = typeof McpPromptEntry.Type;

/**
 * A server the menu shows as a muted row, for a reason its prompts are not there: `connecting` (not discovered yet),
 * `unavailable` (failed or unreachable, no inventory) or `sign_in`. `state` is a string so a state a newer Session adds
 * reaches an older client, which reads one it does not know as `unavailable`.
 */
export const McpCatalogServer = Schema.Struct({
  server: Schema.String,
  state: Schema.String,
});

export type McpCatalogServer = typeof McpCatalogServer.Type;

/** What the composer sends of an MCP prompt it picked (`submit.mcpPrompt`): the server, the prompt's name and its arguments. */
export const McpPromptRef = Schema.Struct({
  server: Schema.String,
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

export type McpPromptRef = typeof McpPromptRef.Type;

/** What kind of content a prompt message part is. */
export const McpPromptPartType = Schema.Literals([
  "text",
  "image",
  "audio",
  "resource_link",
  "resource",
]);

export type McpPromptPartType = typeof McpPromptPartType.Type;

/**
 * One part of the prompt's result, as the transcript's disclosure lists it: whose message it was in, what it was, and
 * where its content went when it is not in the block (`path`, a file in the Workspace). The text itself is in the model's
 * message, never copied here.
 */
export const McpPromptPart = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  type: McpPromptPartType,
  mimeType: Schema.optionalKey(Schema.String),
  uri: Schema.optionalKey(Schema.String),
  bytes: Schema.optionalKey(Schema.Int),
  path: Schema.optionalKey(Schema.String),
});

export type McpPromptPart = typeof McpPromptPart.Type;

/** A resource a prompt's result linked or embedded, for a chip (`kind`), with its URI cut at 2,048 characters. */
export const McpPromptResource = Schema.Struct({
  uri: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Int),
  kind: Schema.Literals(["text", "image", "spill", "link"]),
  path: Schema.optionalKey(Schema.String),
});

export type McpPromptResource = typeof McpPromptResource.Type;

/**
 * One question the prompt's server asked during its `prompts/get`, as the owner's entry keeps it
 * (`McpPromptData.elicitation`; `docs/architecture/mcp-server-requests.md` → Elicitation requests, Records): the one
 * `details.elicitation` of an agent's call holds, never a value, only the names of the fields answered. The enumerated
 * strings are open sets, so a value a later build adds is kept and not a decode failure for the whole entry.
 */
export const McpPromptElicitation = Schema.Struct({
  server: Schema.String,
  /** `form` or `url`. */
  mode: Schema.String,
  /** `accept`, `decline` or `cancel`. */
  action: Schema.String,
  /** `owner` or `cloudpid`. */
  by: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  fields: Schema.Array(Schema.String),
  /** The host of the page a URL-mode question asked the owner to open; never the address. */
  host: Schema.optionalKey(Schema.String),
  finished: Schema.optionalKey(Schema.Boolean),
});

export type McpPromptElicitation = typeof McpPromptElicitation.Type;

/**
 * One Sampling request the prompt's server made during its `prompts/get`, as the owner's entry keeps it
 * (`McpPromptData.sampling`): the one `details.sampling` of an agent's call holds, never its content.
 */
export const McpPromptSampling = Schema.Struct({
  server: Schema.String,
  /** `answered`, `refused` or `failed`. */
  status: Schema.String,
  /** Who decided: `definition`, `owner`, `grant` or `cloudpid`. */
  by: Schema.String,
  grant: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  why: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  tokens: Schema.optionalKey(Schema.Finite),
  cost: Schema.optionalKey(Schema.Finite),
  /** The record's id, which `mcp_sampling_get` reads. */
  id: Schema.optionalKey(Schema.String),
});

export type McpPromptSampling = typeof McpPromptSampling.Type;

/** The most of each kind of question an entry keeps of a get. */
export const MCP_PROMPT_QUESTIONS_KEPT = 20;

/**
 * What the owner's `cloudpid.user` entry keeps of an MCP prompt that was sent (`UserEntryData.mcpPrompt`): the
 * configured `server`, the Slash `command`, the prompt's `name` and `title`, its `arguments` (redacted of Secrets), the
 * result's `description` (cut at 1,000 characters, never sent to the model), its `parts` and at most 20 `resources`.
 */
export const McpPromptData = Schema.Struct({
  server: Schema.String,
  command: Schema.String,
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  arguments: Schema.Record(Schema.String, Schema.String),
  description: Schema.optionalKey(Schema.String),
  parts: Schema.Array(McpPromptPart),
  resources: Schema.Array(McpPromptResource),
  /** The Sampling requests its server made while it was got, in order; absent when it made none (or from before the key). */
  sampling: McpPromptSampling.pipe(Schema.Array, Schema.optionalKey),
  /** The questions its server asked while it was got, in order; absent when it asked none (or from before the key). */
  elicitation: McpPromptElicitation.pipe(Schema.Array, Schema.optionalKey),
});

export type McpPromptData = typeof McpPromptData.Type;

/**
 * An argument's value as one line, cut to at most `limit` characters with a `…`: where a chip, the transcript and an
 * export show a value that may run to many lines.
 */
export const flatCut = (value: string, limit: number): string => {
  const flat = value.replaceAll(/\s+/gu, " ").trim();

  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

/**
 * The label an MCP prompt goes by where the owner typed nothing to name the message (the title, the tree, a lane):
 * `<server> · <title, else name>`. The chip adds the arguments.
 */
export const mcpPromptLabel = (prompt: Pick<McpPromptData, "server" | "name" | "title">): string =>
  `${prompt.server} · ${prompt.title ?? prompt.name}`;

/** What every refusal of a send that names an MCP prompt carries as `error.code`. */
export const MCP_PROMPT_ERROR_CODES = [
  "MCP_PROMPT_ARGUMENTS",
  "MCP_SIGN_IN_REQUIRED",
  "MCP_PROMPT_TOO_LARGE",
  "MCP_PROMPT_FAILED",
] as const;

export type McpPromptErrorCode = (typeof MCP_PROMPT_ERROR_CODES)[number];

const isErrorCode = Schema.is(Schema.Literals(MCP_PROMPT_ERROR_CODES));

/** `code`, a refusal's code, as one of the MCP prompt codes, or undefined for any other (a code a newer Session adds). */
export const mcpPromptErrorCode = (code: string | undefined): McpPromptErrorCode | undefined =>
  code !== undefined && isErrorCode(code) ? code : undefined;

/**
 * What a refusal of a send that names an MCP prompt carries besides its message: the `code` (`mcpPromptErrorCode` reads
 * it) and the `server` it names, which a client keeps whole so a code a newer Session adds still reaches it.
 */
export const Refusal = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  server: Schema.optionalKey(Schema.String),
});

export type Refusal = typeof Refusal.Type;

/** The refusal of a typed `/mcp__…` that was not picked from the menu. */
export const MCP_PROMPT_NOT_PICKED_MESSAGE =
  "An MCP prompt is picked from the / menu; it cannot be typed";

/** Whether `text` is typed like an MCP prompt's command: `/mcp__` and a non-space. */
export const looksLikeMcpPromptCommand = (text: string): boolean => /^\/mcp__\S/u.test(text);

/** The `value` of each argument cleaned the way the Session does: NUL and control characters but `\n` and `\t` removed. */
export const cleanPromptArgument = (value: string): string =>
  // oxlint-disable-next-line no-control-regex -- the point: control characters are dropped.
  value.toWellFormed().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, "");

const encoder = new TextEncoder();

/**
 * Why `args`, the values a send names for `declared` arguments, cannot be sent, or undefined when they can: a required
 * argument missing or empty, a value over 64 KiB, or all values over 128 KiB (`docs/architecture/mcp-in-a-session.md` →
 * Arguments and completions). Does not check names: an argument the prompt no longer declares is dropped by `promptArguments`.
 */
export const promptArgumentsProblem = (
  declared: ReadonlyArray<McpPromptArgument>,
  args: Readonly<Record<string, string>>,
): string | undefined => {
  let total = 0;

  for (const [name, value] of Record.toEntries(args)) {
    const bytes = encoder.encode(cleanPromptArgument(value)).byteLength;

    if (bytes > MAX_MCP_PROMPT_ARGUMENT_BYTES) {
      return `The value of ${name} is over ${String(MAX_MCP_PROMPT_ARGUMENT_BYTES / 1024)} KiB`;
    }

    total += bytes;
  }

  if (total > MAX_MCP_PROMPT_ARGUMENTS_BYTES) {
    return `The arguments are over ${String(MAX_MCP_PROMPT_ARGUMENTS_BYTES / 1024)} KiB together`;
  }

  for (const argument of declared) {
    if (argument.required && (args[argument.name] ?? "").trim() === "") {
      return `The argument ${argument.name} is required`;
    }
  }

  return undefined;
};

/**
 * The arguments to send: only those `declared`, in declared order, cleaned, with the empty optional ones left out.
 * An argument the prompt no longer declares is dropped.
 */
export const promptArguments = (
  declared: ReadonlyArray<McpPromptArgument>,
  args: Readonly<Record<string, string>>,
): Record<string, string> => {
  const sent: Record<string, string> = {};

  for (const argument of declared) {
    const value = cleanPromptArgument(args[argument.name] ?? "");

    if (value !== "" || argument.required) sent[argument.name] = value;
  }

  return sent;
};
