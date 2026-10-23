// What of the Secrets a Worker needs without the Harness (the Workspaces Worker, which does not load pi-durable): the
// vaults, the kept Secrets' shape, and the references and environment names Secrets go by.
export { type KeptScope, type KeptSecret } from "./kept.ts";

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
