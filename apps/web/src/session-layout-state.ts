// @effect-diagnostics missingPipeableSignature:off -- plain helpers that pick an atom of a family.

// The Session pages' layouts as atoms (`session-layout.ts` has the rules): kept on this device, in the runtime's
// key-value store, so a Session shows again as it was left, after another Session or a reload. Each atom is per
// layout key (`layoutKey`): a Session page's, or a Subagent page's, which has a layout of its own.

import * as Arr from "effect/Array";
import * as Atom from "effect/reactivity/Atom";
import { pageAtom } from "./router.ts";
import { appRuntime } from "./runtime.ts";
import {
  disclosureKey,
  layoutKey,
  layoutOf,
  StoredLayouts,
  withLayout,
  withOpen,
  withShown,
  type TranscriptDisclosure,
  type SessionLayout,
} from "./session-layout.ts";
import type { TreeFilter } from "./session/tree.ts";

/** Every layout this device keeps, the page shown last first. */
const storedLayoutsAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:session-layouts",
  schema: StoredLayouts,
  defaultValue: (): StoredLayouts => [],
}).pipe(Atom.keepAlive);

/** The layout key of the page shown (`layoutKey`): a Session page's or a Subagent page's; undefined on any other page. */
export const shownLayoutKeyAtom = Atom.map(pageAtom, (page): string | undefined => {
  switch (page.kind) {
    case "session":
      return layoutKey(page.sessionId);
    case "subagent":
      return layoutKey(page.sessionId, page.agentId);
    default:
      return undefined;
  }
});

/**
 * The layout kept under `key` (`layoutKey`). Writing some of its fields keeps them, the others as they were, on this
 * device, with the page first as the one shown last.
 */
export const sessionLayoutAtom = Atom.family((key: string) =>
  Atom.writable(
    (get): SessionLayout => layoutOf(get(storedLayoutsAtom), key),
    (ctx, change: Partial<SessionLayout>) => {
      const stored = ctx.get(storedLayoutsAtom);

      ctx.set(storedLayoutsAtom, withLayout(stored, key, { ...layoutOf(stored, key), ...change }));
    },
  ),
);

/**
 * Puts the layout under `key` first among the layouts kept, as the one shown last, so a page the owner reads but changes
 * nothing on is kept as long as one they change. Mounted by the Session's page and each Subagent page.
 */
export const showLayoutAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const stored = get.once(storedLayoutsAtom);
    const shown = withShown(stored, key);

    if (shown !== stored) get.set(storedLayoutsAtom, shown);
  }),
);

/** A list of things open in a layout, kept by `withOpen`. */
type OpenList = "openCards" | "openDisclosures";

/**
 * Per layout key, then per thing in `list`: whether it is open in that layout; writing it opens or closes it there.
 */
const openFamily = <List extends OpenList>(list: List) =>
  Atom.family((key: string) => {
    const layout = sessionLayoutAtom(key);

    return Atom.family((id: SessionLayout[List][number]) =>
      Atom.writable(
        (get) => Arr.some(get(layout)[list], (known: string | number) => known === id),
        (ctx, open: boolean) => {
          const ids: readonly (string | number)[] = ctx.get(layout)[list];

          ctx.set(layout, { [list]: withOpen(ids, id, open) });
        },
      ),
    );
  });

const subagentCards = openFamily("openCards");
const disclosures = openFamily("openDisclosures");

/** Whether a subagent's card is open into its conversation in the transcript of the page with layout key `key`. */
export const subagentCardOpenAtom = (key: string, conversationId: number) =>
  subagentCards(key)(conversationId);

/**
 * Whether a disclosure of the transcript of the page whose layout key is `key` (or of a subagent's conversation in it)
 * is open.
 */
export const disclosureOpenAtom = (key: string, disclosure: TranscriptDisclosure) =>
  disclosures(key)(disclosureKey(disclosure));

/** Whether the Session details are open on the page whose layout key is `key`; writing it opens or closes them there. */
export const detailsOpenAtom = Atom.family((key: string) => {
  const layout = sessionLayoutAtom(key);

  return Atom.writable(
    (get): boolean => get(layout).detailsOpen,
    (ctx, detailsOpen: boolean) => {
      ctx.set(layout, { detailsOpen });
    },
  );
});

/** The filter the tree Pane of the page whose layout key is `key` shows with; writing it keeps the new one there. */
export const treeFilterAtom = Atom.family((key: string) => {
  const layout = sessionLayoutAtom(key);

  return Atom.writable(
    (get): TreeFilter => get(layout).treeFilter,
    (ctx, treeFilter: TreeFilter) => {
      ctx.set(layout, { treeFilter });
    },
  );
});
