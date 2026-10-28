// Secrets kept for an Environment, or for every Environment (`docs/architecture/agent-capabilities.md` → Secrets, ADR-0016): Secrets like
// `secret_ask`'s, used by reference and scrubbed from output and provider requests, that the owner sets on the
// Environments page and that do not expire. Plain data, as they cross Durable Object RPC; a value is never stored
// outside a vault (`openKeptVault`).

/** Where a kept Secret is kept: for the Session's Environment, or for every Environment. */
export type KeptScope = "environment" | "every";

/** A kept Secret with its value, as the Registry hands it to a Session or a Workspace. */
export type KeptSecret = {
  readonly name: string;
  readonly value: string;
  readonly scope: KeptScope;
  /** Whether it reaches the Environment's Build, as an environment variable of its scripts. */
  readonly build: boolean;
};

/** How long a Session uses the kept Secrets it was handed before it asks the Registry again. */
export const KEPT_REFRESH_MS = 30_000;

/** After a failed ask for them, how long before the next one. */
export const KEPT_RETRY_MS = 5_000;
