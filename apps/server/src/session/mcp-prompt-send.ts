// The pure parts of sending an MCP prompt (`docs/architecture/mcp-in-a-session.md` → Getting a prompt at send, Into the
// conversation): splitting the owner's input into what they typed and what came beside it, the message's parts in the
// order the model reads them, the data its entry keeps, and a refusal with its message redacted. `host.ts` runs the steps
// (the checks, the get, the files) around them.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over a message's parts.
import type {
  McpPromptData,
  McpPromptEntry,
  McpPromptErrorCode,
  UserInput,
} from "@cloudpid/protocol";
import { MCP_PROMPT_QUESTIONS_KEPT, UPLOADS_ROOT } from "@cloudpid/protocol";
import type { PromptSummaries } from "@cloudpid/extensions/mcp";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { Mutable } from "effect/Types";
import { SessionError } from "./errors.ts";
import type { PromptMessage } from "./mcp-prompt.ts";

/** One block of the owner's input. */
type InputBlock = Exclude<UserInput, string>[number];

/** The owner's input split into what they typed and the blocks beside it. */
export type TypedAndBeside = {
  readonly typed: string;
  /** The Attachments' paths and pictures (every block, when the owner typed nothing). */
  readonly beside: ReadonlyArray<InputBlock>;
};

/** The typed text of `input`: its first text block, unless that is the Attachments' paths; and the blocks beside it. */
export const typedAndBeside = (input: UserInput): TypedAndBeside => {
  if (Predicate.isString(input)) return { typed: input, beside: [] };

  const first = Arr.findFirstIndex(input, (block) => block.type === "text");
  const block = Option.flatMap(first, (at) => Arr.get(input, at));

  if (Option.isNone(first) || Option.isNone(block) || block.value.type !== "text") {
    return { typed: "", beside: input };
  }

  return block.value.text.startsWith(`@${UPLOADS_ROOT}/`)
    ? { typed: "", beside: input }
    : { typed: block.value.text, beside: Arr.remove(input, first.value) };
};

/** The base64 characters of the inline images in `blocks`: what the owner's own images take of the image budget. */
export const imageCharacters = (blocks: ReadonlyArray<InputBlock>): number =>
  Arr.reduce(blocks, 0, (sum, block) => (block.type === "image" ? sum + block.data.length : sum));

/**
 * How many parts a prompt's message begins with that are the prompt's own: its block, then its inline images. The
 * typed text follows them, and then what the owner attached; Attached pages go after the typed text and before the
 * owner's own images, so they are placed from this many parts in (`withPages`).
 */
export const promptPartCount = (made: Pick<PromptMessage, "images">): number =>
  1 + made.images.length;

/**
 * The parts of the message, in the order the model reads them: the `<mcp_prompt>` block, the prompt's images (together
 * `promptPartCount` parts), the owner's typed text (left out when empty), then what came beside it.
 */
export const promptContent = (
  made: Pick<PromptMessage, "block" | "images">,
  typed: string,
  beside: ReadonlyArray<InputBlock>,
) => [
  { type: "text" as const, text: made.block },
  ...made.images,
  ...(typed === "" ? [] : [{ type: "text" as const, text: typed }]),
  ...beside,
];

/** A get that asked nothing. */
export const NO_SUMMARIES: PromptSummaries = { elicitation: [], sampling: [] };

/** What the owner's entry keeps of the prompt that was sent (`UserEntryData.mcpPrompt`), with what its server asked. */
export const promptData = (
  entry: Pick<McpPromptEntry, "server" | "command" | "name" | "title">,
  sent: Readonly<Record<string, string>>,
  made: Pick<PromptMessage, "description" | "parts" | "resources">,
  asked: PromptSummaries = NO_SUMMARIES,
): McpPromptData => {
  const data: Mutable<McpPromptData> = {
    server: entry.server,
    command: entry.command,
    name: entry.name,
    arguments: { ...sent },
    parts: made.parts,
    resources: made.resources,
  };

  if (entry.title !== undefined) data.title = entry.title;

  if (made.description !== undefined) data.description = made.description;

  // What the server's questions came to while it was got: never a value, and the first of each kind only.
  if (asked.sampling.length > 0)
    data.sampling = Arr.take(asked.sampling, MCP_PROMPT_QUESTIONS_KEPT);

  if (asked.elicitation.length > 0) {
    data.elicitation = Arr.take(asked.elicitation, MCP_PROMPT_QUESTIONS_KEPT);
  }

  return data;
};

/** A refusal of a send that names the prompt of `server`, with the `code` the composer acts on. */
export const promptRefusal = (code: McpPromptErrorCode, message: string, server: string) =>
  SessionError.make({ operation: "submit", message, code, server });

/** `error` with its message redacted: what a server answers may carry an argument's value. */
export const redactedError = (error: SessionError, redact: <A>(value: A) => A) => {
  const redacted: Mutable<ConstructorParameters<typeof SessionError>[0]> = {
    operation: error.operation,
    message: redact(error.message),
  };

  if (error.code !== undefined) redacted.code = error.code;

  if (error.server !== undefined) redacted.server = error.server;

  return SessionError.make(redacted);
};
