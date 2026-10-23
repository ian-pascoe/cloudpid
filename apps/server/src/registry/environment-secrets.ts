// The Secrets kept for an Environment, or for every Environment, on the Registry DO's side (docs/spec.md → Secrets,
// ADR-0016). The owner's value is checked, then sealed here (AES-GCM under a key HKDF derives from
// `SECRETS_ENCRYPTION_KEY` for the Registry, bound to the record's scope and name, so a row moved to another scope or
// name does not open) and only the ciphertext is stored. What an Environment uses is opened here and handed, over
// Durable Object RPC within the Worker, to the Session DOs and the main Worker that ask (`environmentSecrets`,
// `sessionSecrets`): its own Secrets over those of the same name kept for every Environment. A value never leaves in
// a listing, and never reaches a log.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import {
  type KeptSecret,
  type KeptVault,
  type SecretVaultError,
} from "@cloudpid/extensions/secrets/core";
import {
  type EnvironmentSecretRecord,
  secretNameProblem,
  secretValueProblem,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import { EVERY_ENVIRONMENT_SCOPE, type RegistryStore } from "./store.ts";

/** The part of the Registry's store kept Secrets are read from and written to. */
export type SecretsTable = Pick<RegistryStore, "getEnvironmentSecrets" | "putEnvironmentSecret">;

/** How keeping a Secret went. */
export type SecretWrite =
  | { readonly status: "saved"; readonly record: EnvironmentSecretRecord }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" }
  | { readonly status: "full" };

/** What a Secret's ciphertext is bound to: its scope (an Environment's id, or every Environment's) and its name. */
const binding = (environment: string | null, name: string) => ({
  owner: environment ?? EVERY_ENVIRONMENT_SCOPE,
  name,
});

/**
 * Keep `value` under `name` for `environment` (null: every Environment), replacing what is kept there: refused, with
 * why, when the name or value is malformed (the message never holds the value), when the Environment does not exist,
 * or when the scope is full. Fails only when the value cannot be sealed.
 */
export const keepSecret = (
  table: SecretsTable,
  vault: KeptVault,
  input: {
    readonly environment: string | null;
    readonly name: string;
    readonly value: string;
    readonly build?: boolean | undefined;
  },
  now: number,
): Effect.Effect<SecretWrite, SecretVaultError> =>
  Effect.gen(function* () {
    const problem = secretNameProblem(input.name) ?? secretValueProblem(input.value);

    if (problem !== undefined) return { status: "rejected", message: problem };

    const sealed = yield* vault.seal(binding(input.environment, input.name), input.value);

    const put = table.putEnvironmentSecret(
      { environment: input.environment, name: input.name, sealed, build: input.build },
      now,
    );

    return put === "missing" || put === "full" ? { status: put } : { status: "saved", record: put };
  });

/**
 * The Secrets `environment` uses, opened, by name: its own over those of the same name kept for every Environment. A
 * record that does not open (sealed under another key, or moved) is left out and logged by name.
 */
export const openEnvironmentSecrets = (
  table: SecretsTable,
  vault: KeptVault,
  environment: string,
): Effect.Effect<ReadonlyArray<KeptSecret>> =>
  Effect.gen(function* () {
    const opened = new Map<string, KeptSecret>();

    // Those kept for every Environment come first, so the Environment's own replace them.
    for (const row of table.getEnvironmentSecrets(environment)) {
      const value = yield* vault
        .open(binding(row.environment, row.name), row.sealed)
        .pipe(
          Effect.catch(() =>
            Effect.logWarning(
              `The Secret ${row.name} kept for ${row.environment === null ? "every environment" : `environment ${row.environment}`} does not open (the encryption key changed?); set it again`,
            ).pipe(Effect.as(undefined)),
          ),
        );

      if (value === undefined) continue;

      opened.set(row.name, {
        name: row.name,
        value,
        scope: row.environment === null ? "every" : "environment",
        build: row.build,
      });
    }

    return [...opened.values()].toSorted((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  });

/**
 * A keyed digest of the Secrets that reach a Build (names and values), for its key (`buildKey`), so a changed value
 * makes the Build again while the key, stored and shown in the clear, says nothing of it; null when none reaches it.
 */
export const buildSecretsDigest = (
  vault: KeptVault,
  secrets: ReadonlyArray<KeptSecret>,
): Effect.Effect<string | null, SecretVaultError> => {
  const pairs = secrets
    .flatMap((secret) => (secret.build ? [[secret.name, secret.value] as const] : []))
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return pairs.length === 0
    ? Effect.succeed(null)
    : vault.digest(JSON.stringify({ version: 1, secrets: pairs }));
};
