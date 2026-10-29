// @effect-diagnostics missingPipeableSignature:off -- plain helpers over a form's fields, called from React.

// A section of the Settings page at either Scope (ADR-0027; docs/architecture/client-and-protocol.md → Settings page →
// Scopes and marks): its form (`scoped.ts`), with each field's mark. At an Environment a field is Inherited (Global's value, its
// control on a dashed border; typing in it, or Override, makes it the Environment's own) or Overridden (with Reset to
// Global), and the bar's Reset all to Global resets the section's Overrides once confirmed. At Global a field that
// Environments override says so under it, naming each with a link to the field at its Scope.

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Result from "effect/Result";
import type { ReactNode } from "react";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { settledFailureOf } from "../registry.ts";
import { settingsPath } from "../router.ts";
import { cn } from "../lib/utils.ts";
import { FieldMark, OverriddenIn, SectionFormView } from "./parts.tsx";
import type { MarkedFields, ScopedForm } from "./scoped.ts";
import { sectionLabel, type SectionSlug } from "./sections.ts";

/** The id of field `path` on its section, which a link to it names after `#`. */
export const fieldAnchor = (path: string): string => `field-${path}`;

/** `fields` with field `key` set to `value`, the Environment's own: what typing in it, or Override, does. */
export const withOverride = <F, K extends keyof F & string>(
  fields: MarkedFields<F>,
  key: K,
  value: F[K] = fields[key].value,
): MarkedFields<F> => ({ ...fields, [key]: { value, inherited: false } });

/** `fields` with field `key` inheriting Global's value (`global`'s) again: what Reset to Global does. */
export const withInherited = <F, K extends keyof F & string>(
  fields: MarkedFields<F>,
  key: K,
  global: MarkedFields<F>,
): MarkedFields<F> => ({ ...fields, [key]: { value: global[key].value, inherited: true } });

/** What a field of a section is given beside its control: its mark, its note and its anchor, as `Field` takes them. */
export interface FieldMarks {
  readonly mark: ReactNode;
  readonly note: ReactNode;
  readonly anchor: string;
}

/** A section's fields as its controls read and set them, with their marks. */
export interface FieldBinding<F> {
  /** The fields as the form shows them, with their marks. */
  readonly fields: MarkedFields<F>;
  /** The value field `key` shows: Global's while the Environment inherits it. */
  readonly value: <K extends keyof F & string>(key: K) => F[K];
  /** Whether the Environment inherits field `key` (never at Global). */
  readonly inherited: (key: keyof F & string) => boolean;
  /** Type `value` into field `key`: at an Environment, it becomes the Environment's Override. */
  readonly set: <K extends keyof F & string>(key: K, value: F[K]) => void;
  /** Field `key`'s mark (at an Environment), note (at Global) and anchor. */
  readonly marks: (key: keyof F & string) => FieldMarks;
  /** The look of field `key`'s control: a dashed border while it is inherited. */
  readonly look: (key: keyof F & string) => string;
  /**
   * The look of the frame around field `key`'s control where the control has no border of its own (a checkbox): at an
   * Environment the Input Line, dashed while it is inherited; none at Global.
   */
  readonly frame: (key: keyof F & string) => string;
}

/**
 * The form of section `section` at Scope `scope`, from `form`: the Registry's problem with what it saved, if any, then
 * the fields `children` renders from the binding, then the bar.
 */
export const ScopedSectionForm = <Value, F>({
  form,
  scope,
  section,
  invalid,
  children,
}: {
  form: ScopedForm<Value, F>;
  scope: string;
  section: SectionSlug;
  /** Whether the fields have a problem that keeps them from being saved. */
  invalid: (fields: MarkedFields<F>) => boolean;
  children: (binding: FieldBinding<F>) => ReactNode;
}) => {
  const view = useAtomValue(form.scopeView(scope));
  const saved = useAtomValue(form.loaded(scope)).pipe(AsyncResult.value, Option.getOrNull);
  const [resetting, reset] = useAtom(form.resetToGlobal(scope));
  const atGlobal = scope === GLOBAL_SCOPE;

  return (
    <>
      <DialogProblem problem={view?.problem ?? null} />
      <DialogProblem problem={settledFailureOf(resetting)} />
      <SectionFormView
        form={form}
        scope={scope}
        invalid={invalid}
        resetToGlobal={
          atGlobal
            ? undefined
            : {
                section: sectionLabel(section, scope),
                overridden:
                  saved === null
                    ? []
                    : Arr.filterMap(form.paths, (key) =>
                        saved[key].inherited ? Result.failVoid : Result.succeed(form.labels[key]),
                      ),
                reset: () => {
                  reset();
                },
                resetting: resetting.waiting,
              }
        }
      >
        {(fields, setFields) =>
          children({
            fields,
            value: (key) => fields[key].value,
            inherited: (key) => fields[key].inherited,
            set: (key, value) => {
              setFields(withOverride(fields, key, value));
            },
            look: (key) => (fields[key].inherited ? "border-dashed" : ""),
            frame: (key) =>
              atGlobal
                ? ""
                : cn(
                    "rounded-md border border-input px-3 py-2",
                    fields[key].inherited && "border-dashed",
                  ),
            marks: (key) => ({
              anchor: fieldAnchor(key),
              mark: atGlobal ? null : (
                <FieldMark
                  kind={fields[key].inherited ? "inherited" : "overridden"}
                  name={form.labels[key]}
                  onOverride={() => {
                    setFields(withOverride(fields, key));
                  }}
                  onReset={() => {
                    if (view !== null) setFields(withInherited(fields, key, view.inherited));
                  }}
                />
              ),
              note: atGlobal ? (
                <OverriddenIn
                  environments={view?.overriddenIn[key]}
                  pathAt={(environment) =>
                    `${settingsPath(environment, section)}#${fieldAnchor(key)}`
                  }
                />
              ) : null,
            }),
          })
        }
      </SectionFormView>
    </>
  );
};
