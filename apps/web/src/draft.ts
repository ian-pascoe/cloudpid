// @effect-diagnostics missingPipeableSignature:off -- plain helpers over the draft's fields, not combinators.

// The draft composer's pure parts: what is typed and chosen, whether it can be sent, and what `createSession` is told.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type * as Types from "effect/Types";
import {
  NEW_WORKSPACE,
  ownBranchProblem,
  type RepoBranches,
  type WorkspaceRecord,
} from "@cloudpid/protocol";
import { optionalBranchProblem } from "./environments.ts";
import type { SessionPlace } from "./sessions.ts";

/** What the draft composer holds. */
export interface DraftInput {
  /** The first message, as typed. */
  readonly text: string;
  /** The id of the Environment the Session is made in. */
  readonly environment: string;
  /** `NEW_WORKSPACE`, or the id of a Workspace of that Environment. */
  readonly workspace: string;
  /** For a new Workspace: the branch it works on, as typed; empty for `cloudpid/<id>`. */
  readonly branch: string;
  /** For a new Workspace: the branch it starts from, as typed; empty for each Repo's default branch. */
  readonly base: string;
}

/** The Workspace the draft will use: `workspace` when `workspaces` (those of the chosen Environment) has it, else a new one. */
export const effectiveWorkspace = (
  workspace: string,
  workspaces: readonly Pick<WorkspaceRecord, "id">[],
): string =>
  workspace !== NEW_WORKSPACE && Arr.some(workspaces, (known) => known.id === workspace)
    ? workspace
    : NEW_WORKSPACE;

/** Why the branch name field cannot be used, or null; only a new Workspace has one. */
export const draftBranchProblem = (input: DraftInput): string | null =>
  input.workspace === NEW_WORKSPACE ? optionalBranchProblem(input.branch, ownBranchProblem) : null;

/** Why the base branch field cannot be used, or null; only a new Workspace has one. */
export const draftBaseProblem = (input: DraftInput): string | null =>
  input.workspace === NEW_WORKSPACE ? optionalBranchProblem(input.base) : null;

/**
 * Whether the draft can be sent: it has a message (text, or Attachments when `attached`), and neither branch field is
 * wrong.
 */
export const draftSendable = (input: DraftInput, attached = false): boolean =>
  (input.text.trim() !== "" || attached) &&
  draftBranchProblem(input) === null &&
  draftBaseProblem(input) === null;

/** One row of the Start from menu: a branch of one or more of the Environment's Repos. */
export interface BaseChoice {
  readonly name: string;
  /** Which Repos it is the default branch of, when it is: "default" (of every one), "default in app". */
  readonly note: string | undefined;
  /**
   * The listed Repos that have no such branch: a Workspace made from it cannot clone them, since a Repo without the base
   * fails rather than starting from its default branch (`prepareWorkspaceScript`).
   */
  readonly missingFrom: readonly string[];
}

/** What the Start from menu lists: the branches that match what is typed, and the Repos whose branches it could not list. */
export interface BaseChoices {
  readonly choices: readonly BaseChoice[];
  readonly unlisted: readonly { readonly repo: string; readonly message: string }[];
}

/** What is known of one branch across the Repos: the Repos with it, those it is the default of, and its latest commit. */
interface Gathered {
  readonly repos: string[];
  readonly defaultOf: string[];
  latest: number;
}

/**
 * The Start from menu for `lists` (`draftBranches`' answer) and what is typed in the field: every branch of any listed
 * Repo whose name holds `query` (any case), each once, those every listed Repo has first, then most recently committed
 * to first in any Repo. A branch only some of several Repos have names the others (their clones could not start from
 * it), and the default branch says so.
 */
export const baseChoices = (lists: readonly RepoBranches[], query: string): BaseChoices => {
  const wanted = query.trim().toLowerCase();
  const gathered = new Map<string, Gathered>();
  const unlisted: { repo: string; message: string }[] = [];
  const listed: string[] = [];

  for (const list of lists) {
    if (list.status === "error") {
      unlisted.push({ repo: list.repo, message: list.message });

      continue;
    }

    listed.push(list.repo);

    for (const branch of list.branches) {
      const known = gathered.get(branch.name) ?? { repos: [], defaultOf: [], latest: -Infinity };

      known.repos.push(list.repo);

      if (branch.name === list.defaultBranch) known.defaultOf.push(list.repo);

      known.latest = Math.max(known.latest, branch.committedAt ?? -Infinity);
      gathered.set(branch.name, known);
    }
  }

  const noteOf = (known: Gathered): string | undefined =>
    known.defaultOf.length === 0
      ? undefined
      : known.defaultOf.length === listed.length
        ? "default"
        : `default in ${Arr.join(known.defaultOf, ", ")}`;

  const matching = Arr.filter([...gathered], ([name]) => name.toLowerCase().includes(wanted));

  const choices = Arr.map(matching, ([name, known]) => ({
    name,
    note: noteOf(known),
    missingFrom: Arr.filter(listed, (repo) => !known.repos.includes(repo)),
    latest: known.latest,
  }));

  // Those every Repo has first, then the most recent; among branches of no date, by name.
  choices.sort(
    (one, other) =>
      one.missingFrom.length - other.missingFrom.length ||
      other.latest - one.latest ||
      one.name.localeCompare(other.name),
  );

  return {
    choices: Arr.map(choices, ({ name, note, missingFrom }) => ({ name, note, missingFrom })),
    unlisted,
  };
};

/**
 * Why `base` would fail some of the Repos, or null: the listed Repos GitHub says have no such branch, whose clones could
 * not start from it. A branch the lists do not have at all (pushed a moment ago, or beyond what was listed) says nothing.
 */
export const baseWarning = (lists: readonly RepoBranches[], base: string): string | null => {
  const name = base.trim();
  const choice = Arr.findFirst(baseChoices(lists, "").choices, (known) => known.name === name);

  if (Option.isNone(choice) || choice.value.missingFrom.length === 0) return null;

  const missing = Arr.join(choice.value.missingFrom, ", ");

  return `${missing} ${choice.value.missingFrom.length === 1 ? "has" : "have"} no branch ${name}: ${
    choice.value.missingFrom.length === 1 ? "its clone" : "their clones"
  } cannot start from it.`;
};

/**
 * What `createSession` is told for the draft: its Environment and Workspace, and for a new Workspace the branch and base
 * that were filled in.
 */
export const draftPlace = (input: DraftInput): SessionPlace => {
  const { environment, workspace } = input;

  if (workspace !== NEW_WORKSPACE) return { environment, workspace };

  const branch = input.branch.trim();
  const base = input.base.trim();

  const place: Types.Mutable<SessionPlace> = {
    environment,
    workspace,
  };

  if (branch !== "") place.branch = branch;

  if (base !== "") place.base = base;

  return place;
};
