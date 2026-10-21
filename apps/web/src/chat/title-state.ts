// Renaming a Session in place, from its header: the title being typed, and its save.

import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";

/** Naming the Session: its title now ("" while it has none), and how to save a new one. */
export type Rename = {
  readonly current: string;
  /** Resolves to null when the title was saved, or to why it was not. */
  readonly save: (title: string) => Promise<string | null>;
};

/** The title typed in Session `sessionId`'s header, or null while its field is closed. */
export const titleDraftAtom = Atom.family<string, Atom.Writable<string | null>>(() =>
  Atom.make<string | null>(null),
);

/**
 * Save the title typed in Session `sessionId`'s header with `rename`, and close the field; a blank or unchanged title
 * only closes it. Fails with why the title was not saved, leaving the field open. A field already closed (by Escape, or
 * by the save before) has nothing to save, so the blur of its closing is no save.
 */
export const saveTitleAtom = Atom.family((sessionId: string) =>
  Atom.fn((rename: Rename, get) =>
    Effect.gen(function* () {
      // Read, not followed: typing on must not save again.
      const draft = get.registry.get(titleDraftAtom(sessionId));

      if (draft === null) return;

      const next = draft.trim();

      if (next !== "" && next !== rename.current) {
        const failure = yield* Effect.promise(() => rename.save(next));

        if (failure !== null) return yield* Effect.fail(failure);
      }

      get.set(titleDraftAtom(sessionId), null);
    }),
  ),
);
