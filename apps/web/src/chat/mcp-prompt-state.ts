// What the composer holds of an MCP prompt (`docs/architecture/mcp-in-a-session.md` → Arguments and completions, Failures):
// the chip above the input, the argument form that fills or edits it, the message and ref a send makes of it, and what a
// refusal of the send does to them. Pure functions and the atoms that keep them, one set per composer: a conversation's,
// or the draft's. The chip is kept while the app is open and lost on reload; a refused send gives it back.

// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off -- plain functions over short lists and records of one prompt's arguments.

import {
  type Catalog,
  flatCut,
  mcpPromptErrorCode,
  type McpPromptArgument,
  type McpPromptData,
  type McpPromptEntry,
  type McpPromptRef,
  promptArguments,
  promptArgumentsProblem,
  Refusal,
} from "@cloudpid/protocol";
import * as Cause from "effect/Cause";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
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
      const flat = flatCut(chip.values[argument.name] ?? "", limit);

      return flat === "" ? [] : [`${argument.name}: ${flat}`];
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

/** What a lane says while the Session gets the prompt `title` of `server`. */
export const gettingLine = (title: string, server: string): string =>
  `Getting ${title} from ${server}…`;

/** What a lane says while the Session gets the chip's prompt. */
export const gettingText = (chip: PromptChip): string =>
  gettingLine(promptTitle(chip.prompt), chip.prompt.server);

/**
 * The lane rows of messages whose prompt is being got (`gettingText`), with the ones whose server asks the owner something
 * in the get (`asked`: the waiting questions of a prompt send, by their server and the prompt's title) reading "Getting
 * <title> from <server> · waiting for your answer" (`docs/architecture/mcp-server-requests.md` → Questions).
 */
export const withAwaited = <A extends { readonly text: string }>(
  rows: readonly A[],
  asked: ReadonlyArray<{ readonly server: string; readonly prompt: string }>,
): readonly A[] => {
  if (asked.length === 0) return rows;

  const awaited = new Set(asked.map((one) => gettingLine(one.prompt, one.server)));

  return rows.map((row) =>
    awaited.has(row.text)
      ? { ...row, text: `${row.text.slice(0, -1)} · waiting for your answer` }
      : row,
  );
};

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

const isRefusal = Schema.is(Refusal);

/** The `code` and `server` `cause`'s failure carries (`SendError.refusal`), when it carries them. */
export const refusalOfCause = (cause: Cause.Cause<unknown>): Refusal | undefined => {
  const error = Cause.squash(cause);

  return Predicate.hasProperty(error, "refusal") && isRefusal(error.refusal)
    ? error.refusal
    : undefined;
};

/**
 * Why the message cannot be sent while an MCP prompt is in the composer, or null when nothing holds it back: its form is
 * open, it goes with a Review (which carries no prompt), or the chip cannot be sent as it is (`chipStanding`).
 */
export const promptWaitingFor = (held: {
  readonly form: PromptForm | null;
  readonly chip: PromptChip | null;
  readonly standing: ChipStanding | null;
  readonly reviewing: boolean;
}): string | null => {
  if (held.form !== null) return "Fill in the prompt's arguments, or cancel them.";

  if (held.chip === null) return null;

  if (held.reviewing) return "An MCP prompt cannot go with a Review: remove one of them.";

  return held.standing === null || held.standing.kind === "ready" ? null : held.standing.message;
};

/** What a send does about an MCP prompt in the composer: it goes ahead, or it is held back and says why. */
export type SendGate =
  | { readonly send: true }
  | {
      readonly send: false;
      /** What the note says (`promptWaitingFor`). */
      readonly note: string;
      /** The form to open, when the chip's arguments are incomplete for what the catalog now declares: the send fixes them. */
      readonly form?: PromptForm;
    };

/**
 * What every way of sending does first (Send, Enter, Queue, the steer shortcut, Retry): `held` says whether the prompt
 * holds the message back and, if it does, what to tell the owner. A chip whose arguments the catalog now wants more of
 * opens its form, with what is missing above the fields, instead of only saying so.
 */
export const sendGate = (held: {
  readonly form: PromptForm | null;
  readonly chip: PromptChip | null;
  readonly standing: ChipStanding | null;
  readonly reviewing: boolean;
}): SendGate => {
  const note = promptWaitingFor(held);

  if (note === null) return { send: true };

  const { chip, standing } = held;

  if (held.form === null && chip !== null && standing?.kind === "arguments" && !held.reviewing) {
    return {
      send: false,
      note,
      form: {
        prompt: standing.prompt,
        values: startingValues(standing.prompt, chip.values),
        problem: standing.message,
      },
    };
  }

  return { send: false, note };
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
export const refusalOutcome = (message: string, refusal?: Refusal): RefusalOutcome => {
  // A refusal with no code, or one this build does not know, is a failed get.
  const code = mcpPromptErrorCode(refusal?.code) ?? "MCP_PROMPT_FAILED";

  switch (code) {
    case "MCP_PROMPT_ARGUMENTS":
      return { message, reopenForm: true, retry: false, signIn: undefined, refreshCatalog: true };
    case "MCP_SIGN_IN_REQUIRED":
      return {
        message,
        reopenForm: false,
        retry: true,
        signIn: refusal?.server,
        refreshCatalog: false,
      };
    case "MCP_PROMPT_TOO_LARGE":
      return { message, reopenForm: false, retry: false, signIn: undefined, refreshCatalog: false };
    case "MCP_PROMPT_FAILED":
      return { message, reopenForm: false, retry: true, signIn: undefined, refreshCatalog: true };
  }
};
