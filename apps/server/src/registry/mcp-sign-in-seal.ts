// What MCP sign-ins keep sealed (`docs/architecture/mcp-sign-in.md` → MCP sign-ins, Storage; ADR-0034): a sign-in's tokens,
// a registration's client secret and a pending row's PKCE verifier. Each is AES-GCM under a key HKDF derives from
// `SECRETS_ENCRYPTION_KEY` for the purpose `mcp-oauth` (`openKeptVault`, the vault kept Secrets use under `registry`),
// and bound to its table and the row's key, so a value moved to another row, table or purpose does not open. Nothing
// here logs, and no error holds a value: a failure says which row, by its hash.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { byteLength, MAX_TOKEN_BYTES } from "@cloudpid/mcp/oauth";
import {
  type KeptBinding,
  type KeptVault,
  type SealedValue,
  SecretVaultError,
} from "@cloudpid/extensions/secrets/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The purpose the vault is opened for (`openKeptVault(masterKey, MCP_OAUTH_PURPOSE)`; it fails while the key is malformed). */
export const MCP_OAUTH_PURPOSE = "mcp-oauth";

/** The tables whose values are sealed: part of every binding. */
export const SIGN_INS_TABLE = "mcp_sign_ins";
export const REGISTRATIONS_TABLE = "mcp_client_registrations";
export const PENDING_TABLE = "mcp_pending_sign_ins";

export type SealedTable = typeof SIGN_INS_TABLE | typeof REGISTRATIONS_TABLE | typeof PENDING_TABLE;

/** What a ciphertext is bound to: the table and the row's key. */
export const sealedBinding = (table: SealedTable, key: string): KeptBinding => ({
  owner: table,
  name: key,
});

/**
 * `text` sealed for the row `key` of `table`: a registration's client secret (#450 registers a client) or a pending
 * row's PKCE verifier (#450 starts a sign-in). Tokens are `sealTokens`, which bounds them first.
 */
export const sealValue = (
  vault: KeptVault,
  table: SealedTable,
  key: string,
  text: string,
): Effect.Effect<SealedValue, SecretVaultError> => vault.seal(sealedBinding(table, key), text);

/** The text sealed under the row `key` of `table`; fails when it was sealed under another table, row, purpose or key. */
export const openValue = (
  vault: KeptVault,
  table: SealedTable,
  key: string,
  sealed: SealedValue,
): Effect.Effect<string, SecretVaultError> => vault.open(sealedBinding(table, key), sealed);

/** The tokens a sign-in holds. */
const Tokens = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
});

export type McpTokens = typeof Tokens.Type;

const decodeTokens = Schema.decodeUnknownOption(Schema.fromJsonString(Tokens));

/** Sealing a token was refused: it is longer than `MAX_TOKEN_BYTES`. Names the kind, never the token. */
export type TokensSealed =
  | { readonly status: "sealed"; readonly sealed: SealedValue }
  | { readonly status: "too_large"; readonly token: "access_token" | "refresh_token" };

/** The tokens sealed for the sign-in `key`, unless one is over `MAX_TOKEN_BYTES`. */
export const sealTokens = (
  vault: KeptVault,
  key: string,
  tokens: McpTokens,
): Effect.Effect<TokensSealed, SecretVaultError> => {
  if (byteLength(tokens.access_token) > MAX_TOKEN_BYTES) {
    return Effect.succeed({ status: "too_large", token: "access_token" });
  }

  if (tokens.refresh_token !== undefined && byteLength(tokens.refresh_token) > MAX_TOKEN_BYTES) {
    return Effect.succeed({ status: "too_large", token: "refresh_token" });
  }

  return sealValue(
    vault,
    SIGN_INS_TABLE,
    key,
    // An absent refresh token is left out of the text, as JSON leaves out what is undefined.
    JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token }),
  ).pipe(Effect.map((sealed): TokensSealed => ({ status: "sealed", sealed })));
};

/**
 * The tokens sealed under the sign-in `key`; fails when they were sealed under another row, purpose or key, or are not
 * tokens. The failure names the row, never a value.
 */
export const openTokens = (
  vault: KeptVault,
  key: string,
  sealed: SealedValue,
): Effect.Effect<McpTokens, SecretVaultError> =>
  openValue(vault, SIGN_INS_TABLE, key, sealed).pipe(
    Effect.flatMap((text) =>
      Effect.fromOption(decodeTokens(text)).pipe(
        Effect.mapError(() =>
          SecretVaultError.make({ message: `The sign-in ${key} holds no tokens` }),
        ),
      ),
    ),
  );
