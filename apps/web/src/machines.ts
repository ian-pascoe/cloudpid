// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over native arrays, not combinators.

import {
  MAX_MACHINE_NAME_LENGTH,
  parseRepoSource,
  type SessionRecord,
  MachineSlug,
} from "@cloudpid/protocol";
import {
  DEFAULT_MACHINE_SETTINGS,
  ignorePatternProblem,
  INSTANCE_DESCRIPTIONS,
  type InstanceType,
  MAX_IDLE_MINUTES,
  MAX_IGNORE_PATTERNS,
} from "@cloudpid/config";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** A Machine's Sessions, newest first. */
export type MachineGroup = {
  /** The Machine's slug. */
  readonly machine: string;
  /** The Machine's name, or its slug when it is not known. */
  readonly name: string;
  readonly sessions: readonly SessionRecord[];
  /** Whether any of them is running, so a collapsed group still shows it. */
  readonly running: boolean;
};

/**
 * `sessions` (newest first) grouped by the Machine they work on: the Machine of the newest Session first, the
 * Sessions of each in the order given. `names` maps a slug to the Machine's name.
 */
export const groupByMachine = (
  sessions: readonly SessionRecord[],
  names: Readonly<Record<string, string>> = {},
): readonly MachineGroup[] => {
  const groups = new Map<string, SessionRecord[]>();

  for (const session of sessions) {
    const group = groups.get(session.machine);

    if (group === undefined) groups.set(session.machine, [session]);
    else group.push(session);
  }

  return [...groups].map(([machine, grouped]) => ({
    machine,
    name: names[machine] ?? machine,
    sessions: grouped,
    running: grouped.some((session) => session.status === "running"),
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
 * Why `text` cannot be a Machine's name, or null when it can: trimmed, not empty, at most 80 characters, and no name
 * in `others` (the other Machines') whatever the case. The server checks the same.
 */
export const machineNameProblem = (text: string, others: readonly string[]): string | null => {
  const name = text.trim();

  if (name === "") return "Give the machine a name";

  if (name.length > MAX_MACHINE_NAME_LENGTH)
    return `Use at most ${MAX_MACHINE_NAME_LENGTH} characters`;

  const lower = name.toLowerCase();

  return others.some((other) => other.toLowerCase() === lower)
    ? "Another machine is already named that"
    : null;
};

/** Whether the owner typed the Machine's slug to confirm deleting it. */
export const deleteConfirmed = (slug: string, typed: string): boolean => typed.trim() === slug;

const isSlug = Schema.is(MachineSlug);

/** Why `text` cannot be a Machine slug, or null when it can. */
export const slugProblem = (text: string): string | null =>
  isSlug(text)
    ? null
    : "Use lowercase letters, digits and dashes, starting with a letter or digit (up to 63)";

/** Why `text` cannot be cloned, or null when it can: the same rules as the server's, so a mistake shows as it is typed. */
export const sourceProblem = (text: string): string | null => {
  const parsed = parseRepoSource(text);

  return Result.isFailure(parsed) ? parsed.failure : null;
};

/** An instance type's line in the Edit dialog's size list: its name and what it offers, the default marked as such. */
export const instanceLabel = (type: InstanceType): string =>
  `${type}: ${INSTANCE_DESCRIPTIONS[type]}${type === DEFAULT_MACHINE_SETTINGS.instance ? " (default)" : ""}`;

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

/** The extra Container-only paths typed in the Edit dialog: one per line, blank lines left out. */
export const ignorePatternsFrom = (text: string): readonly string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * Why `text` cannot be a Machine's extra Container-only paths, or null when it can: the server's rules
 * (`ignorePatternProblem`), with the first pattern that breaks them.
 */
export const ignoreProblem = (text: string): string | null => {
  const patterns = ignorePatternsFrom(text);

  if (patterns.length > MAX_IGNORE_PATTERNS) return `Use at most ${MAX_IGNORE_PATTERNS} paths`;

  for (const pattern of patterns) {
    const problem = ignorePatternProblem(pattern);

    if (problem !== undefined) return `${pattern} ${problem}`;
  }

  return null;
};
