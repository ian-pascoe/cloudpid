// What the composer holds of an MCP prompt (`docs/architecture/mcp-in-a-session.md` → Arguments and completions, Failures):
// the chip above the input, the argument form that fills or edits it, the message and ref a send makes of it, and what a
// refusal of the send does to them. Pure functions and the atoms that keep them, one set per composer: a conversation's,
// or the draft's. The chip is kept while the app is open and lost on reload; a refused send gives it back.

// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off -- plain functions over short lists and records of one prompt's arguments.

import {
  type Catalog,
  mcpPromptErrorCode,
  type McpPromptArgument,
  type McpPromptData,
  type McpPromptEntry,
  type McpPromptRef,
  promptArguments,
  promptArgumentsProblem,
} from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Predicate from "effect/Predicate";
import * as Atom from "effect/reactivity/Atom";
import type * as Types from "effect/Types";
import type { OutgoingMessage } from "../session/state.ts";
import type { ConversationKey } from "./conversation.ts";

/** A prompt picked for the message being written, with the argument values the owner filled in. */
export interface PromptChip {
  /** The prompt as the catalog offered it when it was picked (or as Branch gave it back, see `restoredChip`). */
  readonly prompt: McpPromptEntry;
  /** The values by argument name, as typed: cleaned and trimmed down to the declared ones only when sent. */
  readonly values: Readonly<Record<string, string>>;
}

/** The argument form open on a prompt: the values so far, and why the Session refused the last send, if it did. */
export interface PromptForm {
  readonly prompt: McpPromptEntry;
  readonly values: Readonly<Record<string, string>>;
  /** What the form says above its fields (a refusal's message, `MCP_PROMPT_ARGUMENTS`). */
  readonly problem?: string | undefined;
}

/** A composer's chip and form. */
export interface PromptAtoms {
  readonly chip: Atom.Writable<PromptChip | null>;
  readonly form: Atom.Writable<PromptForm | null>;
}

const atomsOf = (): PromptAtoms => ({
  chip: Atom.make<PromptChip | null>(null),
  form: Atom.make<PromptForm | null>(null),
});

/** The chip and form of a conversation's composer, kept while it is open. */
export const conversationPromptAtoms = Atom.family((_key: ConversationKey) => atomsOf());

/** The chip and form of the draft composer, kept while the app is open (as the draft's text and Attachments are). */
export const draftPromptAtoms: PromptAtoms = atomsOf();

/** What a chip is called: the prompt's title, else its name. */
export const promptTitle = (prompt: Pick<McpPromptEntry, "title" | "name">): string =>
  prompt.title ?? prompt.name;

/** The prompt `ref` names in `catalog`, or undefined: the catalog does not offer it (or is not known yet). */
export const offeredPrompt = (
  catalog: Pick<Catalog, "prompts"> | null | undefined,
  ref: Pick<McpPromptRef, "server" | "name">,
): McpPromptEntry | undefined =>
  catalog?.prompts?.find((prompt) => prompt.server === ref.server && prompt.name === ref.name);

/** Whether a prompt with no arguments needs no form: it becomes a chip at once. */
export const needsForm = (prompt: McpPromptEntry): boolean => prompt.arguments.length > 0;

/** `values` with each declared argument that has none set to empty, in declared order. */
export const startingValues = (
  prompt: McpPromptEntry,
  values: Readonly<Record<string, string>> = {},
): Record<string, string> =>
  Object.fromEntries(
    prompt.arguments.map((argument) => [argument.name, values[argument.name] ?? ""]),
  );

/** The argument values of the chip, as the Session gets them (`submit.mcpPrompt.arguments`). */
export const refOf = (chip: PromptChip): McpPromptRef => {
  const ref: Types.Mutable<McpPromptRef> = { server: chip.prompt.server, name: chip.prompt.name };
  const sent = promptArguments(chip.prompt.arguments, chip.values);

  if (Object.keys(sent).length > 0) ref.arguments = sent;

  return ref;
};

/** Why `chip` cannot be sent as it is (an argument is missing or too big), or undefined. */
export const chipProblem = (chip: PromptChip): string | undefined =>
  promptArgumentsProblem(chip.prompt.arguments, chip.values);

/** One `name: value` per argument that has a value, the value on one line and cut, for the chip's text. */
export const chipArguments = (chip: PromptChip, limit = 40): string =>
  chip.prompt.arguments
    .flatMap((argument: McpPromptArgument) => {
      const flat = (chip.values[argument.name] ?? "").replace(/\s+/gu, " ").trim();

      if (flat === "") return [];

      return [`${argument.name}: ${flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat}`];
    })
    .join(" · ");

/** The text a chip shows: "docs · Review PR", then its arguments. */
export const chipText = (chip: PromptChip): string => {
  const head = `${chip.prompt.server} · ${promptTitle(chip.prompt)}`;
  const args = chipArguments(chip);

  return args === "" ? head : `${head} · ${args}`;
};

/**
 * `message` (the input, and what the lane shows of it) made the message of the MCP prompt `chip`: it carries the prompt's
 * ref, and the lane says the prompt is being got until the Session has placed it.
 */
export const withPrompt = (message: OutgoingMessage, chip: PromptChip): OutgoingMessage => ({
  ...message,
  display: promptLane(chip, message.display),
  mcpPrompt: refOf(chip),
  getting: gettingText(chip),
});

/** What a lane says while the Session gets the prompt. */
export const gettingText = (chip: PromptChip): string =>
  `Getting ${promptTitle(chip.prompt)} from ${chip.prompt.server}…`;

/** What a lane shows of the message once it has its prompt: the chip's label, then what the owner typed and attached. */
export const promptLane = (chip: PromptChip, display: string): string => {
  const label = `${chip.prompt.server} · ${promptTitle(chip.prompt)}`;

  return display === "" ? label : `${label} · ${display}`;
};

/**
 * The chip Branch (`Navigated.mcpPrompt`) or a Fork gives back: the catalog's prompt when it still offers it, with the
 * arguments as they were kept (redacted values come back redacted); else the prompt as the message knew it, which the
 * composer shows as no longer offered and will not send.
 */
export const restoredChip = (
  data: McpPromptData,
  catalog: Pick<Catalog, "prompts"> | null | undefined,
): PromptChip => {
  const offered = offeredPrompt(catalog, data);

  if (offered !== undefined) return { prompt: offered, values: data.arguments };

  const prompt: Types.Mutable<McpPromptEntry> = {
    command: data.command,
    server: data.server,
    source: "owner",
    name: data.name,
    description: "",
    arguments: Object.keys(data.arguments).map((name) => ({ name, required: false })),
    completions: false,
  };

  if (data.title !== undefined) prompt.title = data.title;

  return { prompt, values: data.arguments };
};

/** What the composer can do with a chip now: send it, or why it cannot be sent. */
export type ChipStanding =
  | { readonly kind: "ready"; readonly prompt: McpPromptEntry }
  | { readonly kind: "gone"; readonly message: string }
  | { readonly kind: "arguments"; readonly message: string; readonly prompt: McpPromptEntry };

/**
 * Whether `chip` can be sent against `catalog`: the prompt is still offered (a catalog not known yet is taken to offer
 * it, and the Session says otherwise), and its arguments are complete for what the catalog now declares.
 */
export const chipStanding = (
  chip: PromptChip,
  catalog: Pick<Catalog, "prompts"> | null | undefined,
): ChipStanding => {
  const live = offeredPrompt(catalog, chip.prompt);

  if (live === undefined && catalog !== null && catalog !== undefined) {
    return {
      kind: "gone",
      message: `${chip.prompt.server} no longer offers ${promptTitle(chip.prompt)}`,
    };
  }

  const prompt = live ?? chip.prompt;
  const problem = chipProblem({ prompt, values: chip.values });

  return problem === undefined
    ? { kind: "ready", prompt }
    : { kind: "arguments", message: problem, prompt };
};

/** The `code` and `server` a failed send carries, when it carries them (`SendError`). */
export interface RefusalFields {
  readonly code?: string;
  readonly server?: string;
}

/** The `code` and `server` of `cause`'s failure, when it carries them. */
export const refusalFields = (cause: Cause.Cause<unknown>): RefusalFields => {
  const error = Cause.squash(cause);
  const fields: Types.Mutable<RefusalFields> = {};

  if (Predicate.hasProperty(error, "code") && Predicate.isString(error.code)) {
    fields.code = error.code;
  }

  if (Predicate.hasProperty(error, "server") && Predicate.isString(error.server)) {
    fields.server = error.server;
  }

  return fields;
};

/** What a refused send does to the composer. */
export interface RefusalOutcome {
  /** What the note under the composer says. */
  readonly message: string;
  /** Whether the argument form opens again, with `message` above its fields. */
  readonly reopenForm: boolean;
  /** Whether the note offers Retry: the same message sent again. */
  readonly retry: boolean;
  /** The server to offer a Sign in link for, when the refusal is a sign-in. */
  readonly signIn: string | undefined;
  /** Whether the catalog is asked for again: the prompt may be gone, or have changed. */
  readonly refreshCatalog: boolean;
}

/**
 * What the owner sees when the Session refused a send of an MCP prompt, from its `code`. A code this build does not know,
 * and a refusal without one (an older Session that read `mcpPrompt` as an excess property, or a socket that closed),
 * count as a failed get: the chip and text are given back all the same, and the owner may retry.
 */
export const refusalOutcome = (error: {
  readonly message: string;
  readonly code?: string | undefined;
  readonly server?: string | undefined;
}): RefusalOutcome => {
  const code = mcpPromptErrorCode(error.code);

  switch (code) {
    case "MCP_PROMPT_ARGUMENTS":
      return {
        message: error.message,
        reopenForm: true,
        retry: false,
        signIn: undefined,
        refreshCatalog: true,
      };
    case "MCP_SIGN_IN_REQUIRED":
      return {
        message: error.message,
        reopenForm: false,
        retry: true,
        signIn: error.server,
        refreshCatalog: false,
      };
    case "MCP_PROMPT_TOO_LARGE":
      return {
        message: error.message,
        reopenForm: false,
        retry: false,
        signIn: undefined,
        refreshCatalog: false,
      };
    default:
      return {
        message: error.message,
        reopenForm: false,
        retry: true,
        signIn: undefined,
        refreshCatalog: code === "MCP_PROMPT_FAILED",
      };
  }
};
