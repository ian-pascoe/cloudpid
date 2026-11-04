// What an argument form's keys do (`docs/architecture/mcp-in-a-session.md` → Arguments and completions): Tab or Enter
// moves to the next field and Enter in the last one is Done, Shift+Tab goes back, Shift+Enter is a new line in a value,
// and Escape cancels. Pure, so the form only renders it.

// @effect-diagnostics missingPipeableSignature:off -- plain functions over a key press.

/** What a key does in the form. */
export type FormKey = "next" | "previous" | "done" | "cancel" | null;

/** Where the key was pressed: the field's place among the fields, and whether Done is allowed. */
export interface FormPlace {
  readonly index: number;
  readonly count: number;
  /** Whether Done would be taken: no required field is empty. */
  readonly valid: boolean;
}

/**
 * The form's part in `key`: Escape cancels; Tab (Enter, without Shift) moves to the next field, or from the last one
 * Enter is Done when the values allow it, and Tab leaves the form to the browser; Shift+Tab goes back, except from the
 * first field, which the browser moves out of; Ctrl or Cmd with Enter is Done from any field. Anything else types on.
 */
export const formKey = (
  key: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
  },
  { index, count, valid }: FormPlace,
): FormKey => {
  if (key.key === "Escape") return "cancel";

  if (key.key === "Tab") {
    if (key.shiftKey) return index > 0 ? "previous" : null;

    return index < count - 1 ? "next" : null;
  }

  if (key.key !== "Enter" || key.shiftKey || key.altKey) return null;

  if (key.ctrlKey || key.metaKey) return valid ? "done" : null;

  if (index < count - 1) return "next";

  return valid ? "done" : null;
};

/** What a key does in a field's open list of suggestions. */
export type SuggestionKey = "down" | "up" | "accept" | "dismiss" | null;

/** A field's open list: how many suggestions it holds and which one is highlighted (-1 when none). */
export interface SuggestionPlace {
  readonly count: number;
  readonly highlighted: number;
}

/**
 * The list's part in `key`, which comes before the form's own: the arrows move the highlight (it starts on none, so Tab
 * and Enter keep moving between fields until the owner has chosen one), Enter and Tab take the highlighted suggestion,
 * and Escape closes the list before it cancels the form. Shift+Enter is a new line in the value as ever.
 */
export const suggestionKey = (
  key: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
  },
  { count, highlighted }: SuggestionPlace,
): SuggestionKey => {
  if (count === 0) return null;

  if (key.altKey || key.ctrlKey || key.metaKey) return null;

  if (key.key === "Escape") return "dismiss";

  if (key.key === "ArrowDown") return "down";

  if (key.key === "ArrowUp") return "up";

  if (key.shiftKey) return null;

  if ((key.key === "Enter" || key.key === "Tab") && highlighted >= 0) return "accept";

  return null;
};

/** How many suggestions a field's list shows: the server may send a hundred, and the owner narrows by typing. */
export const MAX_SHOWN_SUGGESTIONS = 8;

/** The suggestions to list under a field holding `value`: at most `MAX_SHOWN_SUGGESTIONS`, none when the only one is what is typed. */
export const shownSuggestions = (suggestions: readonly string[], value: string): string[] =>
  suggestions.length === 1 && suggestions[0] === value
    ? []
    : suggestions.slice(0, MAX_SHOWN_SUGGESTIONS);
