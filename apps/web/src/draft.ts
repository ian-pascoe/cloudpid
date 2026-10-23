// @effect-diagnostics missingPipeableSignature:off -- plain helpers over the draft's fields, not combinators.

// The draft composer's pure parts: what is typed and chosen, whether it can be sent, and what `createSession` is told.

import * as Arr from "effect/Array";
import { NEW_WORKSPACE, type WorkspaceRecord } from "@cloudpid/protocol";
import { optionalBranchProblem } from "./environments.ts";
import type { SessionPlace } from "./sessions.ts";

/** `T` with its properties writable, for a place built up field by field. */
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

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
  input.workspace === NEW_WORKSPACE ? optionalBranchProblem(input.branch) : null;

/** Why the base branch field cannot be used, or null; only a new Workspace has one. */
export const draftBaseProblem = (input: DraftInput): string | null =>
  input.workspace === NEW_WORKSPACE ? optionalBranchProblem(input.base) : null;

/** Whether the draft can be sent: it has a message, and neither branch field is wrong. */
export const draftSendable = (input: DraftInput): boolean =>
  input.text.trim() !== "" &&
  draftBranchProblem(input) === null &&
  draftBaseProblem(input) === null;

/**
 * What `createSession` is told for the draft: its Environment and Workspace, and for a new Workspace the branch and base
 * that were filled in.
 */
export const draftPlace = (input: DraftInput): SessionPlace => {
  const { environment, workspace } = input;

  if (workspace !== NEW_WORKSPACE) return { environment, workspace };

  const branch = input.branch.trim();
  const base = input.base.trim();

  const place: Mutable<SessionPlace> = {
    environment,
    workspace,
  };

  if (branch !== "") place.branch = branch;

  if (base !== "") place.base = base;

  return place;
};
