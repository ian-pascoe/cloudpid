// @effect-diagnostics missingPipeableSignature:off -- a component and its event handlers, not combinators.

// The form that fills in an MCP prompt's arguments (`docs/architecture/mcp-in-a-session.md` → Arguments and completions),
// one field per argument in declared order, above the composer. It takes the fields and the values, and gives the values
// back: the prompt's chip is made of them (Done), or nothing is (Cancel). Values may be several lines; Tab or Enter moves on.

import {
  type McpPromptArgument,
  MAX_MCP_PROMPT_ARGUMENT_BYTES,
  promptArgumentsProblem,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { useEffect, useId, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import { formKey } from "./argument-form.ts";

/** Whether every required field has something in it. */
export const requiredFilled = (
  fields: readonly McpPromptArgument[],
  values: Readonly<Record<string, string>>,
): boolean =>
  Arr.every(fields, (field) => !field.required || (values[field.name] ?? "").trim() !== "");

/**
 * The argument form of a prompt: `title` (what it is, with `server` muted beside it), `fields` and their `values`,
 * and `problem` above them when the Session refused the last send. Done is disabled while a required field is empty or the
 * values are over their bounds (`promptArgumentsProblem`, which the Session checks again), and says which bound.
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
  onChange,
  onDone,
  onCancel,
}: {
  title: string;
  server: string;
  fields: readonly McpPromptArgument[];
  values: Readonly<Record<string, string>>;
  problem?: string | undefined;
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
      {problem !== undefined && (
        <p id={problemId} role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
      {Arr.map(fields, (field, index) => {
        const fieldId = `${id}-${field.name}`;
        const describedBy = field.description === undefined ? undefined : `${fieldId}-hint`;

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
              spellCheck={false}
              value={values[field.name] ?? ""}
              maxLength={MAX_MCP_PROMPT_ARGUMENT_BYTES}
              onChange={(event) => {
                onChange({ ...values, [field.name]: event.currentTarget.value });
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;

                const key = formKey(event, { index, count: fields.length, valid });

                if (key === null) return;

                event.preventDefault();

                if (key === "cancel") onCancel();
                else if (key === "done") onDone();
                else focus(key === "next" ? index + 1 : index - 1);
              }}
              className="field-sizing-content max-h-40 min-h-9 w-full resize-none rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
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
