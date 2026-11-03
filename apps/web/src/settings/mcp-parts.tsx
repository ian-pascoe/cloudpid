// @effect-diagnostics preferEffectArray:off -- JSX lists of messages are native arrays.

// The small pieces the MCP servers section's rows, form and import are made of (docs/architecture/mcp-configuration.md → The
// Settings page's "MCP servers" section): a list of messages, a select of a few known values, and the line that says an
// Environment's Secret and Variable names are not known yet.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { useAtomRefresh } from "@effect/atom-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { cn } from "../lib/utils.ts";
import { environmentSecretsAtom, environmentSettingsAtom } from "../environments-state.ts";
import type { McpReferencesState } from "./mcp-state.ts";

/** How a list of messages reads: an alert for a problem, a status for a warning, quiet text for a hint. */
export type MessageTone = "problem" | "warning" | "hint";

const TONES: Readonly<
  Record<MessageTone, { readonly className: string; readonly role: "alert" | "status" | undefined }>
> = {
  problem: { className: "text-destructive", role: "alert" },
  warning: { className: "text-amber-600 dark:text-amber-400", role: "status" },
  hint: { className: "text-muted-foreground", role: undefined },
};

/**
 * A list of messages of one `tone`, which a control names in its `aria-describedby` through `id`. Nothing for none.
 * `small` is the row's smaller text. A plain list keeps its list role and is not announced when the page loads; `live`
 * makes it an alert (a problem) or a status (a warning), for messages that appear as the owner acts, as a form's checks
 * do while it is edited.
 */
export const MessageList = ({
  tone,
  messages,
  id,
  small = false,
  live = false,
  action,
}: {
  tone: MessageTone;
  messages: ReadonlyArray<string>;
  id?: string | undefined;
  small?: boolean;
  live?: boolean;
  /** The control that acts on message `index` (a problem's Reset), if it has one. */
  action?: ((index: number) => ReactNode) | undefined;
}) =>
  messages.length === 0 ? null : (
    <ul
      id={id}
      role={live ? TONES[tone].role : undefined}
      className={cn("flex flex-col gap-0.5", small ? "text-xs" : "text-sm", TONES[tone].className)}
    >
      {messages.map((message, index) => (
        <li key={message} className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {message}
          {action?.(index)}
        </li>
      ))}
    </ul>
  );

/** A select of the `options`, as `labels` word them: the one picker of an Exposure and of "Model use". */
export const OptionSelect = <Choice extends string>({
  id,
  label,
  options,
  labels,
  value,
  disabled,
  describedBy,
  onChange,
}: {
  id?: string | undefined;
  /** The control's accessible name, where its visible label does not give one (a row's names the server). */
  label?: string | undefined;
  options: ReadonlyArray<Choice>;
  labels: Readonly<Record<Choice, string>>;
  value: Choice;
  disabled?: boolean | undefined;
  describedBy?: string | undefined;
  onChange: (picked: Choice) => void;
}) => (
  <NativeSelect
    id={id}
    aria-label={label}
    aria-describedby={describedBy}
    value={value}
    disabled={disabled}
    onChange={(event) => {
      const picked = Arr.findFirst(options, (known) => known === event.target.value);

      if (Option.isSome(picked)) onChange(picked.value);
    }}
  >
    {options.map((option) => (
      <option key={option} value={option}>
        {labels[option]}
      </option>
    ))}
  </NativeSelect>
);

/**
 * What an Environment's form and import say while the Secret and Variable names a `${NAME}` may read are not known: that
 * Save is held for them, so that a `${NAME}` nothing provides is not missed, or why they could not be asked with Try
 * again. Nothing once they are known.
 */
export const ReferencesNotice = ({
  scope,
  references,
}: {
  scope: string;
  references: McpReferencesState;
}) => {
  const secrets = useAtomRefresh(environmentSecretsAtom);
  const variables = useAtomRefresh(environmentSettingsAtom(scope));

  if (references.status === "ready") return null;

  if (references.status === "loading") {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Loading this environment's Secret and Variable names: Save is held until they are known, so
        that a <code>{"${NAME}"}</code> nothing provides is not missed.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="text-sm text-destructive">
        Could not load this environment's Secret and Variable names, so Save is held:{" "}
        {references.problem}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          secrets();
          variables();
        }}
      >
        Try again
      </Button>
    </div>
  );
};
