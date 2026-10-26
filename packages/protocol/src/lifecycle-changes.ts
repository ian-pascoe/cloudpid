// What the agent's changes to an Environment's own record are called in the history (`docs/spec.md` → Agent changes):
// its name, its Repos, its creation and the Builds it asks for. Besides the Container settings (`variableField` and
// the setting names), these are the `field`s of an Agent change. Shared by the server (which writes and reverts them)
// and the web app (which labels them and offers a revert only where there is one).
import { fieldSecret } from "./environment-secrets.ts";
import { MAX_ENVIRONMENT_NAME_LENGTH } from "./registry.ts";

/** The field of a change that renamed the Environment: the name before and after, as text. */
export const NAME_FIELD = "name";

/**
 * The field of the change that made the Environment: nothing before, and after it the name and the Repos it was made
 * with. There is no revert: deleting an Environment needs the owner's Approval.
 */
export const CREATED_FIELD = "environment";

/** The field of a change that asked for a Build: there is no revert. */
export const BUILD_FIELD = "build";

/** What a change to the Build field holds after it: that a Build was asked for. */
export const BUILD_ASKED = "asked for";

const REPO_FIELD = "repos.";

/** An Agent change's field for one of the Repos, by its directory name: its address before and after, null for none. */
export const repoField = (name: string): string => `${REPO_FIELD}${name}`;

/** The Repo an Agent change's field names, or null for another field. */
export const fieldRepo = (field: string): string | null =>
  field.startsWith(REPO_FIELD) ? field.slice(REPO_FIELD.length) : null;

/**
 * Whether an Agent change's field has no revert: the creation of an Environment, a Build asked for, and a Secret kept
 * (the history holds no value to bring back; deleting a kept Secret needs the owner's Approval). A Secret's Build mark
 * is reverted.
 */
export const unrevertableField = (field: string): boolean =>
  field === CREATED_FIELD || field === BUILD_FIELD || fieldSecret(field)?.kind === "kept";

/**
 * Why `text` cannot be an Environment's name, or undefined when it can: after trimming, neither empty nor longer than
 * `MAX_ENVIRONMENT_NAME_LENGTH`. Whether another Environment has it (whatever the case) is the Registry's to say.
 */
export const environmentNameProblem = (text: string): string | undefined => {
  const name = text.trim();

  if (name === "") return "Give the environment a name";

  return name.length > MAX_ENVIRONMENT_NAME_LENGTH
    ? `Use at most ${MAX_ENVIRONMENT_NAME_LENGTH} characters`
    : undefined;
};
