// @effect-diagnostics missingPipeableSignature:off -- plain functions over an editor's state, called from React and atoms.

// An editor of draft Annotations (ADR-0011): one per view (a card's Call diff, the Diff pane's scroll, the Browser Pane's
// screen), kept in its scope. It holds what it is open on (the lines or the spot of a page a new draft is written on,
// or the draft being edited), and the text typed, which stays in this browser until it is saved.

import type { PageCrop, PageElement, PageRect } from "@cloudpid/protocol";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";
import type { PickedLines } from "./selection.ts";

/**
 * What a pick in the Browser Pane's Annotate mode found: an element (with its text), or an area; where, and the page's
 * scroll and viewport then.
 */
export interface Picked {
  readonly box: PageRect;
  readonly element?: PageElement | undefined;
  readonly text: readonly string[];
  readonly more: number;
  readonly scroll: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
}

/** What a new draft on a page is written on: the spot picked, its crop, and the page and Owner tab it is in. */
export interface PagePick {
  readonly picked: Picked;
  readonly crop: PageCrop | undefined;
  readonly url: string;
  readonly ownerTabId: string;
}

/** What an editor is open on. */
export type EditorOn =
  /** The lines a new draft is written on, in one diff of the view: the Pane's file ID; a card has one. */
  | { readonly kind: "lines"; readonly diff: string; readonly picked: PickedLines }
  /** The spot of a page a new draft is written on (the Browser Pane's). */
  | { readonly kind: "page"; readonly pick: PagePick }
  /** A draft being edited, by ID. */
  | { readonly kind: "draft"; readonly id: string };

/** What an editor holds. */
export interface EditorState {
  /** What it is open on; null while it is closed. */
  readonly on: EditorOn | null;
  readonly text: string;
  readonly saving: boolean;
  /** Why the last save failed. */
  readonly error: string | null;
}

/** An editor that is not open. */
export const CLOSED: EditorState = { on: null, text: "", saving: false, error: null };

/** The editor open on `on`, with `text` typed. */
export const openOn = (on: EditorOn, text = ""): EditorState => ({ ...CLOSED, on, text });

/** The lines a new draft is written on in diff `diff`, when the editor is open on some there. */
export const pickedIn = (editor: EditorState, diff: string): PickedLines | null =>
  editor.on?.kind === "lines" && editor.on.diff === diff ? editor.on.picked : null;

/** The draft being edited, by ID, if one is. */
export const editingId = (editor: EditorState): string | null =>
  editor.on?.kind === "draft" ? editor.on.id : null;

/** A view's editor, closed. */
export const editorAtom = (): Atom.Writable<EditorState> => Atom.make<EditorState>(CLOSED);

/**
 * The editor of the view this renders in. A card's `Provider` makes its own; the Diff pane provides its scroll's
 * (`AnnotationEditor.Context`), which its items read too; the Browser Pane's screen has its own.
 */
export const AnnotationEditor = ScopedAtom.make(editorAtom);
