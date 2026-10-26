// @effect-diagnostics missingPipeableSignature:off -- plain helpers that pick an atom of a family.

// The Session pages' layouts as atoms (`session-layout.ts` has the rules): kept on this device, in the runtime's
// key-value store, so a Session shows again as it was left, after another Session or a reload.

import * as Atom from "effect/reactivity/Atom";
import { appRuntime } from "./runtime.ts";
import {
  layoutOf,
  StoredLayouts,
  withLayout,
  withOpen,
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
 * Session `sessionId`'s layout. Writing one keeps it on this device, with the Session first as the one shown last.
 */
export const sessionLayoutAtom = Atom.family((sessionId: string) =>
  Atom.writable(
    (get): SessionLayout => layoutOf(get(storedLayoutsAtom), sessionId),
    (ctx, layout: SessionLayout) => {
      ctx.set(storedLayoutsAtom, withLayout(ctx.get(storedLayoutsAtom), sessionId, layout));
    },
  ),
);

/** Which list of open subagents in a layout: the Subagents Pane's rows, or the transcript's cards. */
type OpenList = "openAgents" | "openCards";

/**
 * Per Session, then per subagent conversation: whether the subagent is open in `list` of the Session's layout; writing
 * it opens or closes it there.
 */
const openSubagentFamily = (list: OpenList) =>
  Atom.family((sessionId: string) => {
    const layout = sessionLayoutAtom(sessionId);

    return Atom.family((conversationId: number) =>
      Atom.writable(
        (get) => get(layout)[list].includes(conversationId),
        (ctx, open: boolean) => {
          const current = ctx.get(layout);

          ctx.set(layout, { ...current, [list]: withOpen(current[list], conversationId, open) });
        },
      ),
    );
  });

const agentRows = openSubagentFamily("openAgents");
const subagentCards = openSubagentFamily("openCards");

/** Whether a subagent's row is open into its thread in Session `sessionId`'s Subagents Pane. */
export const agentRowOpenAtom = (sessionId: string, conversationId: number) =>
  agentRows(sessionId)(conversationId);

/** Whether a subagent's card is open into its thread in Session `sessionId`'s transcript. */
export const subagentCardOpenAtom = (sessionId: string, conversationId: number) =>
  subagentCards(sessionId)(conversationId);

/** The filter Session `sessionId`'s tree Pane shows with; writing it keeps the new one in the layout. */
export const treeFilterAtom = Atom.family((sessionId: string) => {
  const layout = sessionLayoutAtom(sessionId);

  return Atom.writable(
    (get): TreeFilter => get(layout).treeFilter,
    (ctx, treeFilter: TreeFilter) => {
      ctx.set(layout, { ...ctx.get(layout), treeFilter });
    },
  );
});

const WIDE_QUERY = "(min-width: 768px)";

/** Whether the screen is `md` or wider, where the Pane area is a column beside the chat (it covers it on a phone). */
export const mdScreenAtom = Atom.readable((get) => {
  if (!("window" in globalThis)) return true;

  const query = window.matchMedia(WIDE_QUERY);

  const changed = () => {
    get.setSelf(query.matches);
  };

  query.addEventListener("change", changed);
  get.addFinalizer(() => {
    query.removeEventListener("change", changed);
  });

  return query.matches;
});
