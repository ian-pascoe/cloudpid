// @effect-diagnostics missingPipeableSignature:off -- plain helpers that pick an atom of a family.

// The Session pages' layouts as atoms (`session-layout.ts` has the rules): kept on this device, in the runtime's
// key-value store, so a Session shows again as it was left, after another Session or a reload.

import * as Arr from "effect/Array";
import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "./runtime.ts";
import {
  disclosureKey,
  layoutOf,
  StoredLayouts,
  withLayout,
  withOpen,
  withShown,
  type TranscriptDisclosure,
  type SessionLayout,
} from "./session-layout.ts";
import type { TreeFilter } from "./session/tree.ts";

/** Every layout this device keeps, the Session shown last first. */
const storedLayoutsAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:session-layouts",
  schema: StoredLayouts,
  defaultValue: (): StoredLayouts => [],
}).pipe(Atom.keepAlive);

/**
 * Session `sessionId`'s layout. Writing some of its fields keeps them, the others as they were, on this device, with
 * the Session first as the one shown last.
 */
export const sessionLayoutAtom = Atom.family((sessionId: string) =>
  Atom.writable(
    (get): SessionLayout => layoutOf(get(storedLayoutsAtom), sessionId),
    (ctx, change: Partial<SessionLayout>) => {
      const stored = ctx.get(storedLayoutsAtom);

      ctx.set(
        storedLayoutsAtom,
        withLayout(stored, sessionId, { ...layoutOf(stored, sessionId), ...change }),
      );
    },
  ),
);

/**
 * Puts Session `sessionId` first among the layouts kept, as the one shown last, so a Session the owner reads but changes
 * nothing on is kept as long as one they change. Mounted by the Session's page.
 */
export const showLayoutAtom = Atom.family((sessionId: string) =>
  Atom.make((get) => {
    const stored = get.once(storedLayoutsAtom);
    const shown = withShown(stored, sessionId);

    if (shown !== stored) get.set(storedLayoutsAtom, shown);
  }),
);

/** A list of things open in a layout, kept by `withOpen`. */
type OpenList = "openAgents" | "openCards" | "openDisclosures";

/**
 * Per Session, then per thing in `list`: whether it is open in the Session's layout; writing it opens or closes it
 * there.
 */
const openFamily = <List extends OpenList>(list: List) =>
  Atom.family((sessionId: string) => {
    const layout = sessionLayoutAtom(sessionId);

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

const agentRows = openFamily("openAgents");
const subagentCards = openFamily("openCards");
const disclosures = openFamily("openDisclosures");

/** Whether a subagent's row is open into its thread in Session `sessionId`'s Subagents Pane. */
export const agentRowOpenAtom = (sessionId: string, conversationId: number) =>
  agentRows(sessionId)(conversationId);

/** Whether a subagent's card is open into its thread in Session `sessionId`'s transcript. */
export const subagentCardOpenAtom = (sessionId: string, conversationId: number) =>
  subagentCards(sessionId)(conversationId);

/** Whether a disclosure of Session `sessionId`'s transcript (or a subagent's thread in it) is open. */
export const disclosureOpenAtom = (sessionId: string, disclosure: TranscriptDisclosure) =>
  disclosures(sessionId)(disclosureKey(disclosure));

/** Whether Session `sessionId`'s Session details are open; writing it opens or closes them, kept in the layout. */
export const detailsOpenAtom = Atom.family((sessionId: string) => {
  const layout = sessionLayoutAtom(sessionId);

  return Atom.writable(
    (get): boolean => get(layout).detailsOpen,
    (ctx, detailsOpen: boolean) => {
      ctx.set(layout, { detailsOpen });
    },
  );
});

/** The filter Session `sessionId`'s tree Pane shows with; writing it keeps the new one in the layout. */
export const treeFilterAtom = Atom.family((sessionId: string) => {
  const layout = sessionLayoutAtom(sessionId);

  return Atom.writable(
    (get): TreeFilter => get(layout).treeFilter,
    (ctx, treeFilter: TreeFilter) => {
      ctx.set(layout, { treeFilter });
    },
  );
});
