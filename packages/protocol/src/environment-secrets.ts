// Secrets kept for an Environment, or for every Environment (`docs/spec.md` → Secrets, ADR-0016): what the owner sets
// on the Environments page and what the Registry lists. A value goes in once and never comes back: the Registry keeps
// it sealed, and lists only names, scopes, build flags and times.
import * as Schema from "effect/Schema";

/** A Secret Name, as `secret_ask` takes it: an uppercase letter or underscore, then uppercase letters, digits or underscores. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The longest Secret Name. */
export const MAX_SECRET_NAME_LENGTH = 128;

/** The longest value a kept Secret may have, in bytes of UTF-8: a key file or a service account's JSON fits. */
export const MAX_ENVIRONMENT_SECRET_BYTES = 32 * 1024;

/** How many Secrets one scope (an Environment, or every Environment) may keep. */
export const MAX_ENVIRONMENT_SECRETS = 100;

/** Why `name` cannot name a Secret, or undefined when it can. */
export const secretNameProblem = (name: string): string | undefined => {
  if (name === "") return "A Secret needs a name";

  if (name.length > MAX_SECRET_NAME_LENGTH) {
    return `A Secret's name has at most ${MAX_SECRET_NAME_LENGTH} characters`;
  }

  return SECRET_NAME.test(name)
    ? undefined
    : "A Secret's name uses uppercase letters, digits and underscores, and does not start with a digit";
};

/** Why `value` cannot be a Secret's value, or undefined when it can. Never quotes the value. */
export const secretValueProblem = (value: string): string | undefined => {
  if (value === "") return "A Secret needs a value";

  if (value.includes("\0")) return "A Secret's value cannot hold a NUL character";

  if (new TextEncoder().encode(value).length > MAX_ENVIRONMENT_SECRET_BYTES) {
    return `A Secret's value is at most ${MAX_ENVIRONMENT_SECRET_BYTES / 1024} KiB`;
  }

  return undefined;
};

/** A Secret Name (`secretNameProblem`). */
export const SecretName = Schema.String.check(
  Schema.makeFilter((name: string) => secretNameProblem(name)),
);

/** A kept Secret as the Registry lists it: never its value. Times are epoch milliseconds. */
export const EnvironmentSecretRecord = Schema.Struct({
  /** The Environment it is kept for, or null for every Environment (an Environment's own of the same name wins). */
  environment: Schema.NullOr(Schema.String),
  name: Schema.String,
  /** Whether it reaches the Environment's Build, as an environment variable of its scripts. */
  build: Schema.Boolean,
  /** When its value or its build flag last changed. */
  updatedAt: Schema.Finite,
});

export type EnvironmentSecretRecord = typeof EnvironmentSecretRecord.Type;

/**
 * Where the owner keeps the Secrets a `secret_ask` form gets (`docs/spec.md` â Secrets): `session` holds them for this
 * Session for the usual 15 minutes, `environment` keeps them for the Session's Environment and `all` for every
 * Environment, as the Environments page does. The agent's `keep` only pre-selects one; the owner's choice is final.
 */
export const SecretKeep = Schema.Literals(["session", "environment", "all"]);

export type SecretKeep = typeof SecretKeep.Type;

const KEPT_SECRET_FIELD = "secrets.";

const BUILD_MARK_SUFFIX = ".build";

/**
 * The field of the Agent change that records a Secret kept, by its name only: `secrets.<NAME>`, `kept` after it, and
 * before it `kept` where the scope kept one of the name already (its value replaced), else none. A kept Secret the agent
 * deleted with the owner's Approval (`environment_secret_delete`) is recorded the other way round: `kept` before, none
 * after. There is no revert: the history holds no value to bring back.
 */
export const keptSecretField = (name: string): string => `${KEPT_SECRET_FIELD}${name}`;

/** The field of the Agent change of a kept Secret's Build mark: `secrets.<NAME>.build`, with a boolean before and after. */
export const secretBuildField = (name: string): string =>
  `${KEPT_SECRET_FIELD}${name}${BUILD_MARK_SUFFIX}`;

/** What a kept Secret's change holds, before (where it was kept already) and after. */
export const KEPT_SECRET = "kept";

/**
 * The kept Secret an Agent change's field names, and whether it records the Secret kept (`kept`) or its Build mark
 * changed (`build`); null for another field. A Secret Name holds no dot, so the two never mix.
 */
export const fieldSecret = (
  field: string,
): { readonly name: string; readonly kind: "kept" | "build" } | null => {
  if (!field.startsWith(KEPT_SECRET_FIELD)) return null;

  const rest = field.slice(KEPT_SECRET_FIELD.length);

  return rest.endsWith(BUILD_MARK_SUFFIX)
    ? { name: rest.slice(0, -BUILD_MARK_SUFFIX.length), kind: "build" }
    : { name: rest, kind: "kept" };
};
