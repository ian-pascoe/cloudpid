// @effect-diagnostics preferEffectArray:off globalDate:off globalTimers:off -- JSX lists of fields and options are native arrays; the countdown is read against the wall clock, ticked by a React effect.
// The card for an MCP server's question (`docs/architecture/mcp-server-requests.md` → Elicitation requests, The form):
// "<server> asks for your input", the server's message as plain text, and one widget per field. The form is cloudpid's
// own (`ElicitationForm`), made by the Session; this never reads JSON Schema. Submit is off until the values pass the
// validator the Session runs again; a form with no fields is a confirmation gate (Accept, Decline). Typed values live
// in this card's state and nowhere else, and are lost on a reload.
import { validateElicitation } from "@cloudpid/mcp/types";
import type {
  ElicitationAction,
  ElicitationContent,
  ElicitationField,
  McpElicitationRequest,
} from "@cloudpid/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { MessageCircleQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { exitFailure } from "../registry.ts";
import { agentLabel } from "../session/agents.ts";
import {
  answerMcpElicitationAtom,
  mcpElicitationRequestsAtom,
  sessionStatusAtom,
  taskGraphAtom,
} from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";
import {
  countdown,
  enteredOf,
  type FieldValue,
  type FormValues,
  initialValues,
  ownValue,
  refusalOf,
  sourceLabel,
  timeZoneName,
} from "./mcp-elicitation-form.ts";
import { requestCardId } from "./request-anchor.ts";

/** A choice with at most this many options is shown as radios; more, as a `select`. */
const RADIO_LIMIT = 5;

/** A text field longer than this many characters is a textarea. */
const TEXTAREA_ABOVE = 200;

/** How often the countdown looks at the clock, in milliseconds. */
const TICK_MS = 1000;

/**
 * What a card takes: its request, whether answering is off, the clock (a test gives its own), the subagent that asked
 * (none for the root agent), and the owner's answer, which ends with the Session's refusal of it, or null.
 */
type CardProps = {
  request: McpElicitationRequest;
  disabled: boolean;
  now?: number;
  agent?: string | undefined;
  onAnswer: (action: ElicitationAction, content?: ElicitationContent) => Promise<string | null>;
};

const fieldClass =
  "rounded-md border border-input bg-background px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50";

/** The input type of a text-like field. */
const INPUT_TYPES = {
  text: "text",
  email: "email",
  url: "url",
  date: "date",
  date_time: "datetime-local",
} as const;

/** What a text widget shows of a field's value. */
const textOf = (value: FieldValue): string => (Predicate.isString(value) ? value : "");

/** What a group of checkboxes has checked of a field's value. */
const listOf = (value: FieldValue): ReadonlyArray<string> =>
  Predicate.isString(value) || Predicate.isBoolean(value) ? [] : value;

/** What a widget says of itself to assistive technology: required, invalid, and the notes that describe it. */
type Described = {
  required: boolean;
  invalid: boolean;
  describedBy: string | undefined;
};

/** One field's widget. */
const FieldInput = ({
  field,
  id,
  value,
  disabled,
  described,
  onChange,
}: {
  field: ElicitationField;
  id: string;
  value: FieldValue;
  disabled: boolean;
  described: Described;
  onChange: (next: FieldValue) => void;
}) => {
  const aria = {
    "aria-required": described.required || undefined,
    "aria-invalid": described.invalid || undefined,
    "aria-describedby": described.describedBy,
  } as const;

  switch (field.kind) {
    case "boolean":
      return (
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.currentTarget.checked);
          }}
          className="size-4"
          {...aria}
        />
      );
    case "number":
    case "integer":
      return (
        <Input
          id={id}
          type="number"
          value={textOf(value)}
          min={field.min}
          max={field.max}
          step={field.kind === "integer" ? 1 : "any"}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
          {...aria}
        />
      );
    case "choice":
      return field.options.length <= RADIO_LIMIT ? (
        <div
          role="radiogroup"
          aria-labelledby={`${id}-label`}
          className="flex flex-col gap-1"
          {...aria}
        >
          {Arr.map(field.options, (option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={id}
                value={option.value}
                checked={value === option.value}
                disabled={disabled}
                onChange={() => {
                  onChange(option.value);
                }}
              />
              {option.title}
            </label>
          ))}
        </div>
      ) : (
        <select
          id={id}
          value={textOf(value)}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
          className={fieldClass}
          {...aria}
        >
          <option value="" />
          {Arr.map(field.options, (option) => (
            <option key={option.value} value={option.value}>
              {option.title}
            </option>
          ))}
        </select>
      );
    case "multi_choice": {
      const checked = listOf(value);

      return (
        <div
          role="group"
          aria-labelledby={`${id}-label`}
          className="flex flex-col gap-1"
          aria-invalid={aria["aria-invalid"]}
          aria-describedby={aria["aria-describedby"]}
        >
          {Arr.map(field.options, (option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                value={option.value}
                checked={checked.includes(option.value)}
                disabled={disabled}
                onChange={(event) => {
                  onChange(
                    event.currentTarget.checked
                      ? [...checked, option.value]
                      : Arr.filter(checked, (each) => each !== option.value),
                  );
                }}
              />
              {option.title}
            </label>
          ))}
        </div>
      );
    }

    default:
      return (field.maxLength ?? 0) > TEXTAREA_ABOVE ? (
        <textarea
          id={id}
          value={textOf(value)}
          maxLength={field.maxLength}
          disabled={disabled}
          rows={4}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
          className={fieldClass}
          {...aria}
        />
      ) : (
        <Input
          id={id}
          type={INPUT_TYPES[field.kind]}
          value={textOf(value)}
          minLength={field.minLength}
          maxLength={field.maxLength}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.currentTarget.value);
          }}
          {...aria}
        />
      );
  }
};

/** Whether a field's widget is a group of inputs, which a `fieldset`'s `legend` names rather than a `label`. */
const isGroup = (field: ElicitationField): boolean =>
  field.kind === "multi_choice" || (field.kind === "choice" && field.options.length <= RADIO_LIMIT);

/** The time now, ticked each second; `fixed` (a test's) stops the clock. */
const useNow = (fixed: number | undefined) => {
  const [now, setNow] = useState(() => fixed ?? Date.now());

  useEffect(() => {
    if (fixed !== undefined) return undefined;

    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);

    return () => {
      clearInterval(timer);
    };
  }, [fixed]);

  return fixed ?? now;
};

/**
 * The card for one MCP elicitation request: the server's message, a widget per field with its required mark and
 * description, Submit (or Accept, for a form with no fields), Decline and a quiet Cancel that "closes without answering;
 * <server> may ask again". Everything the server wrote is shown as plain text. While the Session is not live the inputs
 * and buttons are off and the card reads "Reconnecting…"; typed values stay in the tab.
 */
export const McpElicitationCard = ({
  request,
  disabled,
  now: fixedNow,
  agent,
  onAnswer,
}: CardProps) => {
  const [values, setValues] = useState<FormValues>(() => initialValues(request.form));
  const [sent, setSent] = useState(false);
  const [refusal, setRefusal] = useState<ReturnType<typeof refusalOf> | null>(null);
  const now = useNow(fixedNow);
  const off = disabled || sent;
  const checked = validateElicitation(request.form, enteredOf(request.form, values));
  const gate = request.form.fields.length === 0;

  const origin = sourceLabel(request.source);

  /** The answer, which stays on the card (every input and button back on, the reason shown) if the Session refuses it. */
  const answer = (action: ElicitationAction, content?: ElicitationContent) => {
    setSent(true);
    setRefusal(null);
    void onAnswer(action, content).then((refused) => {
      if (refused === null) return;

      setSent(false);
      setRefusal(refusalOf(request.form, refused));
    });
  };

  return (
    <section
      id={requestCardId(request.id)}
      aria-label={`${request.server} asks for your input`}
      className="mx-auto mb-3 flex max-h-[calc(var(--waiting-height,60dvh)-0.75rem)] w-full max-w-3xl flex-col gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm short:gap-2 short:py-2"
    >
      <div className="shrink-0">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <MessageCircleQuestion className="size-4 shrink-0" aria-hidden />
          {request.server} asks for your input
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          during <span className="font-mono">{request.tool}</span> ·{" "}
          {agent === undefined ? "the agent" : `subagent ${agent}`}
          {origin === undefined ? null : (
            <span className="ml-2 rounded border px-1 py-0.5 text-[0.7rem]">{origin}</span>
          )}
        </p>
      </div>
      <form
        className="flex min-h-0 flex-1 flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();

          if (!off && Result.isSuccess(checked)) answer("accept", checked.success);
        }}
      >
        <div
          className="min-h-12 flex-1 overflow-y-auto"
          role="region"
          aria-label="The form"
          tabIndex={0}
        >
          <p className="text-sm break-words whitespace-pre-wrap">{request.message}</p>
          {Arr.map(request.notes, (note) => (
            <p key={note} className="mt-1 text-xs text-muted-foreground">
              {note}
            </p>
          ))}
          <div className="mt-3 flex flex-col gap-3">
            {Arr.map(request.form.fields, (field, index) => {
              const id = `${requestCardId(request.id)}-f${index}`;

              const checkedProblem = Result.isFailure(checked)
                ? ownValue(checked.failure, field.name)
                : undefined;

              const touched =
                values[field.name] !== ownValue(initialValues(request.form), field.name);

              const refused = refusal?.field === field.name ? refusal.text : undefined;
              const problem = refused ?? (touched ? checkedProblem : undefined);
              const notes: string[] = [];

              if (field.description !== undefined) notes.push(`${id}-description`);

              if (field.kind === "date_time") notes.push(`${id}-zone`);

              if (problem !== undefined) notes.push(`${id}-problem`);

              const title = (
                <>
                  {field.title ?? field.name}
                  {field.required ? (
                    <span aria-hidden className="ml-1 text-destructive">
                      *
                    </span>
                  ) : null}
                </>
              );

              return (
                <div key={field.name} className="flex flex-col gap-1">
                  {isGroup(field) ? (
                    <span id={`${id}-label`} className="text-sm font-medium">
                      {title}
                    </span>
                  ) : (
                    <label id={`${id}-label`} htmlFor={id} className="text-sm font-medium">
                      {title}
                    </label>
                  )}
                  {field.description === undefined ? null : (
                    <p id={`${id}-description`} className="text-xs text-muted-foreground">
                      {field.description}
                    </p>
                  )}
                  {field.kind === "date_time" ? (
                    <p id={`${id}-zone`} className="text-xs text-muted-foreground">
                      In your time zone, {timeZoneName()}
                    </p>
                  ) : null}
                  <FieldInput
                    field={field}
                    id={id}
                    value={values[field.name] ?? ""}
                    disabled={off}
                    described={{
                      required: field.required,
                      invalid: problem !== undefined,
                      describedBy: notes.length === 0 ? undefined : notes.join(" "),
                    }}
                    onChange={(next) => {
                      setValues((previous) => ({ ...previous, [field.name]: next }));

                      if (refusal?.field === field.name) setRefusal(null);
                    }}
                  />
                  {problem === undefined ? null : (
                    <p id={`${id}-problem`} role="alert" className="text-xs text-destructive">
                      {problem}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {refusal !== null && refusal.field === undefined ? (
          <p role="alert" className="shrink-0 text-xs text-destructive">
            {refusal.text}
          </p>
        ) : null}
        <p className="shrink-0 text-xs text-muted-foreground">
          Only {request.server} gets what you enter, and its reply to the agent may repeat it. Never
          enter a password or key here.
        </p>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {disabled
              ? "Reconnecting…"
              : request.waits === "owner"
                ? `${request.server} waits for your answer`
                : `${request.server}'s call ends in ${countdown(request.deadline, now)}`}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={off}
              title={`Closes without answering; ${request.server} may ask again`}
              onClick={() => {
                answer("cancel");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={off}
              onClick={() => {
                answer("decline");
              }}
            >
              Decline
            </Button>
            <Button type="submit" size="sm" disabled={off || Result.isFailure(checked)}>
              {gate ? "Accept" : "Submit"}
            </Button>
          </div>
        </div>
      </form>
    </section>
  );
};

/** The cards for the MCP questions waiting for the owner in the Session shown, oldest first. */
export const McpElicitationRequests = () => {
  const sessionId = useShownSessionId();
  const requests = useAtomValue(mcpElicitationRequestsAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  // Answered only over a live socket; the cards stay, off, while it is not.
  const disabled = useAtomValue(sessionStatusAtom(sessionId), (status) => status !== "live");
  const answer = useAtomSet(answerMcpElicitationAtom(sessionId), { mode: "promiseExit" });

  return Arr.map(requests, (request) => (
    <McpElicitationCard
      key={request.id}
      request={request}
      disabled={disabled}
      agent={agentLabel(graph, request.conversationId)}
      onAnswer={(action, content) =>
        answer(
          content === undefined
            ? { request: request.id, action }
            : { request: request.id, action, content },
        ).then(exitFailure)
      }
    />
  ));
};
