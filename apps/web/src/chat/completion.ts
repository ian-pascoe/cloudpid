// What the composer completes as the owner types: a Slash command at the start of the message and its argument, a
// Skill after `$`, and a file after `@`. Pure text functions, so the composer's menu only renders their answers.

// @effect-diagnostics missingPipeableSignature:off -- plain functions over strings, not combinators.

/** What is being completed: a Slash command's name, its argument, a Skill, or a file path. */
export type TriggerKind = "command" | "argument" | "skill" | "file";

/**
 * A trigger in the text: the span `[start, end)` a pick replaces (from the trigger character, or from the argument's
 * first character, to the end of the word the caret is in), and the query typed so far, up to the caret.
 */
export type Trigger =
  | {
      readonly kind: "command" | "skill" | "file";
      readonly start: number;
      readonly end: number;
      readonly query: string;
    }
  | {
      readonly kind: "argument";
      /** The Slash command whose argument this is, without its `/`. */
      readonly command: string;
      readonly start: number;
      readonly end: number;
      readonly query: string;
    };

/** The end of the word that starts at or before `from`: the next whitespace, or the end of the text. */
const wordEnd = (text: string, from: number): number => {
  const rest = /\s/.exec(text.slice(from));

  return rest === null ? text.length : from + rest.index;
};

/** Whether an odd number of backticks precede `at`: the position is inside inline code or a fenced block. */
const inCode = (text: string, at: number): boolean =>
  (text.slice(0, at).match(/`/g)?.length ?? 0) % 2 === 1;

/**
 * The trigger the caret is in, if any. A Slash command is only at the very start of the message, and a second `/` in
 * its word makes it a path (`/tmp/x`). `$` and `@` count at the start of a word only, so `a$b` and an email address are
 * left alone, and none of the three counts inside backticks.
 */
export const detectTrigger = (text: string, caret: number): Trigger | null => {
  const before = text.slice(0, caret);

  const command = /^\/([^\s/]*)$/.exec(before);

  if (command !== null) {
    return { kind: "command", start: 0, end: wordEnd(text, caret), query: command[1] ?? "" };
  }

  const argument = /^\/([^\s/]+)[ \t]+(\S*)$/.exec(before);

  if (argument !== null) {
    const query = argument[2] ?? "";

    return {
      kind: "argument",
      command: argument[1] ?? "",
      start: caret - query.length,
      end: wordEnd(text, caret),
      query,
    };
  }

  const mention = /(?:^|\s)([$@])(\S*)$/.exec(before);

  if (mention === null) return null;

  const query = mention[2] ?? "";
  const start = caret - query.length - 1;

  if (inCode(text, start)) return null;

  return {
    kind: mention[1] === "$" ? "skill" : "file",
    start,
    end: wordEnd(text, caret),
    query,
  };
};

/** Text, and where the caret goes in it. */
export type Edited = { readonly text: string; readonly caret: number };

/**
 * The text with `pick` and a space in place of the trigger's span, and where the caret goes: after the space. Without
 * the space (`space: false`, for a folder), the caret stays right after the pick, in the trigger, which stays open.
 */
export const replaceTrigger = (
  text: string,
  span: Pick<Trigger, "start" | "end">,
  pick: string,
  { space = true }: { readonly space?: boolean } = {},
): Edited => {
  const after = text.slice(span.end);
  const spaced = !space || after.startsWith(" ") ? pick : `${pick} `;

  return {
    text: `${text.slice(0, span.start)}${spaced}${after}`,
    caret: span.start + pick.length + (space ? 1 : 0),
  };
};

/** A Slash command as typed: its name without the `/`, and its arguments, trimmed. */
export type CommandCall = { readonly name: string; readonly args: string };

/** The Slash command a message is, or null for any other message. */
export const parseCommand = (text: string): CommandCall | null => {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());

  return match === null ? null : { name: match[1] ?? "", args: (match[2] ?? "").trim() };
};
