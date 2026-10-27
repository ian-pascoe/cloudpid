// Drafting Annotations in a diff (`docs/spec.md` → Diffs and review → Annotations and Reviews): the gutter's + (or a
// drag down it, or lines picked by their numbers first) opens an editor under the lines picked; a saved draft shows under
// its last line as a card with its text, Edit and Delete, marked when its lines changed since. Every client shows the
// same drafts (the Session sends them); the text being typed stays in this browser until it is saved.
//
// One editor per diff view (a card's Call diff, the Diff pane's scroll), kept in its `AnnotationEditor` scope (`editor.ts`).
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- the drafts are native arrays; hooks, not combinators.

import { type Annotation, MAX_ANNOTATION_TEXT, rangeText } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { type ReactNode, useCallback, useId } from "react";
import { useCall } from "../calls.ts";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { messageOf } from "../registry.ts";
import { annotationsAtom, deleteAnnotationAtom, saveAnnotationAtom } from "../session/atoms.ts";
import {
  type AnnotationSlot,
  type DiffAnchor,
  diffDrafts,
  editedDraft,
  newDraft,
  statusLabel,
} from "./drafts.ts";
import { AnnotationEditor, CLOSED } from "./editor.ts";
import { QuotedLines } from "./review-chips.tsx";
import { pickLines } from "./selection.ts";

/** The drafts of a diff view's file, and where they show. */
export const useDiffDrafts = (sessionId: string, anchor: DiffAnchor | undefined, diff: string) => {
  const annotations = useAtomValue(annotationsAtom(sessionId));
  const editor = useAtomValue(AnnotationEditor.use());

  return diffDrafts(annotations, anchor, editor, diff);
};

/** Open the editor on the lines `range` picks in `fileDiff`: a new draft, under them. */
export const useOpenEditor = () => {
  const setEditor = useAtomSet(AnnotationEditor.use());

  // The same function while the editor is, so the diff's options stay the same between renders.
  return useCallback(
    (diff: string, fileDiff: FileDiffMetadata, range: SelectedLineRange) => {
      const picked = pickLines(fileDiff, range);

      if (picked !== undefined) setEditor({ ...CLOSED, diff, picked });
    },
    [setEditor],
  );
};

/** The text box of an editor, with Save and Cancel; Escape cancels, Mod+Enter saves. */
const EditorBox = ({
  label,
  onSave,
}: {
  /** What the box is for, read by a screen reader: the lines it is on. */
  label: string;
  onSave: (text: string) => void;
}) => {
  const [editor, setEditor] = useAtom(AnnotationEditor.use());
  const errorId = useId();
  const blank = editor.text.trim() === "";

  const save = () => {
    if (!blank && !editor.saving) onSave(editor.text.trim());
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label={label}
        aria-describedby={editor.error === null ? undefined : errorId}
        ref={focusNextFrame}
        rows={3}
        maxLength={MAX_ANNOTATION_TEXT}
        value={editor.text}
        placeholder="What should the agent know about these lines?"
        onChange={(event) => {
          const text = event.currentTarget.value;

          setEditor((before) => ({ ...before, text }));
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setEditor(CLOSED);
          }

          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
        className="block min-h-16 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      {editor.error !== null && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {editor.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setEditor(CLOSED);
          }}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={blank || editor.saving} onClick={save}>
          {editor.saving ? "Saving…" : "Save draft"}
        </Button>
      </div>
    </div>
  );
};

/**
 * Focus a textarea the owner opened to write in a frame after it mounts: it is slotted into the diff's shadow root,
 * where `autoFocus` finds it not yet in the document. Module-level, so React calls it once per mount.
 */
const focusNextFrame = (node: HTMLTextAreaElement | null) => {
  if (node === null) return;

  const frame = requestAnimationFrame(() => {
    node.focus();
  });

  return () => {
    cancelAnimationFrame(frame);
  };
};

/** The frame of an Annotation in a diff: under its lines, in the page's type, not the code's. */
const Frame = ({ children, outdated }: { children: ReactNode; outdated?: boolean }) => (
  <div
    className={cn(
      "mx-2 my-1.5 max-w-2xl rounded-lg border bg-background px-3 py-2 font-sans text-sm whitespace-normal text-foreground",
      outdated === true && "border-dashed",
    )}
  >
    {children}
  </div>
);

/** Save `draft` through the Session; the editor closes once it has it, and says why it did not. */
const useSave = (sessionId: string) => {
  const [, setEditor] = useAtom(AnnotationEditor.use());
  const save = useCall(saveAnnotationAtom(sessionId));

  return (draft: Parameters<typeof save>[0]) => {
    setEditor((before) => ({ ...before, saving: true, error: null }));
    void save(draft).then((exit) => {
      if (Exit.isSuccess(exit)) {
        setEditor(CLOSED);

        return;
      }

      if (Cause.hasInterruptsOnly(exit.cause)) return;

      setEditor((before) => ({ ...before, saving: false, error: messageOf(exit.cause) }));
    });
  };
};

/** The editor of a new draft on `anchor`'s diff, under the lines picked. */
const NewDraft = ({ sessionId, anchor }: { sessionId: string; anchor: DiffAnchor }) => {
  const [editor] = useAtom(AnnotationEditor.use());
  const save = useSave(sessionId);
  const { picked } = editor;

  if (picked === null) return null;

  return (
    <Frame>
      <p className="mb-1.5 text-xs text-muted-foreground">New Annotation on {rangeText(picked)}</p>
      <EditorBox
        label={`Annotation on ${rangeText(picked)}`}
        onSave={(text) => {
          // @effect-diagnostics-next-line cryptoRandomUUID:off -- the browser makes a draft's ID, so its card shows at once.
          save(newDraft(crypto.randomUUID(), anchor, picked, text));
        }}
      />
    </Frame>
  );
};

/** A saved draft under its lines: its mark, its text, Edit and Delete; or the editor of it, while edited. */
const DraftCard = ({ sessionId, draft }: { sessionId: string; draft: Annotation }) => {
  const [editor, setEditor] = useAtom(AnnotationEditor.use());
  const save = useSave(sessionId);
  const remove = useCall(deleteAnnotationAtom(sessionId));
  const status = statusLabel(draft);

  const header = (
    <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
      <span>Your Annotation on {rangeText(draft)}</span>
      {status !== undefined && <span className="font-medium text-foreground">· {status}</span>}
    </p>
  );

  if (editor.editing === draft.id) {
    return (
      <Frame outdated={status !== undefined}>
        {header}
        <EditorBox
          label={`Edit the Annotation on ${rangeText(draft)}`}
          onSave={(text) => {
            save(editedDraft(draft, text));
          }}
        />
      </Frame>
    );
  }

  return (
    <Frame outdated={status !== undefined}>
      {header}
      {/* Marked: its lines read otherwise now, so the card keeps the ones it was written on. */}
      {status !== undefined && <QuotedLines lines={draft.quote} more={draft.more} />}
      <p className="break-words whitespace-pre-wrap">{draft.text}</p>
      <div className="mt-1.5 flex gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-2 text-xs text-muted-foreground"
          onClick={() => {
            setEditor({ ...CLOSED, editing: draft.id, text: draft.text });
          }}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-2 text-xs text-muted-foreground"
          onClick={() => {
            void remove(draft.id);
          }}
        >
          Delete
        </Button>
      </div>
    </Frame>
  );
};

/** What a diff draws for one of its line annotations: a draft's card, or the editor of a new one. */
export const AnnotationSlotView = ({
  sessionId,
  anchor,
  drafts,
  annotation,
}: {
  sessionId: string;
  anchor: DiffAnchor;
  drafts: readonly Annotation[];
  annotation: DiffLineAnnotation<AnnotationSlot>;
}) => {
  const slot = annotation.metadata;

  if (slot.kind === "new") return <NewDraft sessionId={sessionId} anchor={anchor} />;

  const draft = drafts.find((each) => each.id === slot.id);

  return draft === undefined ? null : <DraftCard sessionId={sessionId} draft={draft} />;
};

/** The options that switch on drafting in a diff: the gutter's +, a drag down it, and lines picked by their numbers. */
export const DRAFTING_OPTIONS = {
  enableGutterUtility: true,
  enableLineSelection: true,
  lineHoverHighlight: "number",
} as const;
