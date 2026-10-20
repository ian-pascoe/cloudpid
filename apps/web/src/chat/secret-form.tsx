// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.
import type { SecretRequest } from "@cloudpid/protocol";
import * as Predicate from "effect/Predicate";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../components/ui/button.tsx";

/** Values shorter than this are redacted only as written, so redacting them may also hide unrelated output. */
const SHORT_SECRET_LENGTH = 8;

/**
 * The masked form for one Secret request (`docs/spec.md` → Secrets): a password field per name. The values are read
 * from the form when it is submitted and sent once; nothing here keeps them, and they never enter the chat. An empty
 * field skips its name.
 */
const SecretForm = ({
  request,
  lifetimeMinutes,
  disabled,
  onAnswer,
}: {
  request: SecretRequest;
  lifetimeMinutes: number;
  disabled: boolean;
  onAnswer: (request: string, values: Readonly<Record<string, string>> | null) => void;
}) => {
  /** How long each typed value is, for the short-value warning; never the value itself. */
  const [lengths, setLengths] = useState<Readonly<Record<string, number>>>({});
  const [sent, setSent] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const values: Record<string, string> = {};

    for (const name of request.names) {
      const value = form.get(name);

      if (Predicate.isString(value) && value !== "") values[name] = value;
    }

    event.currentTarget.reset();
    setLengths({});
    setSent(true);
    onAnswer(request.id, values);
  };

  return (
    <form
      onSubmit={submit}
      aria-label="Secrets requested"
      className="mx-auto mb-3 w-full max-w-3xl rounded-lg border bg-card px-4 py-3 shadow-sm"
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <KeyRound className="size-4" aria-hidden />
        The agent asks for {request.names.length === 1 ? "a Secret" : "Secrets"}
      </div>
      {request.reason !== undefined && (
        <p className="mt-1 text-sm break-words text-muted-foreground">{request.reason}</p>
      )}
      <div className="mt-3 flex flex-col gap-3">
        {request.names.map((name, index) => (
          <label key={name} className="flex flex-col gap-1 text-sm">
            <span className="font-mono text-xs">{name}</span>
            <input
              type="password"
              name={name}
              autoComplete="off"
              spellCheck={false}
              // The first field takes the keyboard as the form appears.
              autoFocus={index === 0}
              disabled={disabled || sent}
              onChange={(event) => {
                const length = event.currentTarget.value.length;

                setLengths((previous) => ({ ...previous, [name]: length }));
              }}
              className="h-9 rounded-md border border-input bg-background px-3 font-mono focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
            {(lengths[name] ?? 0) > 0 && (lengths[name] ?? 0) < SHORT_SECRET_LENGTH && (
              <span className="text-xs text-muted-foreground">
                Shorter than {SHORT_SECRET_LENGTH} characters: hiding it from the agent may also
                hide unrelated output.
              </span>
            )}
          </label>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        The agent never sees the values, only references to them. They are kept encrypted for{" "}
        {lifetimeMinutes} minutes. Leave a field empty to skip it.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || sent}
          onClick={() => {
            setSent(true);
            onAnswer(request.id, null);
          }}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={disabled || sent}>
          Provide
        </Button>
      </div>
    </form>
  );
};

/** The masked forms for the Secret requests waiting for the owner, oldest first. */
export const SecretRequests = ({
  requests,
  lifetimeMinutes,
  disabled,
  onAnswer,
}: {
  requests: readonly SecretRequest[];
  lifetimeMinutes: number;
  disabled: boolean;
  onAnswer: (request: string, values: Readonly<Record<string, string>> | null) => void;
}) =>
  requests.map((request) => (
    // Keyed by request, so each form starts empty.
    <SecretForm
      key={request.id}
      request={request}
      lifetimeMinutes={lifetimeMinutes}
      disabled={disabled}
      onAnswer={onAnswer}
    />
  ));
