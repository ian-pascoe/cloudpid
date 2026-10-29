// The forms of the Settings page's sections (docs/architecture/client-and-protocol.md → Settings page → Saving). A
// section edits a part of one saved value (the Settings, an Environment's Container settings, the variables kept
// Global, an Environment's name): its draft holds only its own fields, and its Save writes the saved value as it is
// now with only the fields the owner changed replaced, so a draft of another section is never sent, and a field the
// owner left alone keeps what another save or an agent made it meanwhile. Drafts are kept per Scope and section while
// the app is open, so moving between sections and Scopes keeps them; the navigation marks a section whose draft differs
// from what is saved.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Reactivity from "effect/reactivity/Reactivity";
import type { RegistryClient, RegistryKey } from "../registry.ts";
import { appRuntime } from "../runtime.ts";

/** What a section's form is built from. */
export interface SectionFormSpec<Saved, Fields, E> {
  /** The saved value at Scope `scope`, as a Registry query: the section shows it, and waits for it after a save. */
  readonly saved: (scope: string) => Atom.Atom<AsyncResult.AsyncResult<Saved, E>>;
  /** The section's fields of a saved value, as its form holds them (typed text where it parses what is typed). */
  readonly fieldsOf: (saved: Saved) => Fields;
  /** `saved` with the section's fields replaced by `fields` (which the form has checked). */
  readonly merge: (saved: Saved, fields: Fields) => Saved;
  /** Whether two sets of fields mean the same saved value; by default, whether they are equal as JSON. */
  readonly same?: ((left: Fields, right: Fields) => boolean) | undefined;
  /** The fields of the defaults, which Reset to defaults puts in the draft; undefined for a section with none. */
  readonly defaults?: Fields | undefined;
  /** Read the saved value at Scope `scope` from the Registry, as it is now. */
  readonly read: (scope: string) => Effect.Effect<Saved, E, RegistryClient>;
  /**
   * Make the value at Scope `scope` `before` into `after`: both are the value as it is now, `before` with the
   * section's fields as the draft began from and `after` with them as typed, so they differ only in what the owner
   * changed. A Scope saved as a patch sends just that difference; one saved whole writes `after`.
   */
  readonly write: (
    scope: string,
    before: Saved,
    after: Saved,
  ) => Effect.Effect<unknown, E, RegistryClient>;
  /** What a save at Scope `scope` changes, for the queries to ask again. */
  readonly keys: (scope: string) => ReadonlyArray<RegistryKey>;
}

/** A section's form, by Scope: its draft, what it shows, whether it has unsaved changes, and its Save. */
export interface SectionForm<Fields, E> {
  /** What was typed or picked and not saved; undefined while the form shows what is saved. */
  readonly draft: (scope: string) => Atom.Writable<Fields | undefined>;
  /** The saved fields, as the section's query last answered (or why it could not). */
  readonly loaded: (scope: string) => Atom.Atom<AsyncResult.AsyncResult<Fields, E>>;
  /** What the form shows: the draft, else the saved fields; null until the saved value first answers. */
  readonly fields: (scope: string) => Atom.Atom<Fields | null>;
  /** Whether the draft differs from what is saved. */
  readonly dirty: (scope: string) => Atom.Atom<boolean>;
  /** Whether the last save worked and the draft has not been touched since: the bar says "Saved". */
  readonly justSaved: (scope: string) => Atom.Writable<boolean>;
  /**
   * Save the draft: the value as the Registry has it now, with this section's fields replaced, written back. Once the
   * section's query has the new value the draft is dropped, so the form shows what is saved.
   */
  readonly save: (scope: string) => Atom.AtomResultFn<void, void, E>;
  readonly defaults: Fields | undefined;
}

/** The fields of section form `Form`, as its draft holds them. */
export type FormFields<Form> = Form extends SectionForm<infer Fields, infer _E> ? Fields : never;

const sameAsJson = <Fields>(left: Fields, right: Fields): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** The fields of `typed` that differ from `base`, each compared alone as the section's `same` reads it. */
const changedKeys = <Fields extends object>(
  typed: Fields,
  base: Fields,
  same: (left: Fields, right: Fields) => boolean,
): ReadonlyArray<keyof Fields> =>
  Arr.filter(
    // SAFETY: a section's fields are a plain object of its own keys, which `Object.keys` lists.
    // @effect-diagnostics-next-line preferEffectRecord:off -- the fields are an object type, not a Record.
    Object.keys(typed) as Array<keyof Fields>,
    (key) => !same({ ...base, [key]: typed[key] }, base),
  );

/** `now` with the fields `keys` as `from` has them. */
const withFields = <Fields extends object>(
  now: Fields,
  from: Fields,
  keys: ReadonlyArray<keyof Fields>,
): Fields => {
  const out = { ...now };

  for (const key of keys) out[key] = from[key];

  return out;
};

/** The form of a section that edits part of `spec`'s saved value. */
export const sectionForm = <Saved, Fields extends object, E>(
  spec: SectionFormSpec<Saved, Fields, E>,
): SectionForm<Fields, E> => {
  const same = spec.same ?? sameAsJson;

  const justSaved = Atom.family((_scope: string) => Atom.make(false).pipe(Atom.keepAlive));

  // Kept while the app is open, so leaving the section (or the page) keeps it.
  const stored = Atom.family((_scope: string) =>
    Atom.make<Fields | undefined>(undefined).pipe(Atom.keepAlive),
  );

  // The saved fields as the draft began from them, so a save sends only what the owner changed since.
  const base = Atom.family((_scope: string) =>
    Atom.make<Fields | undefined>(undefined).pipe(Atom.keepAlive),
  );

  const loaded = Atom.family((scope: string) =>
    Atom.map(spec.saved(scope), (result) => AsyncResult.map(result, spec.fieldsOf)),
  );

  const savedFields = Atom.family((scope: string) =>
    Atom.map(loaded(scope), (result) => result.pipe(AsyncResult.value, Option.getOrNull)),
  );

  const draft = Atom.family((scope: string) =>
    Atom.writable(
      (get) => get(stored(scope)),
      (ctx, value: Fields | undefined) => {
        if (value === undefined) ctx.set(base(scope), undefined);
        else if (ctx.get(stored(scope)) === undefined)
          ctx.set(base(scope), ctx.get(savedFields(scope)) ?? undefined);

        ctx.set(stored(scope), value);
        ctx.set(justSaved(scope), false);
      },
    ),
  );

  const fields = Atom.family((scope: string) =>
    Atom.readable((get): Fields | null => get(stored(scope)) ?? get(savedFields(scope))),
  );

  const dirty = Atom.family((scope: string) =>
    Atom.readable((get): boolean => {
      const typed = get(stored(scope));
      const saved = get(savedFields(scope));

      return typed !== undefined && saved !== null && !same(typed, saved);
    }),
  );

  const save = Atom.family((scope: string) =>
    appRuntime.fn(
      (_: void, get) =>
        Effect.gen(function* () {
          const typed = get.registry.get(stored(scope));

          if (typed === undefined) return;

          const now = yield* spec.read(scope);
          const nowFields = spec.fieldsOf(now);
          const began = get.registry.get(base(scope)) ?? nowFields;
          const changed = changedKeys(typed, began, same);

          // Before and after differ only in the fields the owner changed: from what the draft began from to what is typed.
          // A draft the owner put back as it began changes nothing, and is only dropped.
          if (changed.length > 0) {
            yield* spec.write(
              scope,
              spec.merge(now, withFields(nowFields, began, changed)),
              spec.merge(now, withFields(nowFields, typed, changed)),
            );
          }

          yield* Reactivity.invalidate(spec.keys(scope));
          // The form shows the draft until the query has the saved value, so it does not flash the old one.
          yield* get.result(spec.saved(scope), { suspendOnWaiting: true }).pipe(Effect.ignore);

          // What was typed while it saved is kept, as a draft still to save from what was just saved.
          if (get.registry.get(stored(scope)) === typed) {
            get.set(stored(scope), undefined);
            get.set(base(scope), undefined);
          } else get.set(base(scope), typed);

          get.set(justSaved(scope), true);
        }),
      { concurrent: true },
    ),
  );

  return { draft, loaded, fields, dirty, justSaved, save, defaults: spec.defaults };
};
