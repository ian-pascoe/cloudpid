// What the main Worker's Registry endpoint and its upkeeps tell the owner when something is missing or failed.
// @effect-diagnostics missingPipeableSignature:off
import * as Cause from "effect/Cause";

/** What went wrong in `cause`, in a line. */
export const reason = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);

  return error instanceof Error ? error.message : String(error);
};

/** That no Environment is registered under `id`. */
export const noEnvironment = (id: string): string => `Environment "${id}" does not exist`;

/** That another Environment has the name, whatever the case. */
export const nameTaken = (name: string): string => `Another environment is already named "${name}"`;

/** That the Environment has a Repo in the directory already. */
export const repoTaken = (directory: string): string =>
  `The environment already has a repo in ${directory}: name this one`;

/** That the Environment has no Repo in the directory. */
export const noRepo = (directory: string): string => `The environment has no repo "${directory}"`;

/** `first`, then `then` as a sentence of its own: one full stop between them, whether or not `first` ends in one. */
export const thenSaying = (first: string, then: string): string =>
  `${first.endsWith(".") ? first : `${first}.`} ${then}`;
