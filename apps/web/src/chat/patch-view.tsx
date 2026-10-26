// A patch drawn by @pierre/diffs (`docs/spec.md` → Diffs and review): the library, its highlighter and its theme load
// with this module, so a page with no diff on it does not fetch them (`CallDiffBody` imports it lazily).
//
// The seam for Annotations (a later slice): the `options` here are where the gutter selection (`enableLineSelection`,
// `onGutterUtilityClick`) is switched on, and `FileDiff` takes `lineAnnotations` and `renderAnnotation` beside them.
import { parsePatchFiles, registerCustomCSSVariableTheme } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMemo } from "react";

/** The CSS-variables theme of the notebook skin: its `--diffs-*` variables are in `styles.css`. */
const THEME = "cloudpid";

registerCustomCSSVariableTheme(THEME, {});

const PatchView = ({ patch, diffStyle }: { patch: string; diffStyle: "split" | "unified" }) => {
  const file = useMemo(() => parsePatchFiles(patch)[0]?.files[0], [patch]);

  const options = useMemo(
    () => ({
      theme: THEME,
      diffStyle,
      disableFileHeader: true,
      overflow: "wrap" as const,
      lineDiffType: "word" as const,
      hunkSeparators: "line-info-basic" as const,
    }),
    [diffStyle],
  );

  if (file === undefined) return <p className="text-sm text-muted-foreground">No diff to show.</p>;

  return <FileDiff fileDiff={file} options={options} />;
};

export default PatchView;
