// The `secrets` extension (`docs/spec.md` → Secrets): a port of pi-secret's masked entry, references, and redaction,
// with values entered on the client and kept encrypted in the Session DO.
export {
  extensionName,
  PARENT_ONLY_SECRET_TOOLS,
  SECRET_GUIDELINES,
  secretsExtension,
} from "./secrets/extension.ts";

export { Redactions, type RedactionStream } from "./secrets/redaction.ts";

export {
  SECRET_ENV_PREFIX,
  secretEnvName,
  secretReference,
  SECRET_NAME_PATTERN,
} from "./secrets/references.ts";

export {
  type AskOutcome,
  type HeldSecret,
  SECRET_LIFETIME_MS,
  SecretAsk,
  Secrets,
  SecretsError,
  type SecretsOptions,
  secretsLayer,
  type SecretsService,
  type SecretStorage,
} from "./secrets/store.ts";

export {
  MIN_MASTER_KEY_LENGTH,
  openVault,
  SealedSecret,
  type SecretVault,
  SecretVaultError,
} from "./secrets/vault.ts";
