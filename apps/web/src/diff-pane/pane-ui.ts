// What the owner did to one Diff pane (`docs/architecture/diffs-and-review.md` → Diff pane), as long as it is mounted: the
// files folded or opened by hand, and the place it is held at. A place the Pane is asked to show (`diffTargetAtom`: the
// Session details, a Call diff, its own file list) opens that file and holds the scroll there, as files above
// it load and grow, until the owner scrolls.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over values, a reducer, over native arrays.

import type { DiffTarget } from "./target.ts";

/** One Pane's own state. */
export interface PaneUi {
  /** Files folded (`true`) or opened (`false`) by hand. */
  readonly overrides: ReadonlyMap<string, boolean>;
  /** The place the scroll is held at, until the owner scrolls; null once they have. */
  readonly anchor: DiffTarget | null;
}

export const INITIAL_PANE_UI: PaneUi = { overrides: new Map(), anchor: null };

/** What the owner does to the Pane. */
export type PaneUiAction =
  | { readonly type: "fold"; readonly id: string; readonly folded: boolean }
  | { readonly type: "collapse-all"; readonly ids: readonly string[] }
  /** Let go of what the owner did to a file: it is folded or open as the rules say again (a Viewed file is folded). */
  | { readonly type: "forget"; readonly id: string }
  /** The Pane's own file list: show a file, as a place asked for from elsewhere is. */
  | { readonly type: "show"; readonly target: DiffTarget }
  /** The owner scrolled: the place the Pane was asked to show is let go. */
  | { readonly type: "release" };

/** `ui` asked to show `target`: its file opens, and the scroll is held there. */
export const withTarget = (ui: PaneUi, target: DiffTarget): PaneUi => ({
  overrides: target.file === null ? ui.overrides : new Map(ui.overrides).set(target.file, false),
  anchor: target,
});

export const reducePaneUi = (ui: PaneUi, action: PaneUiAction): PaneUi => {
  switch (action.type) {
    case "fold":
      return { ...ui, overrides: new Map(ui.overrides).set(action.id, action.folded) };
    case "forget": {
      const overrides = new Map(ui.overrides);

      overrides.delete(action.id);

      return { ...ui, overrides };
    }

    case "collapse-all":
      return { ...ui, overrides: new Map(action.ids.map((id) => [id, true])) };
    case "show":
      return withTarget(ui, action.target);
    case "release":
      return ui.anchor === null ? ui : { ...ui, anchor: null };
  }
};
