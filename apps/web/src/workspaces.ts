// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import {
  MAX_WORKSPACE_NAME_LENGTH,
  parseRepoSource,
  type SessionRecord,
  WorkspaceSlug,
} from "@cloudpid/protocol";
import { MAX_IDLE_MINUTES } from "@cloudpid/config";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** A Workspace's Sessions, newest first. */
export type WorkspaceGroup = {
  /** The Workspace's slug. */
  readonly workspace: string;
  /** The Workspace's name, or its slug when it is not known. */
  readonly name: string;
  readonly sessions: readonly SessionRecord[];
};

/**
 * `sessions` (newest first) grouped by the Workspace they work on: the Workspace of the newest Session first, the
 * Sessions of each in the order given. `names` maps a slug to the Workspace's name.
 */
export const groupByWorkspace = (
  sessions: readonly SessionRecord[],
  names: Readonly<Record<string, string>> = {},
): readonly WorkspaceGroup[] => {
  const groups = new Map<string, SessionRecord[]>();

  for (const session of sessions) {
    const group = groups.get(session.workspace);

    if (group === undefined) groups.set(session.workspace, [session]);
    else group.push(session);
  }

  return [...groups].map(([workspace, grouped]) => ({
    workspace,
    name: names[workspace] ?? workspace,
    sessions: grouped,
  }));
};

/** Sessions split into the ones the Session list shows and the archived ones. */
export type SplitSessions = {
  readonly active: readonly SessionRecord[];
  readonly archived: readonly SessionRecord[];
};

/** `sessions` split into the ones the Session list shows and the archived ones, each in the order given. */
export const splitArchived = (sessions: readonly SessionRecord[]): SplitSessions => ({
  active: sessions.filter((session) => session.archivedAt === null),
  archived: sessions.filter((session) => session.archivedAt !== null),
});

/**
 * Why `text` cannot be a Workspace's name, or null when it can: trimmed, not empty, at most 80 characters, and no name
 * in `others` (the other Workspaces') whatever the case. The server checks the same.
 */
export const workspaceNameProblem = (text: string, others: readonly string[]): string | null => {
  const name = text.trim();

  if (name === "") return "Give the workspace a name";

  if (name.length > MAX_WORKSPACE_NAME_LENGTH)
    return `Use at most ${MAX_WORKSPACE_NAME_LENGTH} characters`;

  const lower = name.toLowerCase();

  return others.some((other) => other.toLowerCase() === lower)
    ? "Another workspace is already named that"
    : null;
};

/** Whether the owner typed the Workspace's slug to confirm deleting it. */
export const deleteConfirmed = (slug: string, typed: string): boolean => typed.trim() === slug;

const isSlug = Schema.is(WorkspaceSlug);

/** Why `text` cannot be a Workspace slug, or null when it can. */
export const slugProblem = (text: string): string | null =>
  isSlug(text)
    ? null
    : "Use lowercase letters, digits and dashes, starting with a letter or digit (up to 63)";

/** Why `text` cannot be cloned, or null when it can: the same rules as the server's, so a mistake shows as it is typed. */
export const sourceProblem = (text: string): string | null => {
  const parsed = parseRepoSource(text);

  return Result.isFailure(parsed) ? parsed.failure : null;
};

/** Why `text` cannot be an idle time, or null when it can: a whole number of minutes, from 1 to a day. */
export const idleMinutesProblem = (text: string): string | null => {
  const minutes = Number(text);

  return text.trim() !== "" &&
    Number.isInteger(minutes) &&
    minutes >= 1 &&
    minutes <= MAX_IDLE_MINUTES
    ? null
    : `Use a whole number of minutes from 1 to ${MAX_IDLE_MINUTES}`;
};
