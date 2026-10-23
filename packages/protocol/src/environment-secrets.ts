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
