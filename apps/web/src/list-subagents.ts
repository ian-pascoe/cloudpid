// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a Session's few subagents over native arrays, and plain helpers.

// A Session's subagents in the Session list (ADR-0024): the tree its record lists them in (`SessionRecord.agents`,
// parents before their children), and whether that tree is shown under the Session's row. It is collapsed by default
// and kept expanded per device by the owner; it also expands while the page shown is the Session's, until the owner
// collapses it there, and always while one of its Subagent pages is shown, so the row of the page is in view.

import type { SessionAgent } from "@cloudpid/protocol";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { agentIdAtom, sessionIdAtom } from "./router.ts";
import { appRuntime } from "./runtime.ts";
import { ROOT_AGENT } from "./session/agents.ts";

/** A subagent's row in the Session list: the agent, and how deep it is below the root (0 for a child of the root). */
export interface SubagentRow {
  readonly agent: SessionAgent;
  readonly depth: number;
}

/**
 * The rows of a Session's subagents, each under its parent, the root's children first; siblings keep the record's order.
 * A subagent whose parent the record does not list (it may have been deleted) is shown at the top level, so none is
 * lost.
 */
export const subagentRows = (
  agents: readonly SessionAgent[] | undefined,
): readonly SubagentRow[] => {
  if (agents === undefined || agents.length === 0) return [];

  const ids = new Set(agents.map((agent) => agent.id));
  const children = new Map<string, SessionAgent[]>();

  for (const agent of agents) {
    const parent = agent.parent !== agent.id && ids.has(agent.parent) ? agent.parent : ROOT_AGENT;
    const siblings = children.get(parent) ?? [];

    siblings.push(agent);
    children.set(parent, siblings);
  }

  const rows: SubagentRow[] = [];
  const placed = new Set<string>();

  const place = (parent: string, depth: number): void => {
    for (const agent of children.get(parent) ?? []) {
      // A cycle in a malformed record shows each agent once.
      if (placed.has(agent.id)) continue;

      placed.add(agent.id);
      rows.push({ agent, depth });
      place(agent.id, depth + 1);
    }
  };

  place(ROOT_AGENT, 0);

  // What a cycle kept away from the root still shows, at the top level.
  for (const agent of agents) {
    if (placed.has(agent.id)) continue;

    placed.add(agent.id);
    rows.push({ agent, depth: 0 });
    place(agent.id, 1);
  }

  return rows;
};

/**
 * The most steps a row is indented below its Session (`indentOf`): two, so a deep tree still fits the list at its
 * narrowest (224 px).
 */
export const MAX_INDENT = 2;

/** How many steps a row at `depth` is indented below its Session: one per level, up to `MAX_INDENT`. */
export const indentOf = (depth: number): number => Math.min(Math.max(depth, 0), MAX_INDENT);

/** How many Sessions' expanded trees this device keeps: the last expanded. */
export const MAX_EXPANDED = 200;

/** The Sessions whose subagents the owner expanded on this device (in the runtime's key-value store), oldest first. */
const expandedSessionsAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:expanded-subagents",
  schema: Schema.Array(Schema.String),
  defaultValue: (): readonly string[] => [],
}).pipe(Atom.keepAlive);

/**
 * The Session shown whose tree the owner collapsed on its page: it stays collapsed there until another Session (or
 * none) is shown (`forgetDismissedAtom`), and reveals again the next time.
 */
const dismissedRevealAtom = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

/** Which of a Session's pages is shown, if one is: its own, or one of its Subagent pages. */
export type ShownSessionPage = "session" | "subagent" | undefined;

/**
 * Whether a Session's subagents show under its row: expanded by the owner on this device, or revealed because the page
 * shown is one of the Session's: on its own page unless the owner collapsed it there, and always on a Subagent page.
 */
export const subagentsExpanded = (state: {
  readonly kept: boolean;
  readonly shown: ShownSessionPage;
  readonly dismissed: boolean;
}): boolean =>
  state.kept || state.shown === "subagent" || (state.shown === "session" && !state.dismissed);

/** Which of Session `sessionId`'s pages is shown, if one is. */
const shownPageOf = (sessionId: string, get: <A>(atom: Atom.Atom<A>) => A): ShownSessionPage => {
  if (get(sessionIdAtom) !== sessionId) return undefined;

  return get(agentIdAtom) === undefined ? "session" : "subagent";
};

/**
 * Whether the subagents of Session `sessionId` show under its row in the list; writing it expands or collapses them,
 * kept on this device.
 */
export const subagentsExpandedAtom = Atom.family((sessionId: string) =>
  Atom.writable(
    (get): boolean =>
      subagentsExpanded({
        kept: get(expandedSessionsAtom).includes(sessionId),
        shown: shownPageOf(sessionId, get),
        dismissed: get(dismissedRevealAtom) === sessionId,
      }),
    (ctx, expanded: boolean) => {
      const others = ctx.get(expandedSessionsAtom).filter((known) => known !== sessionId);

      ctx.set(
        expandedSessionsAtom,
        expanded ? [...others, sessionId].slice(-MAX_EXPANDED) : others,
      );

      // Collapsed on its page, it stays so there until another Session is shown; expanded, nothing is dismissed.
      if (!expanded && shownPageOf(sessionId, (atom) => ctx.get(atom)) === "session") {
        ctx.set(dismissedRevealAtom, sessionId);
      } else if (expanded && ctx.get(dismissedRevealAtom) === sessionId) {
        ctx.set(dismissedRevealAtom, undefined);
      }
    },
  ),
);

/**
 * Forgets a collapse of the tree of the Session shown once another Session (or none) is shown, so it reveals again when
 * it is shown next. Moving between a Session's page and its Subagent pages is the same Session. Mounted for as long as
 * the app runs.
 */
export const forgetDismissedAtom = Atom.make((get) => {
  get.subscribe(
    sessionIdAtom,
    (sessionId) => {
      const dismissed = get.once(dismissedRevealAtom);

      if (dismissed !== undefined && dismissed !== sessionId)
        get.set(dismissedRevealAtom, undefined);
    },
    { immediate: true },
  );
});
