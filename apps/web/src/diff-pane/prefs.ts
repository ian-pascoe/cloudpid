// The Diff pane's view preferences (`docs/spec.md` → Diffs and review → Diff pane): its layout (Auto, Split or Stacked)
// and whether long lines wrap, kept per device in `localStorage` as the Pane area's width is. They are not Settings.

import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { appRuntime } from "../runtime.ts";
import { diffStyleFor, type DiffStyle } from "../call-diff.ts";

/** How the Pane lays a diff out: by its width (`auto`, split from 720 px), or always split or stacked. */
export const DiffLayout = Schema.Literals(["auto", "split", "stacked"]);

export type DiffLayout = typeof DiffLayout.Type;

/** The layout on this device, Auto until the owner picks one. */
export const diffLayoutAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:diff-layout",
  schema: DiffLayout,
  defaultValue: (): DiffLayout => "auto",
}).pipe(Atom.keepAlive);

/** Whether long lines wrap on this device: on until the owner turns it off. */
export const diffWrapAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:diff-wrap",
  schema: Schema.Boolean,
  defaultValue: (): boolean => true,
}).pipe(Atom.keepAlive);

/** The library's diff style for `layout` in a Pane `width` px wide. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain function of two values.
export const diffStyleOf = (layout: DiffLayout, width: number): DiffStyle => {
  switch (layout) {
    case "split":
      return "split";
    case "stacked":
      return "unified";
    case "auto":
      return diffStyleFor(width);
  }
};
