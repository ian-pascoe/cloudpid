// @effect-diagnostics missingPipeableSignature:off -- plain string functions.
// Canonical agent IDs (`docs/spec.md` → Subagents), as pi-minimal-subagents writes them: the root agent is `root`, a
// root child's ID is its own segment (`agent-1`), and a nested child's ID is its parent's ID, a dot, and its segment
// (`agent-1.reviewer`). A leading `root.` is accepted and dropped, so `root.agent-1` names `agent-1`.

/** The root agent: the Session's root conversation. */
export const ROOT_AGENT = "root";

/** One segment of a canonical ID: what `subagent`'s `agent_id` names. */
export const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** A canonical ID, with or without the `root.` prefix. */
export const CANONICAL =
  /^(?:root\.)?[A-Za-z0-9][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,63})*$/;

/** `id` without a leading `root.`. */
export const normalizeAgentId = (id: string): string =>
  id.startsWith(`${ROOT_AGENT}.`) ? id.slice(ROOT_AGENT.length + 1) : id;

/** The ID of `parent`'s child named `segment`. */
export const childAgentId = (parent: string, segment: string): string =>
  parent === ROOT_AGENT ? segment : `${parent}.${segment}`;

/** The ID of `id`'s parent; the root has none. */
export const parentAgentId = (id: string): string | undefined => {
  if (id === ROOT_AGENT) return undefined;

  const dot = id.lastIndexOf(".");

  return dot === -1 ? ROOT_AGENT : id.slice(0, dot);
};

/** How many levels below the root `id` is: the root is 0, its children 1. */
export const agentDepth = (id: string): number => (id === ROOT_AGENT ? 0 : id.split(".").length);

/** Whether `id` is `ancestor` or below it. */
export const isWithin = (id: string, ancestor: string): boolean =>
  ancestor === ROOT_AGENT || id === ancestor || id.startsWith(`${ancestor}.`);
