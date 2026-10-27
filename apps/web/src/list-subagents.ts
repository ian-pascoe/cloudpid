// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a Session's few subagents over native arrays, and plain helpers.

// A Session's subagents in the Session list (ADR-0024): the tree its record lists them in (`SessionRecord.agents`,
// parents before their children), and whether that tree is shown under the Session's row. It is collapsed by default
// and kept expanded per device by the owner; it also expands while the page shown is the Session's or one of its
// Subagent pages, until the owner collapses it there.

import type { SessionAgent, SessionRecord } from "@cloudpid/protocol";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { sessionIdAtom } from "./router.ts";
import { appRuntime } from "./runtime.ts";

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
    const parent = agent.parent !== agent.id && ids.has(agent.parent) ? agent.parent : "root";
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

  place("root", 0);

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
 * How many steps a row at `depth` is indented below its Session: one per level, but no more than two, so a deep tree
 * still fits the list at its narrowest (224 px).
 */
export const MAX_INDENT = 2;

export const indentOf = (depth: number): number => Math.min(Math.max(depth, 0), MAX_INDENT);

/** How many subagents of `session` are working. */
export const workingCount = (session: SessionRecord): number =>
  (session.agents ?? []).filter((agent) => agent.status === "working").length;

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
 * The Session shown whose tree the owner collapsed while it was shown: it stays collapsed until another Session is
 * shown (`forgetDismissedAtom`), then reveals again the next time.
 */
const dismissedRevealAtom = Atom.make<string | undefined>(undefined).pipe(Atom.keepAlive);

/**
 * Whether a Session's subagents show under its row: expanded by the owner on this device, or revealed because the page
 * shown is the Session's or one of its Subagent pages, unless the owner collapsed it there.
 */
export const subagentsExpanded = (state: {
  readonly kept: boolean;
  readonly shown: boolean;
  readonly dismissed: boolean;
}): boolean => state.kept || (state.shown && !state.dismissed);

/**
 * Whether the subagents of Session `sessionId` show under its row in the list; writing it expands or collapses them,
 * kept on this device.
 */
export const subagentsExpandedAtom = Atom.family((sessionId: string) =>
  Atom.writable(
    (get): boolean =>
      subagentsExpanded({
        kept: get(expandedSessionsAtom).includes(sessionId),
        shown: get(sessionIdAtom) === sessionId,
        dismissed: get(dismissedRevealAtom) === sessionId,
      }),
    (ctx, expanded: boolean) => {
      const others = ctx.get(expandedSessionsAtom).filter((known) => known !== sessionId);

      ctx.set(
        expandedSessionsAtom,
        expanded ? [...others, sessionId].slice(-MAX_EXPANDED) : others,
      );

      // Collapsed while shown, it stays so until another Session is shown; expanded, nothing is dismissed.
      const shown = ctx.get(sessionIdAtom) === sessionId;

      if (!expanded && shown) ctx.set(dismissedRevealAtom, sessionId);
      else if (ctx.get(dismissedRevealAtom) === sessionId) ctx.set(dismissedRevealAtom, undefined);
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
