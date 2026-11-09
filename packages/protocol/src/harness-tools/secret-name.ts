// A Secret's name (`docs/architecture/agent-capabilities.md` → Secrets): what `secret_ask`, the owner's form and
// `environment_secret_build` take. Here, under `harness-tools/`, so the shared declarations can name it; the rest of the
// package re-exports it from `environment-secrets.ts`.
import * as Schema from "effect/Schema";

/** A Secret Name, as `secret_ask` takes it: an uppercase letter or underscore, then uppercase letters, digits or underscores. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The longest Secret Name. */
export const MAX_SECRET_NAME_LENGTH = 128;

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

/** A Secret Name (`secretNameProblem`). */
export const SecretName = Schema.String.check(
  Schema.makeFilter((name: string) => secretNameProblem(name)),
);
