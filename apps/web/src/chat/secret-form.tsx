import type { SecretKeep, SecretRequest } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Predicate from "effect/Predicate";
import * as Atom from "effect/reactivity/Atom";
import { KeyRound } from "lucide-react";
import type { FormEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import {
  answerSecretsAtom,
  secretLifetimeMinutesAtom,
  secretRequestsAtom,
  sessionStatusAtom,
} from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";
import { chosenKeep, defaultKeep, KEEP_CHOICES, KEEP_FIELD, keepNote } from "./secret-keep.ts";

/** Values shorter than this are redacted only as written, so redacting them may also hide unrelated output. */
const SHORT_SECRET_LENGTH = 8;

/**
 * One form's state: how long each typed value is, for the short-value warning (never the value itself), what the owner
 * chose to do with the values (`null`: the agent's suggestion still stands), and whether the form was answered.
 */
const FormState = ScopedAtom.make(() =>
  Atom.make<{
    readonly lengths: Readonly<Record<string, number>>;
    readonly keep: SecretKeep | null;
    readonly sent: boolean;
  }>({
    lengths: {},
    keep: null,
    sent: false,
  }),
);

/**
 * The masked form for one Secret request (`docs/architecture/agent-capabilities.md` → Secrets): a password field per name. The values are read
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
  onAnswer: (
    request: string,
    values: Readonly<Record<string, string>> | null,
    keep?: SecretKeep,
  ) => void;
}) => {
  const [{ lengths, keep, sent }, setState] = useAtom(FormState.use());
  const chosen = keep ?? defaultKeep(request);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);
    const values: Record<string, string> = {};

    for (const name of request.names) {
      const value = form.get(name);

      if (Predicate.isString(value) && value !== "") values[name] = value;
    }

    const choice = chosenKeep(form.get(KEEP_FIELD));

    event.currentTarget.reset();
    setState({ lengths: {}, keep: choice, sent: true });
    onAnswer(request.id, values, choice);
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
        {Arr.map(request.names, (name, index) => (
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

                setState((previous) => ({
                  ...previous,
                  lengths: { ...previous.lengths, [name]: length },
                }));
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
      <fieldset className="mt-3 flex flex-col gap-1" disabled={disabled || sent}>
        <legend className="text-xs font-medium">What to do with them</legend>
        {Arr.map(KEEP_CHOICES, ({ value, label }) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={KEEP_FIELD}
              value={value}
              checked={chosen === value}
              onChange={() => {
                setState((previous) => ({ ...previous, keep: value }));
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <p className="mt-3 text-xs text-muted-foreground">
        The agent never sees the values, only references to them.{" "}
        {keepNote(chosen, lifetimeMinutes)} Leave a field empty to skip it.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || sent}
          onClick={() => {
            setState((previous) => ({ ...previous, sent: true }));
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

/** The masked forms for the Secret requests waiting for the owner in the Session shown, oldest first. */
export const SecretRequests = () => {
  const sessionId = useShownSessionId();
  const requests = useAtomValue(secretRequestsAtom(sessionId));
  const lifetimeMinutes = useAtomValue(secretLifetimeMinutesAtom(sessionId));
  // Answered only over a live socket.
  const disabled = useAtomValue(sessionStatusAtom(sessionId), (status) => status !== "live");
  const answer = useAtomSet(answerSecretsAtom(sessionId));

  return Arr.map(requests, (request) => (
    // Keyed by request, so each form starts empty.
    <FormState.Provider key={request.id}>
      <SecretForm
        request={request}
        lifetimeMinutes={lifetimeMinutes}
        disabled={disabled}
        onAnswer={(id, values, keep) => {
          answer(keep === undefined ? { request: id, values } : { request: id, values, keep });
        }}
      />
    </FormState.Provider>
  ));
};
