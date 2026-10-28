// A patch drawn by @pierre/diffs (`docs/architecture/diffs-and-review.md`): the library, its highlighter and its theme load
// with this module, so a page with no diff on it does not fetch them (`CallDiffBody` imports it lazily).
//
// Given an `anchor` (the call that wrote the file), the owner drafts Annotations on it from the gutter
// (`review/annotations-ui.tsx`), and the drafts already on it show under their lines.
import { type FileDiffOptions, parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";
import type { DiffStyle } from "../call-diff.ts";
import { DIFF_THEME } from "../diff-theme.ts";
import {
  AnnotationSlotView,
  DRAFTING_OPTIONS,
  useDiffDrafts,
  useOpenEditor,
} from "../review/annotations-ui.tsx";
import type { AnnotationSlot, DiffAnchor } from "../review/drafts.ts";
import { AnnotationEditor } from "../review/editor.ts";

/** A card has one diff: the key its editor is opened under. */
const CARD = "card";

type PatchViewProps = {
  patch: string;
  diffStyle: DiffStyle;
  /** The Session the drafts are kept in. */
  sessionId: string;
  /** What drafts on this diff anchor to; without one, the diff takes none. */
  anchor: DiffAnchor | undefined;
};

const Patch = ({ patch, diffStyle, sessionId, anchor }: PatchViewProps) => {
  const file = useMemo(() => parsePatchFiles(patch)[0]?.files[0], [patch]);
  const { drafts, lineAnnotations } = useDiffDrafts(sessionId, anchor, CARD);
  const open = useOpenEditor();
  const drafting = anchor !== undefined && file !== undefined;

  const options = useMemo((): FileDiffOptions<AnnotationSlot, undefined> => {
    const shown: FileDiffOptions<AnnotationSlot, undefined> = {
      theme: DIFF_THEME,
      diffStyle,
      disableFileHeader: true,
      overflow: "wrap",
      lineDiffType: "word",
      hunkSeparators: "line-info-basic",
    };

    if (!drafting) return shown;

    return {
      ...shown,
      ...DRAFTING_OPTIONS,
      onGutterUtilityClick: (range) => {
        open(CARD, file, range);
      },
    };
  }, [diffStyle, drafting, file, open]);

  if (file === undefined) return <p className="text-sm text-muted-foreground">No diff to show.</p>;

  return (
    <FileDiff<AnnotationSlot>
      fileDiff={file}
      options={options}
      lineAnnotations={lineAnnotations}
      renderAnnotation={(annotation) =>
        anchor === undefined ? null : (
          <AnnotationSlotView
            sessionId={sessionId}
            anchor={anchor}
            drafts={drafts}
            annotation={annotation}
          />
        )
      }
    />
  );
};

const PatchView = (props: PatchViewProps) => (
  <AnnotationEditor.Provider>
    <Patch {...props} />
  </AnnotationEditor.Provider>
);

export default PatchView;
