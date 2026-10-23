// The `secrets` extension (`docs/spec.md` → Secrets): a port of pi-secret's masked entry, references, and redaction,
// with values entered on the client and kept encrypted in the Session DO.
export {
  extensionName,
  PARENT_ONLY_SECRET_TOOLS,
  SECRET_GUIDELINES,
  secretsExtension,
} from "./secrets/extension.ts";

export { scrubbingModels } from "./secrets/models.ts";

export { Redactions, type RedactionStream } from "./secrets/redaction.ts";

export {
  SECRET_ENV_PREFIX,
  secretEnvName,
  secretReference,
  SECRET_NAME_PATTERN,
} from "./secrets/references.ts";

export { KEPT_REFRESH_MS, type KeptScope, type KeptSecret } from "./secrets/kept.ts";

export {
  type AskOutcome,
  type ForgetOutcome,
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
  type KeptBinding,
  type KeptVault,
  MIN_MASTER_KEY_LENGTH,
  openKeptVault,
  openVault,
  SealedSecret,
  SealedValue,
  type SecretVault,
  SecretVaultError,
} from "./secrets/vault.ts";
