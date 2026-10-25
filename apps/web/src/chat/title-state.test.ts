// @effect-diagnostics preferEffectArray:off -- a fake rename recording what it saved in a native array.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { settledFailureOf } from "../registry.ts";
import { settled } from "../registry.testing.ts";
import { type Rename, saveTitleAtom, titleDraft } from "./title-state.ts";

/** One menu's rename dialog, as its `ScopedAtom` makes it. */
const draft = titleDraft();

/** A rename of a Session titled `current` that refuses `refused`, and the titles it saved. */
const renaming = (current: string) => {
  const saved: string[] = [];

  const rename: Rename = {
    current,
    save: (title) => {
      if (title === "refused") return Promise.resolve("No such session.");

      saved.push(title);

      return Promise.resolve(null);
    },
  };

  return { rename, saved };
};

const typing = (registry: AtomRegistry.AtomRegistry, title: string) => {
  registry.mount(saveTitleAtom(draft));
  registry.set(draft, title);
};

describe("renaming a Session from its menu", () => {
  it.effect("saves the trimmed title and closes the dialog", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const { rename, saved } = renaming("Old");

      typing(registry, "  New  ");
      registry.set(saveTitleAtom(draft), rename);
      yield* settled(registry, saveTitleAtom(draft));

      expect(saved).toEqual(["New"]);
      expect(registry.get(draft)).toBe(null);
    }),
  );

  it.effect("only closes the dialog for a blank or unchanged title", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const { rename, saved } = renaming("Old");

      typing(registry, " Old ");
      registry.set(saveTitleAtom(draft), rename);
      yield* settled(registry, saveTitleAtom(draft));

      typing(registry, "   ");
      registry.set(saveTitleAtom(draft), rename);
      yield* settled(registry, saveTitleAtom(draft));

      expect(saved).toEqual([]);
      expect(registry.get(draft)).toBe(null);
    }),
  );

  it.effect("keeps the dialog open, saying why, when the save is refused, until reset", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const { rename } = renaming("Old");

      typing(registry, "refused");
      registry.set(saveTitleAtom(draft), rename);

      expect(settledFailureOf(yield* settled(registry, saveTitleAtom(draft)))).toBe(
        "No such session.",
      );
      expect(registry.get(draft)).toBe("refused");

      registry.set(saveTitleAtom(draft), Atom.Reset);

      expect(settledFailureOf(registry.get(saveTitleAtom(draft)))).toBe(null);
    }),
  );

  it.effect("saves nothing once the dialog is closed", () =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      const { rename, saved } = renaming("Old");

      typing(registry, "New");
      registry.set(draft, null);
      registry.set(saveTitleAtom(draft), rename);
      yield* settled(registry, saveTitleAtom(draft));

      expect(saved).toEqual([]);
    }),
  );
});
