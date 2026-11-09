// What of the Secrets a Worker needs without the Harness (the Workspaces Worker, which does not load pi-durable): the
// vaults, the kept Secrets' shape, the references and environment names Secrets go by, and the redaction of held values.
export { type KeptScope, type KeptSecret } from "./kept.ts";

// The values a Worker holds and the encodings it scrubs them in: the Registry checks the texts an endpoint write keeps.
export { Redactions } from "./redaction.ts";

export {
  SECRET_ENV_PREFIX,
  SECRET_NAME_PATTERN,
  isSecretName,
  secretEnvName,
  secretReference,
} from "./references.ts";

export {
  type KeptBinding,
  type KeptVault,
  MIN_MASTER_KEY_LENGTH,
  openKeptVault,
  SealedValue,
  SecretVaultError,
} from "./vault.ts";
