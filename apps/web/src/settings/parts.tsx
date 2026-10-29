// The pieces every section of the Settings page is made of (docs/architecture/client-and-protocol.md → Settings page):
// the section's frame (its heading and what it is for), a ruled group of fields, a field with its label, hint or
// problem and a slot for its mark (where #350's Inherited and Overridden marks go), a monospace text area, the field
// that asks for a name to be typed before a destructive dialog's button works, and the form of a section with a Save:
// its fields, then a bar that stays at the foot of the page with Save, Reset to defaults, and "Saved" or why the save
// was refused.

import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { FormEvent, ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { cn } from "../lib/utils.ts";
import { failureOf, settledFailureOf } from "../registry.ts";
import type { SectionForm } from "./drafts.ts";

/** The id of the hint, or the problem, under the field whose control is `htmlFor`. */
export const noteId = (htmlFor: string): string => `${htmlFor}-note`;

/** A section's frame: its heading, the line that says what it is for, and its groups. */
export const SettingsSection = ({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) => (
  <div className="mx-auto flex w-full max-w-3xl flex-col px-4 pt-6 pb-10 md:px-8 md:pt-8">
    <h1 className="text-lg font-semibold text-balance">{title}</h1>
    <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
    <div className="mt-6 flex flex-col">{children}</div>
  </div>
);

/** A ruled group of a section: its title, what it says of its fields, and the fields. */
export const Group = ({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section
    aria-label={title}
    className={cn("flex flex-col gap-4 border-t py-6 first:border-t-0 first:pt-0", className)}
  >
    {(title !== undefined || description !== undefined) && (
      <div className="flex flex-col gap-1">
        {title !== undefined && <h2 className="text-sm font-semibold">{title}</h2>}
        {description !== undefined && (
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        )}
      </div>
    )}
    {children}
  </section>
);

/**
 * A field: its label (with `mark` beside it, where a field says where its value comes from), the control, and its hint,
 * or its problem in place of the hint, which a control can name in its `aria-describedby` as `noteId(htmlFor)`.
 */
export const Field = ({
  label,
  htmlFor,
  hint,
  problem = null,
  mark,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  problem?: string | null;
  mark?: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {mark}
    </div>
    {children}
    {problem === null ? (
      hint !== undefined && (
        <p id={noteId(htmlFor)} className="max-w-prose text-xs text-muted-foreground">
          {hint}
        </p>
      )
    ) : (
      <p id={noteId(htmlFor)} className="text-xs text-destructive">
        {problem}
      </p>
    )}
  </div>
);

/** The look of a text area: monospace for code, scripts and lists of names. */
export const TEXT_AREA =
  "min-w-0 rounded-md border border-input bg-background px-2.5 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring aria-invalid:border-destructive";

export const CODE_AREA = `${TEXT_AREA} font-mono`;

/** A monospace text area, with what it is for under it, or its problem instead. */
export const CodeField = ({
  id,
  label,
  value,
  rows,
  placeholder,
  problem,
  hint,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  rows: number;
  placeholder?: string;
  problem: string | null;
  hint: ReactNode;
  onChange: (value: string) => void;
}) => (
  <Field label={label} htmlFor={id} hint={hint} problem={problem}>
    <textarea
      id={id}
      rows={rows}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      data-1p-ignore
      onChange={(event) => {
        onChange(event.target.value);
      }}
      aria-invalid={problem !== null}
      className={CODE_AREA}
    />
  </Field>
);

/** The field that asks for `expected` to be typed before a destructive dialog's button works. */
export const ConfirmField = ({
  id,
  expected,
  typed,
  busy,
  onTyped,
}: {
  id: string;
  expected: string;
  typed: string;
  busy: boolean;
  onTyped: (typed: string) => void;
}) => (
  <div className="flex flex-col gap-1.5">
    <label htmlFor={id} className="text-sm">
      Type <span className="font-mono font-medium">{expected}</span> to confirm
    </label>
    <Input
      id={id}
      value={typed}
      onChange={(event) => {
        onTyped(event.target.value);
      }}
      autoCapitalize="none"
      autoCorrect="off"
      autoComplete="off"
      data-1p-ignore
      spellCheck={false}
      disabled={busy}
      className="font-mono"
    />
  </div>
);

/**
 * What a part shows while what it lists has not answered: Loading, or why it could not load (`problem`). `retry`, for
 * a query that does not ask again by itself, adds Try again.
 */
export const Pending = ({
  problem,
  retry,
  className,
}: {
  problem: string | null;
  retry?: (() => void) | undefined;
  className?: string | undefined;
}) =>
  problem === null ? (
    <p className={cn("text-sm text-muted-foreground", className)}>Loading…</p>
  ) : (
    <div className={cn("flex items-center gap-3", className)}>
      <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
        {problem}
      </p>
      {retry === undefined ? null : (
        <Button type="button" variant="outline" size="sm" onClick={retry}>
          Try again
        </Button>
      )}
    </div>
  );

/** What a section's form shows while its saved value has not answered; its query does not poll, so with Try again. */
const NotLoaded = <Fields, E>({ form, scope }: { form: SectionForm<Fields, E>; scope: string }) => {
  const loaded = useAtomValue(form.loaded(scope));
  const retry = useAtomRefresh(form.loaded(scope));

  return <Pending problem={failureOf(loaded)} retry={retry} />;
};

/**
 * The form of a section with a Save, at Scope `scope`: `children` renders its fields from what the form shows and sets
 * the draft; the bar under them saves only this section's fields. `invalid` holds Save while a field has a problem.
 * Reset to defaults puts the defaults in the draft, to save or not; a section with no defaults has no such button.
 * The bar sticks to the foot of the page, as wide as the content column; `inline` puts it right under the fields
 * instead, for a form that is only part of its section, so it does not seem to save what follows.
 */
export const SectionFormView = <Fields, E>({
  form,
  scope,
  invalid,
  inline = false,
  children,
}: {
  form: SectionForm<Fields, E>;
  scope: string;
  /** Whether `fields` has a problem that keeps it from being saved. */
  invalid: (fields: Fields) => boolean;
  /** Whether the bar sits under the fields rather than sticking to the foot of the page. */
  inline?: boolean;
  children: (fields: Fields, set: (fields: Fields) => void) => ReactNode;
}) => {
  const fields = useAtomValue(form.fields(scope));
  const [, setDraft] = useAtom(form.draft(scope));
  const dirty = useAtomValue(form.dirty(scope));
  const justSaved = useAtomValue(form.justSaved(scope));
  const [saved, save] = useAtom(form.save(scope));
  const saving = saved.waiting;
  const problem = settledFailureOf(saved);

  if (fields === null) return <NotLoaded form={form} scope={scope} />;

  const blocked = invalid(fields);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!dirty || blocked || saving) return;

    save();
  };

  return (
    <form onSubmit={submit} className="flex flex-col">
      {children(fields, setDraft)}
      <div
        className={cn(
          "flex flex-wrap items-center gap-3",
          inline ? "pb-6" : "sticky bottom-0 z-10 mt-2 border-t bg-background py-3",
        )}
      >
        <Button type="submit" disabled={!dirty || blocked || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {form.defaults !== undefined && (
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setDraft(form.defaults);
            }}
          >
            Reset to defaults
          </Button>
        )}
        {problem === null ? (
          justSaved &&
          !dirty && (
            <span role="status" className="text-sm text-muted-foreground">
              Saved
            </span>
          )
        ) : (
          <p
            role="alert"
            className="min-w-0 basis-full text-sm whitespace-pre-wrap text-destructive"
          >
            {problem}
          </p>
        )}
      </div>
    </form>
  );
};
