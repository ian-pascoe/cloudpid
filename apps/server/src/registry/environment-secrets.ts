// The Secrets kept for an Environment, or Global, on the Registry DO's side (docs/architecture/agent-capabilities.md → Secrets,
// ADR-0016). The owner's value is checked, then sealed here (AES-GCM under a key HKDF derives from
// `SECRETS_ENCRYPTION_KEY` for the Registry, bound to the record's scope and name, so a row moved to another scope or
// name does not open) and only the ciphertext is stored. What an Environment uses is opened here and handed, over
// Durable Object RPC within the Worker, to the Session DOs and the main Worker that ask (`environmentSecrets`,
// `sessionSecrets`): its own Secrets over those of the same name kept Global. A value never leaves in
// a listing, and never reaches a log.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import {
  type KeptSecret,
  type KeptVault,
  type SecretVaultError,
} from "@cloudpid/extensions/secrets/core";
import {
  type AgentChange,
  type EnvironmentSecretRecord,
  KEPT_SECRET,
  keptSecretField,
  MAX_ENVIRONMENT_SECRETS,
  secretNameProblem,
  secretValueProblem,
} from "@cloudpid/protocol";
import * as Effect from "effect/Effect";
import type { AgentChangeAuthor, AgentChanges } from "./agent-changes.ts";
import { GLOBAL_SCOPE, type RegistryStorage, type RegistryStore } from "./store.ts";

/** The part of the Registry's store kept Secrets are read from and written to. */
export type SecretsTable = Pick<RegistryStore, "getEnvironmentSecrets" | "putEnvironmentSecret">;

/** How keeping a Secret went. */
export type SecretWrite =
  | { readonly status: "saved"; readonly record: EnvironmentSecretRecord }
  | { readonly status: "rejected"; readonly message: string }
  | { readonly status: "missing" }
  | { readonly status: "full" };

/** What a Secret's ciphertext is bound to: its scope (an Environment's id, or each Environment's) and its name. */
const binding = (environment: string | null, name: string) => ({
  owner: environment ?? GLOBAL_SCOPE,
  name,
});

/**
 * Keep `value` under `name` for `environment` (null: Global), replacing what is kept there: refused, with
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

/** How the agent's `secret_ask` form kept a Secret the owner chose to keep. */
export type SecretKept =
  | {
      readonly status: "kept";
      readonly record: EnvironmentSecretRecord;
      readonly change: AgentChange;
      /** Set when the Session's Environment keeps its own Secret of the name, which wins over one at Global. */
      readonly shadowed: boolean;
    }
  | { readonly status: "rejected"; readonly message: string };

/**
 * Keep `value` under `name` for `environment` (null: Global) as the owner's form on the Environments page
 * does (`keepSecret`: the same name and value rules), because the owner chose to in a `secret_ask` form the agent asked
 * for, and record that in the scope's Agent changes by name only (`keptSecretField`: kept after, kept before where the
 * scope kept one of the name already). The record and the Secret are one step. `sessionEnvironment` is the asking
 * Session's, which says whether a Secret kept Global is shadowed there. A value never reaches the
 * record, a message or a log.
 */
export const keepSecretAs = (
  storage: Pick<RegistryStorage, "transactionSync">,
  table: SecretsTable,
  changes: AgentChanges,
  vault: KeptVault,
  input: {
    readonly environment: string | null;
    readonly name: string;
    readonly value: string;
    readonly sessionEnvironment: string;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): Effect.Effect<SecretKept, SecretVaultError> =>
  Effect.gen(function* () {
    const problem = secretNameProblem(input.name) ?? secretValueProblem(input.value);

    if (problem !== undefined) return { status: "rejected", message: problem };

    const sealed = yield* vault.seal(binding(input.environment, input.name), input.value);

    return storage.transactionSync((): SecretKept => {
      const kept = table.getEnvironmentSecrets(input.environment ?? GLOBAL_SCOPE);

      const before = kept.some(
        (row) => row.environment === input.environment && row.name === input.name,
      );

      const put = table.putEnvironmentSecret(
        { environment: input.environment, name: input.name, sealed, build: undefined },
        now,
      );

      if (put === "missing")
        return { status: "rejected", message: "The Environment does not exist" };

      if (put === "full") {
        return {
          status: "rejected",
          message: `At most ${MAX_ENVIRONMENT_SECRETS} Secrets are kept for ${input.environment === null ? "Global" : "this environment"}: the user deletes one on the Environments page first`,
        };
      }

      const change = changes.record({
        scope: input.environment ?? GLOBAL_SCOPE,
        at: now,
        actor: "agent",
        session: input.author.session,
        conversation: input.author.conversation,
        tool: input.author.tool,
        reason: input.author.reason,
        field: keptSecretField(input.name),
        before: before ? KEPT_SECRET : null,
        after: KEPT_SECRET,
        reverts: null,
      });

      const shadowed =
        input.environment === null &&
        table
          .getEnvironmentSecrets(input.sessionEnvironment)
          .some((row) => row.environment !== null && row.name === input.name);

      return { status: "kept", record: put, change, shadowed };
    });
  });

/**
 * The Secrets `environment` uses, opened, by name: its own over those of the same name kept Global. A
 * record that does not open (sealed under another key, or moved) is left out and logged by name.
 */
export const openEnvironmentSecrets = (
  table: SecretsTable,
  vault: KeptVault,
  environment: string,
): Effect.Effect<ReadonlyArray<KeptSecret>> =>
  Effect.gen(function* () {
    const opened = new Map<string, KeptSecret>();

    // Those kept Global come first, so the Environment's own replace them.
    for (const row of table.getEnvironmentSecrets(environment)) {
      const value = yield* vault
        .open(binding(row.environment, row.name), row.sealed)
        .pipe(
          Effect.catch(() =>
            Effect.logWarning(
              `The Secret ${row.name} kept for ${row.environment === null ? "Global" : `environment ${row.environment}`} does not open (the encryption key changed?); set it again`,
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

/**
 * What a Workspace is told in its set-up when the Registry cannot open its Environment's Secrets (the master key is
 * malformed): it is handed none, and refuses the snapshots and Builds that would need them. Never holds a value.
 */
export const SECRETS_UNAVAILABLE =
  "secrets unavailable: the Registry cannot open the Environment's kept Secrets (SECRETS_ENCRYPTION_KEY is malformed)";

/** The Secrets a Workspace's set-up carries: those its Environment uses, or why there are none (`SECRETS_UNAVAILABLE`). */
export type SecretsHandover =
  | { readonly secrets: ReadonlyArray<KeptSecret> }
  | { readonly secretsUnavailable: string };

/**
 * The Secrets `environment` uses, opened (`openEnvironmentSecrets`), under the vault `vault` opens. An Environment none
 * reaches never opens the vault, so it works whatever the master key; one some reach fails while the key is malformed.
 */
export const usedSecrets = (
  table: SecretsTable,
  vault: Effect.Effect<KeptVault, SecretVaultError>,
  environment: string,
): Effect.Effect<ReadonlyArray<KeptSecret>, SecretVaultError> =>
  Effect.suspend(() =>
    table.getEnvironmentSecrets(environment).length === 0
      ? Effect.succeed([])
      : Effect.flatMap(vault, (keys) => openEnvironmentSecrets(table, keys, environment)),
  );

/** `usedSecrets` for a Workspace's set-up: a vault that does not open is logged, and the set-up says so instead. */
export const secretsHandover = (
  table: SecretsTable,
  vault: Effect.Effect<KeptVault, SecretVaultError>,
  environment: string,
): Effect.Effect<SecretsHandover> =>
  usedSecrets(table, vault, environment).pipe(
    Effect.map((secrets): SecretsHandover => ({ secrets })),
    Effect.catch((error) =>
      Effect.logWarning(
        `Environment ${environment}'s Secrets are not handed to its Workspace: ${error.message}`,
      ).pipe(Effect.as<SecretsHandover>({ secretsUnavailable: SECRETS_UNAVAILABLE })),
    ),
  );

/**
 * The keyed digest of the Secrets that reach `environment`'s Build (`buildSecretsDigest`), null when none does, which
 * opens the vault only when some does.
 */
export const buildSecretsOf = (
  table: SecretsTable,
  vault: Effect.Effect<KeptVault, SecretVaultError>,
  environment: string,
): Effect.Effect<string | null, SecretVaultError> =>
  Effect.flatMap(usedSecrets(table, vault, environment), (kept) =>
    kept.some((secret) => secret.build)
      ? Effect.flatMap(vault, (keys) => buildSecretsDigest(keys, kept))
      : Effect.succeed(null),
  );
