// @effect-diagnostics missingPipeableSignature:off -- plain helpers over the draft's fields, not combinators.

// The draft composer's pure parts: what is typed and chosen, whether it can be sent, and what `createSession` is told.

import * as Arr from "effect/Array";
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
  /**
   * Which Repos have it and which it is the default branch of, when that says something: "default", "in app", "in app ·
   * default in app"; undefined for a branch every listed Repo has and none starts from.
   */
  readonly note: string | undefined;
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
 * Repo whose name holds `query` (any case), most recently committed to first in any Repo, each once. A branch only some
 * of several Repos have says which (a Repo without it starts from its default branch), and the default branch says so.
 */
export const baseChoices = (lists: readonly RepoBranches[], query: string): BaseChoices => {
  const wanted = query.trim().toLowerCase();
  const gathered = new Map<string, Gathered>();
  const unlisted: { repo: string; message: string }[] = [];
  let listed = 0;

  for (const list of lists) {
    if (list.status === "error") {
      unlisted.push({ repo: list.repo, message: list.message });

      continue;
    }

    listed += 1;

    for (const branch of list.branches) {
      const known = gathered.get(branch.name) ?? { repos: [], defaultOf: [], latest: -Infinity };

      known.repos.push(list.repo);

      if (branch.name === list.defaultBranch) known.defaultOf.push(list.repo);

      known.latest = Math.max(known.latest, branch.committedAt ?? -Infinity);
      gathered.set(branch.name, known);
    }
  }

  const noteOf = (known: Gathered): string | undefined => {
    const several = listed > 1;

    const parts = Arr.filter(
      [
        several && known.repos.length < listed ? `in ${Arr.join(known.repos, ", ")}` : undefined,
        known.defaultOf.length === 0
          ? undefined
          : !several || known.defaultOf.length === listed
            ? "default"
            : `default in ${Arr.join(known.defaultOf, ", ")}`,
      ],
      (part) => part !== undefined,
    );

    return parts.length === 0 ? undefined : Arr.join(parts, " · ");
  };

  const matching = Arr.filter([...gathered], ([name]) => name.toLowerCase().includes(wanted));

  // Most recent first; among branches of no date, by name.
  const choices = Arr.map(
    matching.sort(([a, one], [b, other]) => other.latest - one.latest || a.localeCompare(b)),
    ([name, known]) => ({ name, note: noteOf(known) }),
  );

  return { choices, unlisted };
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
