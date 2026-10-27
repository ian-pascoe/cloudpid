// A diff view's editor of draft Annotations (ADR-0011): one per view (a card's Call diff, the Diff pane's scroll), kept
// in its scope. It holds the lines a new draft is written on, or the draft being edited, and the text typed, which stays
// in this browser until it is saved.

import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";
import type { PickedLines } from "./selection.ts";

/** What a diff view's editor holds. */
export interface EditorState {
  /** Which diff of the view it is open in: the Pane's file ID; a card has one. */
  readonly diff: string | null;
  /** The lines a new draft is written on. */
  readonly picked: PickedLines | null;
  /** The draft being edited, by ID. */
  readonly editing: string | null;
  readonly text: string;
  readonly saving: boolean;
  /** Why the last save failed. */
  readonly error: string | null;
}

/** An editor that is not open. */
export const CLOSED: EditorState = {
  diff: null,
  picked: null,
  editing: null,
  text: "",
  saving: false,
  error: null,
};

/** A view's editor, closed. */
export const editorAtom = (): Atom.Writable<EditorState> => Atom.make<EditorState>(CLOSED);

/**
 * The editor of the diff view this renders in. A card's `Provider` makes its own; the Diff pane provides its scroll's
 * (`AnnotationEditor.Context`), which its items read too.
 */
export const AnnotationEditor = ScopedAtom.make(editorAtom);
