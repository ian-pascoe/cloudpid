// Renaming a Session from its "⋯" menu: the title being typed in the rename dialog, and its save.

import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";

/** Naming the Session: its title now ("" while it has none), and how to save a new one. */
export type Rename = {
  readonly current: string;
  /** Resolves to null when the title was saved, or to why it was not. */
  readonly save: (title: string) => Promise<string | null>;
};

/**
 * The title typed in one menu's rename dialog, or null while the dialog is closed. One per menu (a `ScopedAtom`), since
 * a Session's page and its list item each have a menu.
 */
export const titleDraft = (): Atom.Writable<string | null> => Atom.make<string | null>(null);

/**
 * Save the title typed in `draft` with `rename`, and close the dialog; a blank or unchanged title only closes it. Fails
 * with why the title was not saved, leaving the dialog open. A dialog already closed has nothing to save.
 */
export const saveTitleAtom = Atom.family((draft: Atom.Writable<string | null>) =>
  Atom.fn((rename: Rename, get) =>
    Effect.gen(function* () {
      // Read, not followed: typing on must not save again.
      const typed = get.registry.get(draft);

      if (typed === null) return;

      const next = typed.trim();

      if (next !== "" && next !== rename.current) {
        const failure = yield* Effect.promise(() => rename.save(next));

        if (failure !== null) return yield* Effect.fail(failure);
      }

      get.set(draft, null);
    }),
  ),
);
