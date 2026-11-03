// The Registry's MCP sign-in store (`docs/architecture/mcp-sign-in.md` → MCP sign-ins; ADR-0034): five tables kept Global
// over the Registry DO's SQLite (migration 30), synchronous as SQLite in a Durable Object is, and given the time by its
// caller so tests control it. Values that are sealed (tokens, a registration's secret, a verifier) arrive and leave as
// `SealedValue`s: sealing is `mcp-sign-in-seal.ts`'s, and happens before a transaction, since it is asynchronous.
//
// Bounds (→ Bounds), held here so every writer meets them:
//   - sign-ins 200: at the limit the least recently used row without tokens is evicted, else the new one is refused;
//   - registrations 100 and bindings 200: an unreferenced row is evicted, else the new one is refused;
//   - pending rows 20, the oldest dropped (and a row is dropped when it expires, 10 min);
//   - waiters 100, then refused; each expires after 30 days;
//   - recorded metadata and discovery each ≤64 KiB. A token is held to 16 KiB where it is sealed.
//
// The revision (`signInsRevision`) is one counter, kept in `documents`, that rises with a sign-in, sign-out or rebind (and
// a drop of tokens): the host compares it at `windowOpened`, so a push it lost is healed. No row's sealed value is ever read
// into a listing (`McpSignInRecord` has none).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off cryptoRandomUUID:off
import { sha256Hex } from "@cloudpid/config";
import { MAX_METADATA_BYTES, byteLength } from "@cloudpid/mcp/oauth";
import { SealedValue } from "@cloudpid/extensions/secrets/core";
import { McpAuthChallenge } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { RegistryStorage } from "./store.ts";

/** How many of each the store holds. */
export const MAX_MCP_SIGN_INS = 200;
export const MAX_MCP_REGISTRATIONS = 100;
export const MAX_MCP_BINDINGS = 200;
export const MAX_MCP_PENDING = 20;
export const MAX_MCP_WAITERS = 100;

/** How long a pending sign-in and a waiter live. */
export const PENDING_SIGN_IN_TTL_MS = 10 * 60_000;
export const SIGN_IN_WAITER_TTL_MS = 30 * 24 * 60 * 60_000;

/** The document that holds the revision. */
export const SIGN_INS_REVISION_DOCUMENT = "mcp-sign-ins-revision";

/** What a sign-in's status is: `ok`, or what stands in the way (`required`: it has no tokens). */
export const SIGN_IN_STATUSES = [
  "ok",
  "required",
  "step_up",
  "rejected",
  "refresh_failing",
] as const;

export type SignInStatus = (typeof SIGN_IN_STATUSES)[number];

const isStatus = Schema.is(Schema.Literals(SIGN_IN_STATUSES));

/** Which kind of client a sign-in signs in as (→ MCP sign-ins). */
export const CLIENT_KINDS = ["configured", "document", "registered", "client_grant"] as const;

export type ClientKind = (typeof CLIENT_KINDS)[number];

const isClientKind = Schema.is(Schema.Literals(CLIENT_KINDS));

/** A secret or key as a reference to a Secret or Variable: never a copy. */
const SecretRef = Schema.Struct({ scope: Schema.String, name: Schema.String });

export type McpSecretRef = typeof SecretRef.Type;

/** The client a sign-in signs in as. */
export type McpSignInClient = {
  readonly id: string;
  readonly kind: ClientKind;
  /** Where a configured client's secret or key is kept: `{scope, name}`, never its value. */
  readonly secretRef: McpSecretRef | null;
  /** The registration (`mcp_client_registrations` key) a `registered` client's id and secret are in. */
  readonly registration: string | null;
};

/** The three parts of a sign-in's key, and their hash (`mcpSignInKey`). */
export type McpSignInKeyParts = {
  readonly hash: string;
  readonly source: string;
  readonly name: string;
  readonly url: string;
};

/** A sign-in's row, but for its tokens, which stay sealed in the store (`McpSignInRow`). */
export type McpSignInRecord = {
  readonly key: McpSignInKeyParts;
  /** New with each completed sign-in or step-up; the same through refreshes (the MCP sign-in id). */
  readonly grantId: string;
  readonly status: SignInStatus;
  readonly issuer: string | null;
  readonly resource: string | null;
  readonly client: McpSignInClient | null;
  /** The scope granted. */
  readonly scope: string | null;
  /** Epoch milliseconds the access token expires; null: no lifetime was given. */
  readonly expiresAt: number | null;
  /** The scope a step-up wants (granted ∪ challenged ∪ configured). */
  readonly wantedScope: string | null;
  /** How many completed step-ups were challenged again for the same scope set. */
  readonly stepUpCount: number;
  /** The last challenge a host reported. */
  readonly challenge: McpAuthChallenge | null;
  /** The last error (≤300 chars), and when. */
  readonly lastError: string | null;
  readonly lastErrorAt: number | null;
  readonly createdAt: number;
  readonly refreshedAt: number | null;
  readonly usedAt: number;
  /** Whether it holds tokens. */
  readonly hasTokens: boolean;
};

/** A sign-in's row: the record, the recorded metadata and discovery (JSON text), and the sealed tokens. */
export type McpSignInRow = McpSignInRecord & {
  readonly metadata: string | null;
  readonly discovery: string | null;
  readonly sealed: SealedValue | null;
};

/** What `putSignIn` writes: the whole row, which replaces the one under the key. */
export type SignInWrite = {
  readonly key: McpSignInKeyParts;
  readonly status: SignInStatus;
  readonly issuer: string | null;
  readonly metadata: string | null;
  readonly discovery: string | null;
  readonly resource: string | null;
  readonly client: McpSignInClient | null;
  readonly scope: string | null;
  readonly expiresAt: number | null;
  readonly wantedScope: string | null;
  readonly stepUpCount: number;
  readonly sealed: SealedValue | null;
};

/** Why a write was refused, and what to tell the owner. */
export type McpStoreRefusal = {
  readonly status: "refused";
  readonly reason: "full" | "too_large";
  readonly message: string;
};

/** Where the owner makes room: Global's MCP servers page lists the sign-ins. */
const SIGN_INS_PAGE = "Global's MCP servers page (/settings/all/mcp#sign-ins)";

const refusal = (reason: McpStoreRefusal["reason"], message: string): McpStoreRefusal => ({
  status: "refused",
  reason,
  message,
});

export type McpSignInPut = { readonly status: "put"; readonly grantId: string } | McpStoreRefusal;

/** A registration of a client at an authorization server (DCR), shared by every sign-in there. */
export type McpRegistration = {
  /** `registrationKey`. */
  readonly key: string;
  readonly issuer: string;
  readonly redirectUri: string;
  readonly clientName: string;
  readonly clientId: string;
  /** The registration response as JSON text, its secret left out. */
  readonly clientInfo: string;
  readonly sealedSecret: SealedValue | null;
  /** Epoch milliseconds the client secret expires; null: never. */
  readonly clientSecretExpiresAt: number | null;
  readonly registeredAt: number;
  readonly usedAt: number;
};

/** A configured client's bind to the one issuer it signs in at (SEP-2352). */
export type McpBinding = {
  readonly keyHash: string;
  readonly clientId: string;
  readonly issuer: string;
  readonly boundAt: number;
};

/** A sign-in that was started and awaits its callback: one per key, holding the `state`'s hash only. */
export type McpPendingSignIn = {
  readonly keyHash: string;
  readonly stateHash: string;
  readonly environment: string;
  readonly redirectUri: string;
  readonly issuer: string;
  /** The authorization server metadata, JSON text. */
  readonly metadata: string;
  /** The client, JSON text. */
  readonly client: string;
  readonly sealedVerifier: SealedValue;
  readonly scope: string | null;
  readonly resource: string | null;
  readonly stepUp: boolean;
  /** Who asked (a Sign-in request's Session and request), JSON text. */
  readonly requester: string | null;
  readonly returnPath: string | null;
  readonly awaitingConfirmation: boolean;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
};

/** An open Sign-in request waiting for a sign-in. */
export type McpSignInWaiter = {
  readonly keyHash: string;
  readonly session: string;
  readonly request: string;
  readonly createdAt: number;
  readonly expiresAt: number;
};

/** How `takePending` found a state's pending row. */
export type PendingTaken =
  | { readonly status: "found"; readonly pending: McpPendingSignIn }
  | { readonly status: "expired" }
  | { readonly status: "none" };

/** How adding a waiter went. `first` is whether it is the first open waiter for the key, which sends the Notification. */
export type WaiterAdded =
  | { readonly status: "added"; readonly first: boolean }
  | { readonly status: "joined" }
  | { readonly status: "full"; readonly message: string };

type SignInRow = {
  readonly key_hash: string;
  readonly source: string;
  readonly name: string;
  readonly url: string;
  readonly grant_id: string;
  readonly status: string;
  readonly issuer: string | null;
  readonly metadata: string | null;
  readonly discovery: string | null;
  readonly resource: string | null;
  readonly client_id: string | null;
  readonly client_kind: string | null;
  readonly client_secret_ref: string | null;
  readonly registration: string | null;
  readonly scope: string | null;
  readonly expires_at: number | null;
  readonly wanted_scope: string | null;
  readonly step_up_count: number;
  readonly challenge: string | null;
  readonly last_error: string | null;
  readonly last_error_at: number | null;
  readonly created_at: number;
  readonly refreshed_at: number | null;
  readonly used_at: number;
  readonly sealed: string | null;
};

const decodeSealed = Schema.decodeUnknownOption(Schema.fromJsonString(SealedValue));

const decodeChallenge = Schema.decodeUnknownOption(Schema.fromJsonString(McpAuthChallenge));

const decodeSecretRef = Schema.decodeUnknownOption(Schema.fromJsonString(SecretRef));

const sealedOf = (text: string | null): SealedValue | null =>
  text === null ? null : Option.getOrNull(decodeSealed(text));

const clientOf = (row: SignInRow): McpSignInClient | null =>
  row.client_id === null || row.client_kind === null || !isClientKind(row.client_kind)
    ? null
    : {
        id: row.client_id,
        kind: row.client_kind,
        secretRef:
          row.client_secret_ref === null
            ? null
            : Option.getOrNull(decodeSecretRef(row.client_secret_ref)),
        registration: row.registration,
      };

const toRow = (row: SignInRow): McpSignInRow => ({
  key: { hash: row.key_hash, source: row.source, name: row.name, url: row.url },
  grantId: row.grant_id,
  // A status this build does not know reads as needing sign-in: the safe side, which exposes no token.
  status: isStatus(row.status) ? row.status : "required",
  issuer: row.issuer,
  metadata: row.metadata,
  discovery: row.discovery,
  resource: row.resource,
  client: clientOf(row),
  scope: row.scope,
  expiresAt: row.expires_at,
  wantedScope: row.wanted_scope,
  stepUpCount: row.step_up_count,
  challenge: row.challenge === null ? null : Option.getOrNull(decodeChallenge(row.challenge)),
  lastError: row.last_error,
  lastErrorAt: row.last_error_at,
  createdAt: row.created_at,
  refreshedAt: row.refreshed_at,
  usedAt: row.used_at,
  hasTokens: row.sealed !== null,
  sealed: sealedOf(row.sealed),
});

/** A row as the listing shows it: nothing sealed, and not the recorded metadata. */
const toRecord = (row: SignInRow): McpSignInRecord => {
  const { metadata: _metadata, discovery: _discovery, sealed: _sealed, ...record } = toRow(row);

  return record;
};

type RegistrationRow = {
  readonly key_hash: string;
  readonly issuer: string;
  readonly redirect_uri: string;
  readonly client_name: string;
  readonly client_id: string;
  readonly client_info: string;
  readonly sealed_secret: string | null;
  readonly client_secret_expires_at: number | null;
  readonly registered_at: number;
  readonly used_at: number;
};

const toRegistration = (row: RegistrationRow): McpRegistration => ({
  key: row.key_hash,
  issuer: row.issuer,
  redirectUri: row.redirect_uri,
  clientName: row.client_name,
  clientId: row.client_id,
  clientInfo: row.client_info,
  sealedSecret: sealedOf(row.sealed_secret),
  clientSecretExpiresAt: row.client_secret_expires_at,
  registeredAt: row.registered_at,
  usedAt: row.used_at,
});

type BindingRow = {
  readonly key_hash: string;
  readonly client_id: string;
  readonly issuer: string;
  readonly bound_at: number;
};

type PendingRow = {
  readonly key_hash: string;
  readonly state_hash: string;
  readonly environment: string;
  readonly redirect_uri: string;
  readonly issuer: string;
  readonly metadata: string;
  readonly client: string;
  readonly sealed_verifier: string;
  readonly scope: string | null;
  readonly resource: string | null;
  readonly step_up: number;
  readonly requester: string | null;
  readonly return_path: string | null;
  readonly awaiting_confirmation: number;
  readonly last_error: string | null;
  readonly created_at: number;
  readonly expires_at: number;
};

/** A pending row whose sealed verifier cannot be read is no row: it cannot complete a sign-in. */
const toPending = (row: PendingRow): McpPendingSignIn | null => {
  const sealedVerifier = sealedOf(row.sealed_verifier);

  return sealedVerifier === null
    ? null
    : {
        keyHash: row.key_hash,
        stateHash: row.state_hash,
        environment: row.environment,
        redirectUri: row.redirect_uri,
        issuer: row.issuer,
        metadata: row.metadata,
        client: row.client,
        sealedVerifier,
        scope: row.scope,
        resource: row.resource,
        stepUp: row.step_up === 1,
        requester: row.requester,
        returnPath: row.return_path,
        awaitingConfirmation: row.awaiting_confirmation === 1,
        lastError: row.last_error,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
};

type WaiterRow = {
  readonly key_hash: string;
  readonly session: string;
  readonly request: string;
  readonly created_at: number;
  readonly expires_at: number;
};

/** The key of a registration: its issuer, redirect URI and `client_name` (→ MCP sign-ins), hashed. */
export const registrationKey = (input: {
  readonly issuer: string;
  readonly redirectUri: string;
  readonly clientName: string;
}): string => sha256Hex(JSON.stringify([input.issuer, input.redirectUri, input.clientName]));

/** SHA-256 of a `state`, which is all a pending row stores of it. */
export const stateHash = (state: string): string => sha256Hex(state);

/** What a change to a sign-in may set, beyond the status (`McpSignIns.update`). */
export type SignInUpdate = {
  readonly status?: SignInStatus;
  readonly challenge?: McpAuthChallenge | null;
  readonly wantedScope?: string | null;
  readonly stepUpCount?: number;
  readonly lastError?: string | null;
};

/** The sign-in store over the Registry's storage, once it is migrated (`openRegistryStore`: migration 30). */
export type McpSignIns = {
  /** The revision of the sign-ins: it rises with a sign-in, sign-out, rebind or drop of tokens; 0 before any. */
  readonly revision: () => number;
  readonly get: (keyHash: string) => McpSignInRow | null;
  /** Every sign-in, the most recently used first, without its tokens. */
  readonly list: () => ReadonlyArray<McpSignInRecord>;
  /** Replace the sign-in under `write.key` with `write` (a new grant id), and rise the revision. */
  readonly put: (write: SignInWrite, now: number) => McpSignInPut;
  /**
   * Remember a challenge for a server that has no sign-in yet: a row with no tokens (`required`) that holds it, so a start
   * discovers from it. A row that exists keeps its status and gets the challenge. Refused when the store is full of rows
   * that hold tokens. The revision stays.
   */
  readonly noteChallenge: (
    key: McpSignInKeyParts,
    challenge: McpAuthChallenge,
    now: number,
  ) => McpStoreRefusal | { readonly status: "noted" };
  /** Change the status or the notes of a sign-in; false when there is none. The revision stays. */
  readonly update: (keyHash: string, update: SignInUpdate, now: number) => boolean;
  /** Replace the tokens of a refreshed sign-in, keeping its grant, and clear its error. False when there is none. */
  readonly replaceTokens: (
    keyHash: string,
    tokens: {
      readonly sealed: SealedValue;
      readonly expiresAt: number | null;
      readonly scope: string | null;
    },
    now: number,
  ) => boolean;
  /** Drop a sign-in's tokens: `required`, with the error that was the reason. Rises the revision. */
  readonly dropTokens: (keyHash: string, error: string | null, now: number) => boolean;
  /** Note that a token was handed out. */
  readonly touch: (keyHash: string, now: number) => void;
  /** Delete the sign-in and its pending row, keeping its registration and binding; false when there is none. Rises the revision. */
  readonly delete: (keyHash: string, now: number) => boolean;

  readonly getRegistration: (key: string) => McpRegistration | null;
  readonly putRegistration: (
    registration: McpRegistration,
  ) => { readonly status: "put" } | McpStoreRefusal;
  readonly deleteRegistration: (key: string) => boolean;

  readonly getBinding: (keyHash: string, clientId: string) => McpBinding | null;
  /**
   * Bind `clientId` at `keyHash` to `issuer`. A rebind to another issuer rises the revision. At the bound, a binding no
   * server set `named` is evicted, else the new one is refused.
   */
  readonly putBinding: (
    binding: McpBinding,
    named: (keyHash: string, clientId: string) => boolean,
  ) => { readonly status: "put"; readonly rebound: boolean } | McpStoreRefusal;
  /** Drop every binding no server set names. */
  readonly dropUnnamedBindings: (named: (keyHash: string, clientId: string) => boolean) => number;

  /** Keep `pending` as the key's one pending row (a newer start replaces it), at most 20, the oldest dropped. */
  readonly putPending: (pending: McpPendingSignIn) => void;
  /** Take the pending row of a `state`'s hash, deleting it first (a code is used once). */
  readonly takePending: (hash: string, now: number) => PendingTaken;
  readonly getPending: (keyHash: string) => McpPendingSignIn | null;
  readonly deletePending: (keyHash: string) => boolean;

  readonly addWaiter: (
    waiter: Pick<McpSignInWaiter, "keyHash" | "session" | "request">,
    now: number,
  ) => WaiterAdded;
  /** The open waiters of a sign-in key. */
  readonly waiters: (keyHash: string, now: number) => ReadonlyArray<McpSignInWaiter>;
  /** Delete and return the open waiters of a key: a sign-in completed, or the server works. */
  readonly resolveWaiters: (keyHash: string, now: number) => ReadonlyArray<McpSignInWaiter>;
  /** Delete one waiter (its request ended: declined or withdrawn); false when it is not there. */
  readonly removeWaiter: (session: string, request: string) => boolean;
};

/** The sign-in store over `storage`. */
export const openMcpSignIns = (
  storage: Pick<RegistryStorage, "sql" | "transactionSync">,
): McpSignIns => {
  const { sql } = storage;

  // Called through the storage: a Durable Object's `transactionSync` loses its receiver when detached.
  const transactionSync = <T>(closure: () => T): T => storage.transactionSync(closure);

  const rows = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: Array<string | number | null>
  ): Array<T> => sql.exec<T>(query, ...bindings).toArray();

  const one = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: Array<string | number | null>
  ): T | undefined => rows<T>(query, ...bindings)[0];

  const count = (table: string): number =>
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;

  const revision = (): number => {
    const body = one<{ body: string }>(
      "SELECT body FROM documents WHERE name = ?",
      SIGN_INS_REVISION_DOCUMENT,
    )?.body;

    const parsed = Number(body);

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
  };

  const rise = (now: number): void => {
    sql.exec(
      `INSERT INTO documents (name, body, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
      SIGN_INS_REVISION_DOCUMENT,
      String(revision() + 1),
      now,
    );
  };

  const getRow = (keyHash: string): SignInRow | undefined =>
    one<SignInRow>("SELECT * FROM mcp_sign_ins WHERE key_hash = ?", keyHash);

  /**
   * Room for a sign-in under a key not yet held: evicts the least recently used row without tokens when the store is
   * full; false when every row holds tokens.
   */
  const makeRoom = (): boolean => {
    if (count("mcp_sign_ins") < MAX_MCP_SIGN_INS) return true;

    const evicted = one<{ key_hash: string }>(
      "SELECT key_hash FROM mcp_sign_ins WHERE sealed IS NULL ORDER BY used_at ASC, created_at ASC LIMIT 1",
    );

    if (evicted === undefined) return false;

    sql.exec("DELETE FROM mcp_sign_ins WHERE key_hash = ?", evicted.key_hash);

    return true;
  };

  const full = refusal(
    "full",
    `At most ${MAX_MCP_SIGN_INS} MCP sign-ins are kept, and every one holds tokens: sign out of one on ${SIGN_INS_PAGE} first`,
  );

  const registrationFull = refusal(
    "full",
    `At most ${MAX_MCP_REGISTRATIONS} client registrations are kept, and every one is in use: sign out of the sign-ins that use one on ${SIGN_INS_PAGE} first`,
  );

  const bindingFull = refusal(
    "full",
    `At most ${MAX_MCP_BINDINGS} client bindings are kept, and every one is named by an MCP server: remove one from the MCP servers on ${SIGN_INS_PAGE.replace(/ \(.*$/, "")} first`,
  );

  return {
    revision,
    get: (keyHash) => {
      const row = getRow(keyHash);

      return row === undefined ? null : toRow(row);
    },
    list: () =>
      Arr.map(
        rows<SignInRow>("SELECT * FROM mcp_sign_ins ORDER BY used_at DESC, key_hash ASC"),
        toRecord,
      ),
    put: (write, now) => {
      if (
        (write.metadata !== null && byteLength(write.metadata) > MAX_METADATA_BYTES) ||
        (write.discovery !== null && byteLength(write.discovery) > MAX_METADATA_BYTES)
      ) {
        return refusal(
          "too_large",
          `The authorization server's metadata is longer than ${MAX_METADATA_BYTES / 1024} KiB`,
        );
      }

      return transactionSync((): McpSignInPut => {
        const existing = getRow(write.key.hash);

        if (existing === undefined && !makeRoom()) return full;

        const grantId = crypto.randomUUID();

        sql.exec(
          `INSERT OR REPLACE INTO mcp_sign_ins (
             key_hash, source, name, url, grant_id, status, issuer, metadata, discovery, resource,
             client_id, client_kind, client_secret_ref, registration, scope, expires_at,
             wanted_scope, step_up_count, challenge, last_error, last_error_at,
             created_at, refreshed_at, used_at, sealed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?)`,
          write.key.hash,
          write.key.source,
          write.key.name,
          write.key.url,
          grantId,
          write.status,
          write.issuer,
          write.metadata,
          write.discovery,
          write.resource,
          write.client?.id ?? null,
          write.client?.kind ?? null,
          write.client?.secretRef === null || write.client === null
            ? null
            : JSON.stringify(write.client.secretRef),
          write.client?.registration ?? null,
          write.scope,
          write.expiresAt,
          write.wantedScope,
          write.stepUpCount,
          now,
          now,
          write.sealed === null ? null : JSON.stringify(write.sealed),
        );
        rise(now);

        return { status: "put", grantId };
      });
    },
    noteChallenge: (key, challenge, now) =>
      transactionSync(() => {
        const existing = getRow(key.hash);

        if (existing === undefined) {
          if (!makeRoom()) return full;

          sql.exec(
            `INSERT INTO mcp_sign_ins (
               key_hash, source, name, url, grant_id, status, challenge, created_at, used_at
             ) VALUES (?, ?, ?, ?, ?, 'required', ?, ?, ?)`,
            key.hash,
            key.source,
            key.name,
            key.url,
            crypto.randomUUID(),
            JSON.stringify(challenge),
            now,
            now,
          );
        } else {
          sql.exec(
            "UPDATE mcp_sign_ins SET challenge = ? WHERE key_hash = ?",
            JSON.stringify(challenge),
            key.hash,
          );
        }

        return { status: "noted" as const };
      }),
    update: (keyHash, update, now) =>
      transactionSync(() => {
        const existing = getRow(keyHash);

        if (existing === undefined) return false;

        const error = update.lastError === undefined ? existing.last_error : update.lastError;

        sql.exec(
          `UPDATE mcp_sign_ins SET status = ?, challenge = ?, wanted_scope = ?, step_up_count = ?,
             last_error = ?, last_error_at = ? WHERE key_hash = ?`,
          update.status ?? existing.status,
          update.challenge === undefined
            ? existing.challenge
            : update.challenge === null
              ? null
              : JSON.stringify(update.challenge),
          update.wantedScope === undefined ? existing.wanted_scope : update.wantedScope,
          update.stepUpCount ?? existing.step_up_count,
          error,
          error === existing.last_error ? existing.last_error_at : error === null ? null : now,
          keyHash,
        );

        return true;
      }),
    replaceTokens: (keyHash, tokens, now) =>
      transactionSync(() => {
        if (getRow(keyHash) === undefined) return false;

        sql.exec(
          `UPDATE mcp_sign_ins SET sealed = ?, expires_at = ?, scope = ?, status = 'ok', last_error = NULL,
             last_error_at = NULL, refreshed_at = ? WHERE key_hash = ?`,
          JSON.stringify(tokens.sealed),
          tokens.expiresAt,
          tokens.scope,
          now,
          keyHash,
        );

        return true;
      }),
    dropTokens: (keyHash, error, now) =>
      transactionSync(() => {
        if (getRow(keyHash) === undefined) return false;

        sql.exec(
          `UPDATE mcp_sign_ins SET sealed = NULL, expires_at = NULL, status = 'required', last_error = ?,
             last_error_at = ? WHERE key_hash = ?`,
          error,
          error === null ? null : now,
          keyHash,
        );
        rise(now);

        return true;
      }),
    touch: (keyHash, now) => {
      sql.exec("UPDATE mcp_sign_ins SET used_at = ? WHERE key_hash = ?", now, keyHash);
    },
    delete: (keyHash, now) =>
      transactionSync(() => {
        if (getRow(keyHash) === undefined) return false;

        sql.exec("DELETE FROM mcp_sign_ins WHERE key_hash = ?", keyHash);
        sql.exec("DELETE FROM mcp_pending_sign_ins WHERE key_hash = ?", keyHash);
        rise(now);

        return true;
      }),

    getRegistration: (key) => {
      const row = one<RegistrationRow>(
        "SELECT * FROM mcp_client_registrations WHERE key_hash = ?",
        key,
      );

      return row === undefined ? null : toRegistration(row);
    },
    putRegistration: (registration) =>
      transactionSync(() => {
        const exists =
          one<{ n: number }>(
            "SELECT COUNT(*) AS n FROM mcp_client_registrations WHERE key_hash = ?",
            registration.key,
          )?.n === 1;

        if (!exists && count("mcp_client_registrations") >= MAX_MCP_REGISTRATIONS) {
          const unreferenced = one<{ key_hash: string }>(
            `SELECT key_hash FROM mcp_client_registrations
             WHERE key_hash NOT IN (SELECT registration FROM mcp_sign_ins WHERE registration IS NOT NULL)
             ORDER BY used_at ASC, registered_at ASC LIMIT 1`,
          );

          if (unreferenced === undefined) return registrationFull;

          sql.exec(
            "DELETE FROM mcp_client_registrations WHERE key_hash = ?",
            unreferenced.key_hash,
          );
        }

        sql.exec(
          `INSERT OR REPLACE INTO mcp_client_registrations (
             key_hash, issuer, redirect_uri, client_name, client_id, client_info, sealed_secret,
             client_secret_expires_at, registered_at, used_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          registration.key,
          registration.issuer,
          registration.redirectUri,
          registration.clientName,
          registration.clientId,
          registration.clientInfo,
          registration.sealedSecret === null ? null : JSON.stringify(registration.sealedSecret),
          registration.clientSecretExpiresAt,
          registration.registeredAt,
          registration.usedAt,
        );

        return { status: "put" as const };
      }),
    deleteRegistration: (key) => {
      const existed =
        one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM mcp_client_registrations WHERE key_hash = ?",
          key,
        )?.n === 1;

      sql.exec("DELETE FROM mcp_client_registrations WHERE key_hash = ?", key);

      return existed;
    },

    getBinding: (keyHash, clientId) => {
      const row = one<BindingRow>(
        "SELECT * FROM mcp_client_bindings WHERE key_hash = ? AND client_id = ?",
        keyHash,
        clientId,
      );

      return row === undefined
        ? null
        : {
            keyHash: row.key_hash,
            clientId: row.client_id,
            issuer: row.issuer,
            boundAt: row.bound_at,
          };
    },
    putBinding: (binding, named) =>
      transactionSync(() => {
        const existing = one<BindingRow>(
          "SELECT * FROM mcp_client_bindings WHERE key_hash = ? AND client_id = ?",
          binding.keyHash,
          binding.clientId,
        );

        if (existing === undefined && count("mcp_client_bindings") >= MAX_MCP_BINDINGS) {
          const unnamed = Arr.findFirst(
            rows<BindingRow>("SELECT * FROM mcp_client_bindings ORDER BY bound_at ASC"),
            (row) => !named(row.key_hash, row.client_id),
          );

          if (Option.isNone(unnamed)) return bindingFull;

          sql.exec(
            "DELETE FROM mcp_client_bindings WHERE key_hash = ? AND client_id = ?",
            unnamed.value.key_hash,
            unnamed.value.client_id,
          );
        }

        sql.exec(
          "INSERT OR REPLACE INTO mcp_client_bindings (key_hash, client_id, issuer, bound_at) VALUES (?, ?, ?, ?)",
          binding.keyHash,
          binding.clientId,
          binding.issuer,
          binding.boundAt,
        );

        const rebound = existing !== undefined && existing.issuer !== binding.issuer;

        if (rebound) rise(binding.boundAt);

        return { status: "put" as const, rebound };
      }),
    dropUnnamedBindings: (named) =>
      transactionSync(() => {
        const unnamed = Arr.filter(
          rows<BindingRow>("SELECT * FROM mcp_client_bindings"),
          (row) => !named(row.key_hash, row.client_id),
        );

        for (const row of unnamed) {
          sql.exec(
            "DELETE FROM mcp_client_bindings WHERE key_hash = ? AND client_id = ?",
            row.key_hash,
            row.client_id,
          );
        }

        return unnamed.length;
      }),

    putPending: (pending) => {
      transactionSync(() => {
        sql.exec("DELETE FROM mcp_pending_sign_ins WHERE expires_at <= ?", pending.createdAt);
        sql.exec(
          `INSERT OR REPLACE INTO mcp_pending_sign_ins (
             key_hash, state_hash, environment, redirect_uri, issuer, metadata, client, sealed_verifier,
             scope, resource, step_up, requester, return_path, awaiting_confirmation, last_error,
             created_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          pending.keyHash,
          pending.stateHash,
          pending.environment,
          pending.redirectUri,
          pending.issuer,
          pending.metadata,
          pending.client,
          JSON.stringify(pending.sealedVerifier),
          pending.scope,
          pending.resource,
          pending.stepUp ? 1 : 0,
          pending.requester,
          pending.returnPath,
          pending.awaitingConfirmation ? 1 : 0,
          pending.lastError,
          pending.createdAt,
          pending.expiresAt,
        );
        sql.exec(
          `DELETE FROM mcp_pending_sign_ins WHERE key_hash IN (
             SELECT key_hash FROM mcp_pending_sign_ins ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
           )`,
          MAX_MCP_PENDING,
        );
      });
    },
    takePending: (hash, now) =>
      transactionSync((): PendingTaken => {
        const row = one<PendingRow>(
          "SELECT * FROM mcp_pending_sign_ins WHERE state_hash = ?",
          hash,
        );

        if (row === undefined) return { status: "none" };

        // The row goes first: a code is used once, whatever the callback finds.
        sql.exec("DELETE FROM mcp_pending_sign_ins WHERE key_hash = ?", row.key_hash);

        if (row.expires_at <= now) return { status: "expired" };

        const pending = toPending(row);

        return pending === null ? { status: "none" } : { status: "found", pending };
      }),
    getPending: (keyHash) => {
      const row = one<PendingRow>("SELECT * FROM mcp_pending_sign_ins WHERE key_hash = ?", keyHash);

      return row === undefined ? null : toPending(row);
    },
    deletePending: (keyHash) => {
      const existed =
        one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM mcp_pending_sign_ins WHERE key_hash = ?",
          keyHash,
        )?.n === 1;

      sql.exec("DELETE FROM mcp_pending_sign_ins WHERE key_hash = ?", keyHash);

      return existed;
    },

    addWaiter: (waiter, now) =>
      transactionSync((): WaiterAdded => {
        sql.exec("DELETE FROM mcp_sign_in_waiters WHERE expires_at <= ?", now);

        const joined = one<{ key_hash: string }>(
          "SELECT key_hash FROM mcp_sign_in_waiters WHERE session = ? AND request = ?",
          waiter.session,
          waiter.request,
        );

        if (joined !== undefined) return { status: "joined" };

        if (count("mcp_sign_in_waiters") >= MAX_MCP_WAITERS) {
          return {
            status: "full",
            message: `At most ${MAX_MCP_WAITERS} Sign-in requests wait at once: the owner answers or declines one first`,
          };
        }

        const first =
          one<{ n: number }>(
            "SELECT COUNT(*) AS n FROM mcp_sign_in_waiters WHERE key_hash = ?",
            waiter.keyHash,
          )?.n === 0;

        sql.exec(
          "INSERT INTO mcp_sign_in_waiters (key_hash, session, request, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
          waiter.keyHash,
          waiter.session,
          waiter.request,
          now,
          now + SIGN_IN_WAITER_TTL_MS,
        );

        return { status: "added", first };
      }),
    waiters: (keyHash, now) =>
      Arr.map(
        rows<WaiterRow>(
          "SELECT * FROM mcp_sign_in_waiters WHERE key_hash = ? AND expires_at > ? ORDER BY id ASC",
          keyHash,
          now,
        ),
        toWaiter,
      ),
    resolveWaiters: (keyHash, now) =>
      transactionSync(() => {
        const open = Arr.map(
          rows<WaiterRow>(
            "SELECT * FROM mcp_sign_in_waiters WHERE key_hash = ? AND expires_at > ? ORDER BY id ASC",
            keyHash,
            now,
          ),
          toWaiter,
        );

        sql.exec("DELETE FROM mcp_sign_in_waiters WHERE key_hash = ?", keyHash);

        return open;
      }),
    removeWaiter: (session, request) => {
      const existed =
        one<{ n: number }>(
          "SELECT COUNT(*) AS n FROM mcp_sign_in_waiters WHERE session = ? AND request = ?",
          session,
          request,
        )?.n === 1;

      sql.exec(
        "DELETE FROM mcp_sign_in_waiters WHERE session = ? AND request = ?",
        session,
        request,
      );

      return existed;
    },
  };
};

const toWaiter = (row: WaiterRow): McpSignInWaiter => ({
  keyHash: row.key_hash,
  session: row.session,
  request: row.request,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});
