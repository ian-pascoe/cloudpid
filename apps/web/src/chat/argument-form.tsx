// @effect-diagnostics missingPipeableSignature:off -- a component and its event handlers, not combinators.

// The form that fills in an MCP prompt's arguments (`docs/architecture/mcp-in-a-session.md` → Arguments and completions),
// one field per argument in declared order, above the composer. It takes the fields and the values, and gives the values
// back: the prompt's chip is made of them (Done), or nothing is (Cancel). Values may be several lines; Tab or Enter moves on.
// When the server completes the arguments, the focused field lists its suggestions (`argument-completion.ts`).

import {
  type McpPromptArgument,
  MAX_MCP_PROMPT_ARGUMENT_BYTES,
  promptArgumentsProblem,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { useEffect, useId, useReducer, useRef, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  type CompleteFn,
  type Completer,
  type FieldSuggestions,
  createCompleter,
  suggestionNote,
} from "./argument-completion.ts";
import { formKey, shownSuggestions, suggestionKey } from "./argument-form.ts";

/** Whether every required field has something in it. */
export const requiredFilled = (
  fields: readonly McpPromptArgument[],
  values: Readonly<Record<string, string>>,
): boolean =>
  Arr.every(fields, (field) => !field.required || (values[field.name] ?? "").trim() !== "");

/** What the form needs to ask for suggestions: `scope` names the server and ref (answers are cached under it). */
export interface FormCompletion {
  readonly scope: string;
  readonly complete: CompleteFn;
  /** Where the owner signs in to the server, when a completion says it wants that. */
  readonly signInHref?: string | undefined;
}

/** A field's note under it: what its suggestions' status says. */
const SuggestionNote = ({
  suggestions,
  server,
  signInHref,
}: {
  suggestions: FieldSuggestions;
  server: string;
  signInHref: string | undefined;
}) => {
  const note = suggestionNote(suggestions, server);

  if (note === undefined) return null;

  return (
    <p role="status" className="text-xs text-muted-foreground">
      {note.kind === "sign_in" && signInHref !== undefined ? (
        <a href={signInHref} className="underline underline-offset-2">
          {note.text}
        </a>
      ) : (
        note.text
      )}
    </p>
  );
};

/** A field's list of suggestions; a mouse press takes one without the field losing the focus. */
export const SuggestionList = ({
  id,
  suggestions,
  highlighted,
  onAccept,
}: {
  id: string;
  suggestions: readonly string[];
  highlighted: number;
  onAccept: (suggestion: string) => void;
}) => (
  <ul
    id={id}
    role="listbox"
    className="max-h-48 overflow-auto rounded-md border bg-popover py-1 text-sm shadow-sm"
  >
    {Arr.map(suggestions, (suggestion, index) => (
      <li
        key={suggestion}
        id={`${id}-${index}`}
        role="option"
        aria-selected={index === highlighted}
        onMouseDown={(event) => {
          event.preventDefault();
          onAccept(suggestion);
        }}
        className="cursor-pointer truncate px-3 py-1 aria-selected:bg-accent aria-selected:text-accent-foreground"
      >
        {suggestion}
      </li>
    ))}
  </ul>
);

/**
 * The argument form of a prompt: `title` (what it is, with `server` muted beside it), `fields` and their `values`,
 * and `problem` above them when the Session refused the last send. Done is disabled while a required field is empty or the
 * values are over their bounds (`promptArgumentsProblem`, which the Session checks again), and says which bound.
 *
 * With `completion` the focused field lists the server's suggestions: ↑/↓ highlight one, Enter or Tab take it, a click takes
 * it, Escape closes the list (and a second Escape cancels the form). `preview` is the resource a template's values make so far.
 *
 * It is a group, not a `<form>`: the composer's own form is around it, and a submit from Done would bubble to it and send
 * the message with the chip's old values.
 */
export const ArgumentForm = ({
  title,
  server,
  fields,
  values,
  problem,
  completion,
  preview,
  onChange,
  onDone,
  onCancel,
}: {
  title: string;
  server: string;
  fields: readonly McpPromptArgument[];
  values: Readonly<Record<string, string>>;
  problem?: string | undefined;
  completion?: FormCompletion | undefined;
  preview?: string | undefined;
  onChange: (values: Record<string, string>) => void;
  onDone: () => void;
  onCancel: () => void;
}) => {
  const id = useId();
  const inputs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const problemNow = promptArgumentsProblem(fields, values);
  const valid = problemNow === undefined;

  // An empty required field is what the label's asterisk says; a value over a bound needs saying.
  const overBound = requiredFilled(fields, values) ? problemNow : undefined;
  const problemId = `${id}-problem`;

  // The first field takes the focus as the form opens: the owner picked the prompt to fill it in.
  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  const focus = (index: number) => {
    inputs.current[index]?.focus();
  };

  // The completions of this form: made after mount (a strict-mode remount makes a fresh one), closed with it. `complete` is
  // read through a ref so a new Session connection does not discard the cache.
  const scope = completion?.scope;
  const completeRef = useRef<CompleteFn | undefined>(completion?.complete);
  const valuesRef = useRef(values);
  const [completer, setCompleter] = useState<Completer | undefined>(undefined);
  const [focused, setFocused] = useState<string | undefined>(undefined);
  const [highlighted, setHighlighted] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const [, tick] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    completeRef.current = completion?.complete;
    valuesRef.current = values;
  });

  useEffect(() => {
    if (scope === undefined) return undefined;

    const made = createCompleter({
      scope,
      complete: (ask, signal) =>
        completeRef.current === undefined
          ? Promise.reject(new Error("no completions"))
          : completeRef.current(ask, signal),
    });

    const stop = made.subscribe(tick);

    setCompleter(made);

    // The first field took the focus before there was anyone to ask.
    for (const [index, input] of inputs.current.entries()) {
      const field = fields[index];

      if (input !== null && field !== undefined && input === document.activeElement) {
        made.focus(field.name, valuesRef.current[field.name] ?? "", valuesRef.current);
      }
    }

    return () => {
      stop();
      made.close();
      setCompleter(undefined);
    };
    // `fields` is the prompt's, fixed for the form's life.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const accept = (field: string, suggestion: string) => {
    onChange({ ...values, [field]: suggestion });
    setDismissed(true);
    setHighlighted(-1);
  };

  return (
    <div
      role="group"
      aria-label={`Arguments of ${title}`}
      aria-describedby={problem === undefined ? undefined : problemId}
      className="flex flex-col gap-2 rounded-lg border bg-background p-3 shadow-sm"
    >
      <div className="flex items-baseline gap-2 text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{server}</span>
      </div>
      {preview !== undefined && (
        <p className="font-mono text-xs break-all text-muted-foreground">{preview}</p>
      )}
      {problem !== undefined && (
        <p id={problemId} role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      {Arr.map(fields, (field, index) => {
        const fieldId = `${id}-${field.name}`;
        const describedBy = field.description === undefined ? undefined : `${fieldId}-hint`;
        const value = values[field.name] ?? "";
        const here = completer !== undefined && focused === field.name;
        const suggestions = here ? completer.state(field.name) : undefined;

        const shown =
          here && !dismissed
            ? shownSuggestions(completer.suggestions(field.name, value), value)
            : [];

        const listId = `${fieldId}-suggestions`;

        return (
          <div key={field.name} className="flex flex-col gap-1">
            <label htmlFor={fieldId} className="text-xs font-medium">
              {field.title ?? field.name}
              {field.required ? (
                <span className="text-destructive" aria-hidden>
                  {" "}
                  *
                </span>
              ) : (
                <span className="font-normal text-muted-foreground"> (optional)</span>
              )}
            </label>
            <textarea
              id={fieldId}
              ref={(element) => {
                inputs.current[index] = element;
              }}
              rows={1}
              required={field.required}
              aria-describedby={describedBy}
              {...(completion === undefined
                ? {}
                : {
                    role: "combobox",
                    "aria-autocomplete": "list" as const,
                    "aria-expanded": shown.length > 0,
                    "aria-controls": shown.length > 0 ? listId : undefined,
                    "aria-activedescendant":
                      shown.length > 0 && highlighted >= 0 ? `${listId}-${highlighted}` : undefined,
                  })}
              spellCheck={false}
              value={value}
              maxLength={MAX_MCP_PROMPT_ARGUMENT_BYTES}
              onFocus={() => {
                setFocused(field.name);
                setHighlighted(-1);
                setDismissed(false);
                completer?.focus(field.name, value, values);
              }}
              onBlur={() => {
                setFocused((now) => (now === field.name ? undefined : now));
              }}
              onChange={(event) => {
                const next = { ...values, [field.name]: event.currentTarget.value };

                onChange(next);
                setHighlighted(-1);
                setDismissed(false);
                completer?.edit(field.name, event.currentTarget.value, next);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;

                const listKey = suggestionKey(event, { count: shown.length, highlighted });

                if (listKey !== null) {
                  event.preventDefault();

                  if (listKey === "down") setHighlighted((now) => (now + 1) % shown.length);
                  else if (listKey === "up")
                    setHighlighted((now) => (now <= 0 ? shown.length - 1 : now - 1));
                  else if (listKey === "dismiss") setDismissed(true);
                  else accept(field.name, shown[highlighted] ?? value);

                  return;
                }

                const key = formKey(event, { index, count: fields.length, valid });

                if (key === null) return;

                event.preventDefault();

                if (key === "cancel") onCancel();
                else if (key === "done") onDone();
                else focus(key === "next" ? index + 1 : index - 1);
              }}
              className="field-sizing-content max-h-40 min-h-9 w-full resize-none rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
            {shown.length > 0 && (
              <SuggestionList
                id={listId}
                suggestions={shown}
                highlighted={highlighted}
                onAccept={(suggestion) => {
                  accept(field.name, suggestion);
                }}
              />
            )}
            {suggestions !== undefined && (
              <SuggestionNote
                suggestions={suggestions}
                server={server}
                signInHref={completion?.signInHref}
              />
            )}
            {field.description !== undefined && (
              <p id={describedBy} className="text-xs text-muted-foreground">
                {field.description}
              </p>
            )}
          </div>
        );
      })}
      {overBound !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {overBound}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!valid} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
};
