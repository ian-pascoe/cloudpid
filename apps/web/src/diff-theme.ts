// The `@pierre/diffs` theme of the notebook skin (`docs/architecture/diffs-and-review.md` → Rendering): a CSS-variables theme
// whose `--diffs-*` variables are in `styles.css`. Imported by the lazy modules that draw diffs (a Call diff's
// `patch-view.tsx`, the Diff pane's `changes-view.tsx`), so the library loads with them only.
import { registerCustomCSSVariableTheme } from "@pierre/diffs";

/** The theme's name, as the library's options and the Worker Pool take it. */
export const DIFF_THEME = "cloudpid";

registerCustomCSSVariableTheme(DIFF_THEME, {});
