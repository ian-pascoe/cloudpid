// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over native arrays, not combinators.

// The Environments page's and the Session list's pure parts: the list grouped by Environment, the checks of what the
// owner types (names, Repos, branches, Container settings, Secrets) by the server's own rules, and the lines the page
// shows of a Build and a Secret.

import {
  type AgentChange,
  type BuildView,
  branchProblem,
  BUILD_FIELD,
  CREATED_FIELD,
  EVERY_ENVIRONMENT_SCOPE,
  type EnvironmentSecretRecord,
  fieldRepo,
  fieldSecret,
  fieldVariable,
  NAME_FIELD,
  MAX_ENVIRONMENT_NAME_LENGTH,
  MAX_REPO_NAME_LENGTH,
  parseRepoSource,
  unrevertableField,
  REPO_NAME,
  secretNameProblem,
  secretValueProblem,
  type SessionRecord,
} from "@cloudpid/protocol";
import {
  DEFAULT_CONTAINER_SETTINGS,
  ignorePatternProblem,
  INSTANCE_DESCRIPTIONS,
  type InstanceType,
  MAX_IDLE_MINUTES,
  MAX_IGNORE_PATTERNS,
  MAX_VARIABLE_VALUE_LENGTH,
  MAX_VARIABLES,
  scriptProblem,
  toolchainsProblem,
  variableNameProblem,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { relativeTime } from "./format.ts";

/** An Environment's Sessions, newest first. */
export type EnvironmentGroup = {
  /** The Environment's id. */
  readonly environment: string;
  /** The Environment's name, or its id when it is not known. */
  readonly name: string;
  readonly sessions: readonly SessionRecord[];
  /** Whether any of them is running, so a collapsed group still shows it. */
  readonly running: boolean;
};

/**
 * `sessions` (newest first) grouped by the Environment they were made in: the Environment of the newest Session first,
 * the Sessions of each in the order given. `names` maps an id to the Environment's name.
 */
export const groupByEnvironment = (
  sessions: readonly SessionRecord[],
  names: Readonly<Record<string, string>> = {},
): readonly EnvironmentGroup[] => {
  const groups = new Map<string, SessionRecord[]>();

  for (const session of sessions) {
    const group = groups.get(session.environment);

    if (group === undefined) groups.set(session.environment, [session]);
    else group.push(session);
  }

  return [...groups].map(([environment, grouped]) => ({
    environment,
    name: names[environment] ?? environment,
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
 * Why `text` cannot be an Environment's name, or null when it can: trimmed, not empty, at most 80 characters, and no
 * name in `others` (the other Environments') whatever the case. The server checks the same.
 */
export const environmentNameProblem = (text: string, others: readonly string[]): string | null => {
  const name = text.trim();

  if (name === "") return "Give the environment a name";

  if (name.length > MAX_ENVIRONMENT_NAME_LENGTH)
    return `Use at most ${MAX_ENVIRONMENT_NAME_LENGTH} characters`;

  const lower = name.toLowerCase();

  return others.some((other) => other.toLowerCase() === lower)
    ? "Another environment is already named that"
    : null;
};

/** Whether the owner typed `expected` (an Environment's name, a branch) to confirm a removal. */
export const deleteConfirmed = (expected: string, typed: string): boolean =>
  typed.trim() === expected;

/**
 * Why `text` cannot be a branch the owner may leave empty (the draft's base and branch name), or null when it can: empty
 * means the default, and anything else follows the server's rules (`branchProblem`, or `ownBranchProblem` for the
 * branch the new Workspace is on).
 */
export const optionalBranchProblem = (
  text: string,
  problem: (name: string) => string | undefined = branchProblem,
): string | null => {
  const name = text.trim();

  return name === "" ? null : (problem(name) ?? null);
};

/** Why `text` cannot be added as a Repo, or null when it can: the same rules as the server's, so a mistake shows as it is typed. */
export const sourceProblem = (text: string): string | null => {
  const parsed = parseRepoSource(text);

  return Result.isFailure(parsed) ? parsed.failure : null;
};

/**
 * Why `text` cannot be the directory a Repo is cloned into, or null when it can: empty for the repo's own name, else
 * trimmed, the server's rules (`RepoName`): letters, digits, dots, underscores and dashes, starting with a letter or
 * digit, at most 100 characters.
 */
export const repoNameProblem = (text: string): string | null => {
  const name = text.trim();

  if (name === "") return null;

  if (name.length > MAX_REPO_NAME_LENGTH) return `Use at most ${MAX_REPO_NAME_LENGTH} characters`;

  return REPO_NAME.test(name)
    ? null
    : "Use letters, digits, dots, underscores and dashes, starting with a letter or digit";
};

/** `type`'s line in a list of sizes: its name and what it offers, marked when it is `byDefault`. */
const sizeLine = (type: InstanceType, byDefault: InstanceType): string =>
  `${type}: ${INSTANCE_DESCRIPTIONS[type]}${type === byDefault ? " (default)" : ""}`;

/** An instance type's line in the Edit dialog's size list: its name and what it offers, the default marked as such. */
export const instanceLabel = (type: InstanceType): string =>
  sizeLine(type, DEFAULT_CONTAINER_SETTINGS.instance);

/** An instance type's line in the Edit dialog's size limit list, the default limit marked as such. */
export const sizeLimitLabel = (type: InstanceType): string =>
  sizeLine(type, DEFAULT_CONTAINER_SETTINGS.maxInstance);

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
 * Why `text` cannot be an Environment's extra Container-only paths, or null when it can: the server's rules
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

/** An Environment's variables as the Edit dialog shows them: a `NAME=value` line each. */
export const variablesText = (variables: Readonly<Record<string, string>>): string =>
  Record.toEntries(variables)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");

/**
 * The variables typed in the Edit dialog, or why they cannot be saved: a `NAME=value` line each, the value everything
 * after the first `=` as typed, blank lines and lines starting with `#` left out. The server's rules
 * (`variableNameProblem`), with the first line that breaks them.
 */
export const parseVariables = (text: string): Result.Result<Record<string, string>, string> => {
  // A Map, so a name like `__proto__` is a variable like any other.
  const variables = new Map<string, string>();
  const lines = text.split("\n");

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const equals = line.indexOf("=");

    if (equals === -1) return Result.fail(`Line ${index + 1}: write NAME=value`);

    const name = line.slice(0, equals).trim();
    const value = line.slice(equals + 1);
    const problem = variableNameProblem(name);

    if (problem !== undefined)
      return Result.fail(`${name === "" ? `Line ${index + 1}: the name` : name} ${problem}`);

    if (variables.has(name)) return Result.fail(`${name} is set twice`);

    if (value.length > MAX_VARIABLE_VALUE_LENGTH) {
      return Result.fail(`${name}'s value is longer than ${MAX_VARIABLE_VALUE_LENGTH} characters`);
    }

    variables.set(name, value);
  }

  return variables.size > MAX_VARIABLES
    ? Result.fail(`Use at most ${MAX_VARIABLES} variables`)
    : Result.succeed(Record.fromEntries(variables));
};

/** Why `text` cannot be an Environment's Setup or Start Script, or null when it can: the server's rules (`scriptProblem`). */
export const scriptFieldProblem = (text: string): string | null => {
  const problem = scriptProblem(text);

  return problem === undefined ? null : `The script ${problem}`;
};

/** Why `text` cannot be an Environment's Toolchains (a mise.toml), or null when it can: the server's rules (`toolchainsProblem`). */
export const toolchainsFieldProblem = (text: string): string | null => {
  const problem = toolchainsProblem(text);

  return problem === undefined ? null : `The mise.toml ${problem}`;
};

/**
 * The line an Environment's card shows of its Build (docs/spec.md → Builds), as of `now`: whether new Workspaces start
 * from one, and when it was made; one under way or failed says what new Workspaces start from meanwhile.
 */
export const buildLine = (build: BuildView, now: number): string => {
  const meanwhile = (lastGoodAt: number | null) =>
    lastGoodAt === null
      ? "new workspaces start from the image"
      : `new workspaces start from the build of ${relativeTime(lastGoodAt, now)}`;

  switch (build.status) {
    case "none":
      return "No build: new workspaces start from the image";
    case "ready":
      return `Built ${relativeTime(build.at, now)}`;
    case "building":
      return `Building since ${relativeTime(build.since, now)}; ${meanwhile(build.lastGoodAt)}`;
    case "failed":
      return `Build failed ${relativeTime(build.at, now)}: ${build.reason}. Meanwhile ${meanwhile(build.lastGoodAt)}`;
  }
};

/**
 * A value an Agent change shows, in full: a variable's, a script's or the Toolchains' as written, a list of paths a line
 * each, another setting's as JSON, and none as not set (an empty text as empty, an empty list as none).
 */
export const changeValueText = (value: AgentChange["before"]): string => {
  if (value === null) return "not set";

  if (Predicate.isString(value)) return value === "" ? "empty" : value;

  if (Arr.isArray(value) && Arr.every(value, Predicate.isString)) {
    return value.length === 0 ? "none" : value.join("\n");
  }

  return JSON.stringify(value);
};

/** The setting an Agent change's field names, as the page says it: `variables.API_URL` is the variable API_URL. */
export const changeFieldText = (field: string): string => {
  const variable = fieldVariable(field);

  if (variable !== null) return `Variable ${variable}`;

  const repo = fieldRepo(field);

  if (repo !== null) return `Repo ${repo}`;

  const secret = fieldSecret(field);

  if (secret !== null) {
    return secret.kind === "kept"
      ? `Secret ${secret.name}`
      : `Secret ${secret.name}, for the Build`;
  }

  switch (field) {
    case NAME_FIELD:
      return "Name";
    case CREATED_FIELD:
      return "Creation";
    case BUILD_FIELD:
      return "Build";
    default:
      return field;
  }
};

/**
 * Who made an Agent change and when, as of `now`: the agent, with its tool (the page links the Session after it), or
 * the owner, reverting an earlier one.
 */
export const changeByline = (change: AgentChange, now: number): string => {
  const when = relativeTime(change.at, now);

  if (change.actor === "owner") {
    return change.reverts === null
      ? `You, ${when}`
      : `You reverted change ${change.reverts}, ${when}`;
  }

  return `The agent, ${when}${change.tool === null ? "" : `, with ${change.tool}`}`;
};

/**
 * Whether the owner can revert an Agent change: the agent's, not reverted yet, and not the making of an Environment or
 * a Build asked for, which have no revert. The Registry decides the rest.
 */
export const revertible = (change: AgentChange): boolean =>
  change.actor === "agent" && change.revertedBy === null && !unrevertableField(change.field);

/**
 * The key of the Secrets kept for every Environment among the page's Secrets sections, which an Environment's id is
 * not (ids are hexadecimal, or `default`).
 */
export const EVERY_ENVIRONMENT = EVERY_ENVIRONMENT_SCOPE;

/** The scope the Registry takes for Secrets section `key`: the Environment's id, or null for every Environment. */
export const secretScopeOf = (key: string): string | null =>
  key === EVERY_ENVIRONMENT ? null : key;

/** The Secrets of `records` kept in section `key` (an Environment's id, or `EVERY_ENVIRONMENT`), by name. */
export const secretsIn = (
  records: readonly EnvironmentSecretRecord[],
  key: string,
): readonly EnvironmentSecretRecord[] =>
  records
    .filter((record) => (record.environment ?? EVERY_ENVIRONMENT) === key)
    .toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

/**
 * The Secrets kept for every Environment that Environment `environment` gets, by name: those it keeps none of the same
 * name of, since its own wins.
 */
export const inheritedSecrets = (
  records: readonly EnvironmentSecretRecord[],
  environment: string,
): readonly EnvironmentSecretRecord[] => {
  const own = new Set(secretsIn(records, environment).map((record) => record.name));

  return secretsIn(records, EVERY_ENVIRONMENT).filter((record) => !own.has(record.name));
};

/** What is typed in a Secrets section's form: a name, a value, and whether a new Secret reaches the Build. */
export interface SecretDraft {
  readonly name: string;
  readonly value: string;
  readonly build: boolean;
}

/** A Secrets section's form with nothing typed. */
export const EMPTY_SECRET_DRAFT: SecretDraft = { name: "", value: "", build: false };

/** What is wrong with each field of a Secrets section's form; null where nothing is. */
export interface SecretDraftProblems {
  readonly name: string | null;
  readonly value: string | null;
}

/**
 * Why the form's name and value cannot be saved, each null when it can or nothing is typed in it yet: the server's
 * rules, so a mistake shows as it is typed. A value's problem never quotes it.
 */
export const secretDraftProblems = (draft: SecretDraft): SecretDraftProblems => ({
  name: draft.name === "" ? null : (secretNameProblem(draft.name) ?? null),
  value: draft.value === "" ? null : (secretValueProblem(draft.value) ?? null),
});

/** Whether the form can be saved: a name and a value, neither with a problem. */
export const secretDraftReady = (draft: SecretDraft): boolean => {
  const problems = secretDraftProblems(draft);

  return (
    draft.name !== "" && draft.value !== "" && problems.name === null && problems.value === null
  );
};

/**
 * What the Registry is asked to keep from the form, given the Secrets the section keeps: a new one with the form's
 * build flag; the value of one kept under that name replaced, its flag left as it is (it has a switch of its own).
 */
export const secretWrite = (
  draft: SecretDraft,
  kept: readonly EnvironmentSecretRecord[],
): { readonly name: string; readonly value: string; readonly build?: boolean } =>
  kept.some((record) => record.name === draft.name)
    ? { name: draft.name, value: draft.value }
    : { name: draft.name, value: draft.value, build: draft.build };

/** The variable a Build's scripts and a Session's commands get Secret `name` as. */
export const secretVariable = (name: string): string => `PI_SECRET_${name}`;
