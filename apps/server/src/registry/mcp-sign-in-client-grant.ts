// A server that signs in on its own (`docs/architecture/mcp-sign-in.md` → Client Credentials; ADR-0034): the `ClientGrant`
// seam `mcpAccessToken` calls for an HTTP entry whose `oauth.grantType` is `client_credentials`. The Registry gets the
// token itself, with no owner step, and seals it in the sign-in row (kind `client_grant`, no refresh token). It asks for a
// new one at `exp − 60 s`, and once when the server refused the token after its first use (a 401), through the same
// single-flight and the same in-memory backoff as a refresh (`mcp-sign-in-backoff.ts`).
//
// - **Failures are the server's `failed`, never `sign_in`.** There is nobody to sign in, so every failure (a secret that is
//   not set, a key that cannot sign, an authorization server that refuses or does not answer, a token the server then
//   refuses again) is the answer `failed` with a problem, and nothing here makes a status the owner could act on with a
//   sign-in: no `required`, `step_up`, `rejected` or `refresh_failing`. While the token still stands (a renewal that
//   failed in its last minute) it is served as it is.
// - **One renewal after a 401.** A token the server refused is replaced once. The token that replaced it is remembered (its
//   sealed form, in memory) as one fetched after a refusal: refused again, it is handed over as it is, and the host's
//   second 401 is the end. An eviction forgets it, and costs one more request.
// - **Nothing secret leaves.** The client secret, the private key and the assertions exist in this module's memory for one
//   request. No answer, span attribute, log line or row holds one: a reason is the owner-facing text, cut to 300
//   characters and scrubbed of the values the request sent, and the row keeps only the `${NAME}` reference.
// - **What the row holds.** The first token writes the sign-in (a new grant id, kind `client_grant`, the entry's client
//   id and `${NAME}` reference, the issuer, the metadata, the discovery and the resource); a renewal keeps the grant id, so
//   an MCP task's follower can tell "not reachable under the current sign-in" from "expired". A changed client id, pin
//   or `oauth.scope` writes a new sign-in, and the `${NAME}` reference follows the entry on every fetch.
// - **The row is checked before each write**, as a refresh's is: when a sign-in replaced it, or removed it, or the entry
//   no longer signs in on its own, while the request was out, nothing is written and the answer is the row's own token
//   (or `failed` with why).
// - **A switch of kind drops the old row.** An entry that turns from a code sign-in to a client grant has its owner
//   tokens revoked (RFC 7009, best effort: the refresh token, then the access token) and the row deleted before the first
//   token is fetched; the other way round, `mcpAccessToken` deletes the client grant's row (→ `mcp-sign-in-registry.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off preferSchemaOverJson:off
import {
  byteLength,
  discoverOAuthServerInfo,
  type IssuerPin,
  isPinned,
  issuerPinProblem,
  MAX_METADATA_BYTES,
  pemSecrets,
  requestClientCredentials,
  revokeTokens,
  type ClientCredentialsAuth,
  type ClientCredentialsOutcome,
  scrubbed,
  secretAuthMethod,
  selectResource,
  type AuthorizationServerMetadata,
} from "@cloudpid/mcp/oauth";
import type { McpAccessTokenAnswer } from "@cloudpid/mcp/types";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { McpResolvedServer } from "@cloudpid/config";
import type { KeptVault, SealedValue } from "@cloudpid/extensions/secrets/core";
import {
  inMemoryBackoffs,
  outcomeOf,
  reasonOf,
  retryOnce,
  RETRY_MS,
  sameSealed,
  singleFlight,
} from "./mcp-sign-in-backoff.ts";
import {
  attempt,
  clientInformation,
  environmentsUsing,
  type FlowDeps,
  hostOf,
  metadataOf,
  type FlowProblem,
} from "./mcp-sign-in-flow.ts";
import {
  type ClientGrant,
  type ClientGrantRequest,
  mergeScopes,
  MAX_SIGN_IN_ERROR_LENGTH,
  okAnswer,
  REFRESH_MARGIN_MS,
  signInClash,
  signInTarget,
  told,
} from "./mcp-sign-in-registry.ts";
import { type McpTokens, openTokens, sealTokens } from "./mcp-sign-in-seal.ts";
import type { McpSignInRow, McpSignIns } from "./mcp-sign-ins.ts";
import { type OauthSecret, type OauthSecretField, resolveOauthValue } from "./mcp-values.ts";

/** What a client grant needs: the flow's stores, vault, network and `${NAME}` sources, and the pause before a retry. */
export type ClientGrantDeps = Pick<
  FlowDeps,
  "store" | "signIns" | "vault" | "fetch" | "sources"
> & {
  /** Defaults to `RETRY_MS`; a test shortens it. */
  readonly retryMs?: number | undefined;
};

/** What a row recorded of the entry it was fetched for, besides the discovery: a changed pin is a new sign-in. */
const RecordedDiscovery = Schema.Struct({
  authorizationServerUrl: Schema.String,
  resourceMetadata: Schema.optionalKey(
    Schema.Struct({ scopes_supported: Schema.optionalKey(Schema.String.pipe(Schema.Array)) }),
  ),
  grant: Schema.optionalKey(
    Schema.Struct({
      issuer: Schema.optionalKey(Schema.String),
      authServerMetadataUrl: Schema.optionalKey(Schema.String),
    }),
  ),
});

const decodeDiscovery = Schema.decodeUnknownOption(Schema.fromJsonString(RecordedDiscovery));

/** What a fetch trigger was: no token yet (or an entry changed), the last minute of the token, or a refusal. */
type Trigger = "first" | "expiry" | "401";

/** A row that holds a token of this very entry: its tokens open, and its client, scope and pin are the entry's. */
type Standing = {
  readonly row: McpSignInRow;
  readonly tokens: McpTokens;
};

/** The entry's `oauth` as a client grant reads it. */
type GrantEntry = {
  readonly url: string;
  readonly clientId: string;
  readonly issuer: string | undefined;
  readonly authServerMetadataUrl: string | undefined;
  readonly configuredScope: string | null;
  /** How the client proves itself: with `oauth.privateKey` when the entry has one, else `oauth.clientSecret`. */
  readonly credential: OauthSecretField;
  /** `oauth.keyId`, the `kid` of an assertion. */
  readonly keyId: string | undefined;
};

const entryOf = (resolved: McpResolvedServer): GrantEntry | undefined => {
  const { server } = resolved;

  if (server.type !== "http" || server.oauth?.clientId === undefined) return undefined;

  return {
    url: server.url,
    clientId: server.oauth.clientId,
    issuer: server.oauth.issuer,
    authServerMetadataUrl: server.oauth.authServerMetadataUrl,
    configuredScope: mergeScopes(server.oauth.scope),
    credential: server.oauth.privateKey === undefined ? "clientSecret" : "privateKey",
    keyId: server.oauth.keyId,
  };
};

/** Whether the outcome of a request may pass: a network failure, a 408, a 429, a 5xx, or the server saying so. */
const isTransient = (outcome: ClientCredentialsOutcome): boolean =>
  outcome.kind === "failed" ||
  (outcome.kind === "refused" &&
    (outcome.status === 408 ||
      outcome.status === 429 ||
      outcome.status >= 500 ||
      outcome.code === "server_error" ||
      outcome.code === "temporarily_unavailable"));

/** The grant over `deps`: single-flight per sign-in, with its backoff and the tokens' remembered refusals in memory. */
export const mcpClientGrant = (deps: ClientGrantDeps): ClientGrant => {
  const backoffs = inMemoryBackoffs();

  const afterRefusal = new Map<string, SealedValue>();

  /** The answer for a fetch that did not give a token: the old one while it stands, else `failed` with why. */
  const failedAnswer = (
    request: ClientGrantRequest,
    standing: Standing | undefined,
    trigger: Trigger,
    reason: string,
    now: number,
  ): McpAccessTokenAnswer => {
    const { hash } = request.key;
    const kept = told(reason);

    if (standing !== undefined) {
      deps.signIns.update(hash, { lastError: kept }, now);

      const { expiresAt } = standing.row;

      // A token whose renewal failed is used while it stands; one the server refused, or one past its time, is not.
      if (trigger === "expiry" && expiresAt !== null && expiresAt > now) {
        deps.signIns.touch(hash, now);

        return okAnswer(deps.signIns.get(hash) ?? standing.row, standing.tokens, request.key);
      }
    }

    return { status: "failed", reason: kept };
  };

  /** A failure to be tried again no sooner than the backoff says, answered. */
  const backedOff = (
    request: ClientGrantRequest,
    standing: Standing | undefined,
    trigger: Trigger,
    reason: string,
    now: number,
  ): McpAccessTokenAnswer => {
    const { hash } = request.key;
    backoffs.failed(hash, now, told(reason));

    return failedAnswer(request, standing, trigger, reason, now);
  };

  /** The row's token, when it is of this entry: its client, scope and pin are the entry's and its tokens open. */
  const standingOf = (
    request: ClientGrantRequest,
    entry: GrantEntry,
    vault: KeptVault,
  ): Effect.Effect<Standing | undefined> =>
    Effect.gen(function* () {
      const row = deps.signIns.get(request.key.hash);

      if (
        row === null ||
        row.sealed === null ||
        row.client?.kind !== "client_grant" ||
        row.client.id !== entry.clientId ||
        row.wantedScope !== entry.configuredScope
      ) {
        return undefined;
      }

      const recorded = row.discovery === null ? Option.none() : decodeDiscovery(row.discovery);

      if (
        Option.isNone(recorded) ||
        recorded.value.grant?.issuer !== entry.issuer ||
        recorded.value.grant?.authServerMetadataUrl !== entry.authServerMetadataUrl
      ) {
        return undefined;
      }

      const opened = yield* openTokens(vault, request.key.hash, row.sealed).pipe(Effect.result);

      return Result.isFailure(opened) ? undefined : { row, tokens: opened.success };
    });

  /** What the authorization server is, for this fetch: recorded on the row, or discovered anew. */
  type Discovered = {
    readonly metadata: AuthorizationServerMetadata;
    readonly authorizationServerUrl: string;
    readonly resource: string;
    readonly scope: string | undefined;
    /** The text the row records: unset when the row's own was used. */
    readonly discovery: string | undefined;
  };

  const discoverAnew = (
    entry: GrantEntry,
  ): Effect.Effect<Discovered, Pick<FlowProblem, "message"> | { readonly message: string }> =>
    Effect.gen(function* () {
      const serverUrl = new URL(entry.url);

      const options: Types.Mutable<NonNullable<Parameters<typeof discoverOAuthServerInfo>[1]>> = {
        fetch: deps.fetch,
      };

      if (entry.authServerMetadataUrl !== undefined) {
        options.authorizationServerMetadataUrl = new URL(entry.authServerMetadataUrl);
      }

      const info = yield* attempt("The authorization server could not be found", () =>
        discoverOAuthServerInfo(serverUrl, options),
      );

      const metadata = info.authorizationServerMetadata;

      if (metadata === undefined) {
        return yield* Effect.fail({
          message: "The server's authorization server published no metadata",
        });
      }

      const pin: IssuerPin = {
        issuer: entry.issuer,
        metadataIssuer: entry.authServerMetadataUrl === undefined ? undefined : metadata.issuer,
      };

      if (!isPinned(pin)) {
        return yield* Effect.fail({
          message:
            "The entry pins no authorization server: set oauth.issuer or authServerMetadataUrl",
        });
      }

      const pinProblem = issuerPinProblem(pin, metadata.issuer);

      if (pinProblem !== undefined) return yield* Effect.fail({ message: pinProblem });

      const resource = yield* Effect.try({
        try: () => selectResource(serverUrl, info.resourceMetadata),
        catch: (error) => ({
          message:
            error instanceof Error
              ? error.message
              : "The protected resource does not match the server",
        }),
      });

      const supported = info.resourceMetadata?.scopes_supported;

      return {
        metadata,
        authorizationServerUrl: info.authorizationServerUrl,
        resource: resource ?? entry.url,
        scope: entry.configuredScope ?? mergeScopes(supported?.join(" ")) ?? undefined,
        discovery: JSON.stringify({
          authorizationServerUrl: info.authorizationServerUrl,
          resourceMetadata:
            supported === undefined ? undefined : { scopes_supported: [...supported] },
          grant: { issuer: entry.issuer, authServerMetadataUrl: entry.authServerMetadataUrl },
        }),
      } satisfies Discovered;
    });

  /** What the row recorded, as this fetch uses it. */
  const recordedOf = (row: McpSignInRow, entry: GrantEntry): Discovered | undefined => {
    const metadata = row.metadata === null ? Option.none() : metadataOf(row.metadata);
    const recorded = row.discovery === null ? Option.none() : decodeDiscovery(row.discovery);

    if (Option.isNone(metadata) || Option.isNone(recorded)) return undefined;

    return {
      metadata: metadata.value,
      authorizationServerUrl: recorded.value.authorizationServerUrl,
      resource: row.resource ?? entry.url,
      scope:
        entry.configuredScope ??
        mergeScopes(recorded.value.resourceMetadata?.scopes_supported?.join(" ")) ??
        undefined,
      discovery: undefined,
    };
  };

  /** One request, once more after a pause when the first came to something that may pass. */
  const sendWithRetry = (
    send: (at: number) => Promise<ClientCredentialsOutcome>,
  ): Effect.Effect<ClientCredentialsOutcome> =>
    // A new assertion each time, made at the time of the request.
    retryOnce(
      Effect.flatMap(Clock.currentTimeMillis, (at) => Effect.promise(() => send(at))),
      (outcome) => !isTransient(outcome),
      deps.retryMs ?? RETRY_MS,
    );

  /** The text an outcome that was not a token tells the owner. */
  const reasonFor = (
    outcome: Exclude<ClientCredentialsOutcome, { readonly kind: "issued" }>,
  ): string => {
    if (outcome.kind === "problem") return outcome.message;

    if (
      outcome.kind === "refused" &&
      (outcome.code === "invalid_client" || outcome.code === "unauthorized_client")
    ) {
      return `The authorization server does not accept the entry's client id or credentials (${outcome.code}): check its oauth settings`;
    }

    return reasonOf(outcome);
  };

  /**
   * An owner's sign-in under a key whose entry now signs in on its own: its tokens are revoked (RFC 7009, the refresh token
   * then the access token; best effort, a failure is only noted on the span) and the row deleted, so the client grant's
   * first token does not overwrite them unseen. The row is deleted only if it is still the one that was read.
   */
  const retireOwnerSignIn = (
    request: ClientGrantRequest,
    vault: KeptVault,
    row: McpSignInRow,
    now: number,
  ): Effect.Effect<string | undefined> =>
    Effect.gen(function* () {
      const { hash } = request.key;
      const { client, sealed } = row;
      let failure: string | undefined;
      const metadata = row.metadata === null ? Option.none() : metadataOf(row.metadata);

      const opened =
        sealed === null ? undefined : yield* openTokens(vault, hash, sealed).pipe(Effect.result);

      if (opened !== undefined && Result.isSuccess(opened) && Option.isSome(metadata)) {
        yield* Effect.annotateCurrentSpan({ "mcp.issuer_host": hostOf(metadata.value.issuer) });

        // The client as it signed in; a confidential one whose secret is gone revokes as a public client, which the
        // server may refuse.
        const info =
          client === null
            ? undefined
            : yield* clientInformation(deps, vault, request.environment, {
                server: request.server,
                client,
              }).pipe(Effect.orElseSucceed(() => ({ client_id: client.id })));

        const revoked =
          info === undefined
            ? undefined
            : yield* Effect.promise(() =>
                revokeTokens({
                  metadata: metadata.value,
                  client: info,
                  refreshToken: opened.success.refresh_token,
                  accessToken: opened.success.access_token,
                  fetch: deps.fetch,
                }),
              );

        const failed = (revoked ?? []).filter((each) => each.status === "failed");

        yield* outcomeOf(
          revoked === undefined
            ? "no_revocation_endpoint"
            : failed.length === 0
              ? "revoked"
              : "revocation_failed",
        );

        // What failed is said by the kind of token and the status, an OAuth code or the kind of failure: never a token.
        if (failed.length > 0) {
          failure = told(
            `The owner's previous sign-in was dropped, but the authorization server did not revoke its ${failed
              .map(
                (each) =>
                  `${each.token.replace("_", " ")} (${each.status === "failed" ? each.reason : ""})`,
              )
              .join(" and ")}`,
          );
        }
      } else {
        yield* outcomeOf("not_revoked");
        failure =
          "The owner's previous sign-in was dropped without being revoked: its tokens or its authorization server's metadata could not be read";
      }

      // Nothing is awaited between this check and the delete.
      if (sameSealed(deps.signIns.get(hash)?.sealed ?? null, sealed))
        deps.signIns.delete(hash, now);

      // Reported as far as there is somebody to tell: the log, and (below) the new row's last problem. Nothing here fails
      // the fetch.
      if (failure !== undefined) {
        yield* Effect.logWarning(
          `Environment ${request.environment}'s MCP server ${request.key.name}: ${failure}`,
        );
      }

      return failure;
    }).pipe(
      Effect.withSpan("mcp.oauth.revoke", {
        attributes: {
          "mcp.server": request.key.name,
          "mcp.source_kind": request.key.source.startsWith("repo:") ? "repo" : "owner",
          "mcp.client_kind": row.client?.kind ?? "none",
          "mcp.trigger": "switch",
        },
      }),
    );

  /** What a request comes to: the row's token while it serves, else a fetch (the only part that has a span). */
  const run = (
    request: ClientGrantRequest,
    startedAt: number,
  ): Effect.Effect<McpAccessTokenAnswer> =>
    Effect.gen(function* () {
      const { key } = request;
      const { hash } = key;

      const entry = entryOf(request.resolved);

      if (entry === undefined) {
        return { status: "failed", reason: "The entry has no client id" };
      }

      const vault = yield* deps.vault.pipe(Effect.result);

      if (Result.isFailure(vault)) {
        return { status: "unavailable", reason: told(vault.failure.message) };
      }

      // A row of the other kind (an owner's sign-in the entry has turned its back on) is revoked and dropped first, unless
      // another Environment's entry still signs in that way under this key: the two would undo each other for ever.
      const owned = deps.signIns.get(hash);

      let switched: string | undefined;

      if (owned !== null && owned.sealed !== null && owned.client?.kind !== "client_grant") {
        const users = environmentsUsing(deps.store, hash, "owner");

        if (users.length > 0) return { status: "failed", reason: signInClash(users, "owner") };

        switched = yield* retireOwnerSignIn(request, vault.success, owned, startedAt);
      }

      // The row this fetch is about: what it is checked against again just before it writes.
      const baseline = deps.signIns.get(hash);

      const standing = yield* standingOf(request, entry, vault.success);

      let trigger: Trigger = "first";

      if (standing !== undefined) {
        const { row, tokens } = standing;
        const refused = request.stale !== undefined && request.stale === tokens.access_token;
        const expiring = row.expiresAt !== null && row.expiresAt - REFRESH_MARGIN_MS <= startedAt;

        if (!refused && !expiring) {
          deps.signIns.touch(hash, startedAt);

          return okAnswer(row, tokens, key);
        }

        // Refused once already after a refusal: the same token again, which the host's second 401 ends.
        if (refused && !expiring && sameSealed(afterRefusal.get(hash) ?? null, row.sealed)) {
          deps.signIns.touch(hash, startedAt);

          return okAnswer(row, tokens, key);
        }

        trigger = expiring ? "expiry" : "401";
      }

      return yield* fetching({
        request,
        entry,
        vault: vault.success,
        standing,
        baseline,
        trigger,
        startedAt,
        switched,
      });
    });

  /** What changed under a fetch since it began, if anything: the entry, or the row it would write over. */
  const changedMeanwhile = (
    request: ClientGrantRequest,
    entry: GrantEntry,
    baseline: McpSignInRow | null,
  ): "entry" | "row" | undefined => {
    const target = signInTarget(deps.store, request.environment, request.server);

    if (
      target.status !== "client_grant" ||
      JSON.stringify(entryOf(target.resolved)) !== JSON.stringify(entry)
    ) {
      return "entry";
    }

    const current = deps.signIns.get(request.key.hash);

    return sameSealed(current?.sealed ?? null, baseline?.sealed ?? null) &&
      (baseline === null || current?.grantId === baseline.grantId)
      ? undefined
      : "row";
  };

  /** The answer for a fetch whose write was not made, because `changed`: the row's own token, or `failed` with why. */
  const answerChanged = (
    request: ClientGrantRequest,
    vault: KeptVault,
    changed: "entry" | "row",
    now: number,
  ): Effect.Effect<McpAccessTokenAnswer> =>
    Effect.gen(function* () {
      yield* outcomeOf("replaced");

      const { hash } = request.key;
      const current = deps.signIns.get(hash);

      if (changed === "row" && current?.sealed != null && current.client?.kind === "client_grant") {
        const opened = yield* openTokens(vault, hash, current.sealed).pipe(Effect.result);

        if (Result.isSuccess(opened)) {
          deps.signIns.touch(hash, now);

          return okAnswer(current, opened.success, request.key);
        }
      }

      return {
        status: "failed",
        reason:
          changed === "entry"
            ? "The entry changed while its token was being fetched"
            : "The sign-in changed while its token was being fetched",
      } satisfies McpAccessTokenAnswer;
    });

  /** One fetch of a token, for the reason `trigger` says; `standing` is the row's token of this entry, when it has one. */
  const fetching = (input: {
    readonly request: ClientGrantRequest;
    readonly entry: GrantEntry;
    readonly vault: KeptVault;
    readonly standing: Standing | undefined;
    readonly baseline: McpSignInRow | null;
    /** What the revocation of an owner's sign-in this fetch replaced said when it failed. */
    readonly switched: string | undefined;
    readonly trigger: Trigger;
    readonly startedAt: number;
  }): Effect.Effect<McpAccessTokenAnswer> =>
    Effect.gen(function* () {
      const { request, entry, standing, baseline, trigger, startedAt, switched } = input;
      const { key } = request;
      const { hash } = key;

      yield* Effect.annotateCurrentSpan({
        "mcp.server": key.name,
        "mcp.source_kind": key.source.startsWith("repo:") ? "repo" : "owner",
        "mcp.client_kind": "client_grant",
        "mcp.trigger": trigger,
      });

      const held = backoffs.held(hash);

      if (held !== undefined && startedAt < held.retryAt) {
        yield* outcomeOf("backoff");

        return failedAnswer(
          request,
          standing,
          trigger,
          held.reason ?? "The last fetch failed",
          startedAt,
        );
      }

      // The client's credentials, read now from the entry's `${NAME}`: held in this fetch's memory and nowhere else.
      const field = entry.credential;

      const sources = yield* deps
        .sources(request.environment, request.resolved.resolvesSecrets)
        .pipe(Effect.result);

      if (Result.isFailure(sources)) {
        yield* outcomeOf("unavailable");

        return { status: "unavailable", reason: told(sources.failure.message) };
      }

      const credential: OauthSecret = resolveOauthValue(request.resolved, sources.success, field);

      if (credential.status !== "ok") {
        yield* outcomeOf("problem");

        const what = field === "privateKey" ? "private key" : "client secret";

        return failedAnswer(
          request,
          standing,
          trigger,
          credential.status === "missing"
            ? `The ${what} \${${credential.name}} is not set as a Secret or a Variable`
            : `The entry has no ${what}`,
          startedAt,
        );
      }

      const secrets = pemSecrets(credential.value);
      const clean = (text: string) => scrubbed(text, secrets, MAX_SIGN_IN_ERROR_LENGTH);

      // The authorization server: the row's record while its token still stands (a renewal in the last minute, or after
      // a refusal), discovered anew when the token is gone or past its time.
      const stillStands =
        standing !== undefined &&
        (standing.row.expiresAt === null || standing.row.expiresAt > startedAt);

      const recorded =
        standing !== undefined && stillStands ? recordedOf(standing.row, entry) : undefined;

      const discovered =
        recorded === undefined
          ? yield* discoverAnew(entry).pipe(Effect.result)
          : Result.succeed(recorded);

      if (Result.isFailure(discovered)) {
        yield* outcomeOf("discovery_failed");

        return backedOff(request, standing, trigger, clean(discovered.failure.message), startedAt);
      }

      const { metadata, resource, scope } = discovered.success;

      // No `mcp.auth_method` when the server lists no way to send a secret: nothing is sent, and the outcome is `problem`.
      const method = field === "privateKey" ? "private_key_jwt" : secretAuthMethod(metadata);

      yield* Effect.annotateCurrentSpan({ "mcp.issuer_host": hostOf(metadata.issuer) });

      if (method !== undefined) yield* Effect.annotateCurrentSpan({ "mcp.auth_method": method });

      const auth: ClientCredentialsAuth =
        field === "privateKey"
          ? {
              kind: "key",
              clientId: entry.clientId,
              privateKey: credential.value,
              keyId: entry.keyId,
            }
          : { kind: "secret", clientId: entry.clientId, clientSecret: credential.value };

      const began = yield* Clock.currentTimeMillis;
      const elapsed = Effect.map(Clock.currentTimeMillis, (at) => startedAt + (at - began));

      const outcome = yield* sendWithRetry((at) =>
        requestClientCredentials({ metadata, auth, scope, resource, fetch: deps.fetch, now: at }),
      );

      const now = yield* elapsed;

      if (outcome.kind !== "issued") {
        yield* outcomeOf(outcome.kind === "problem" ? "problem" : "failed");

        if (outcome.kind === "refused") {
          yield* Effect.annotateCurrentSpan({
            "http.status_code": outcome.status,
            "mcp.oauth_error": outcome.code,
          });
        }

        const reason = clean(reasonFor(outcome));

        // A setup that cannot work (a key that cannot sign, a method the server does not list) made no request, so there is
        // nothing to back off from; but each ask would discover the authorization server anew, so it is held for the
        // first backoff, which a fixed entry waits out at most.
        if (outcome.kind === "problem") backoffs.hold(hash, now, told(reason));

        return outcome.kind === "problem"
          ? failedAnswer(request, standing, trigger, reason, now)
          : backedOff(request, standing, trigger, reason, now);
      }

      yield* Effect.annotateCurrentSpan({ "http.status_code": outcome.status });

      const sealed = yield* sealTokens(input.vault, hash, {
        access_token: outcome.accessToken,
      }).pipe(Effect.result);

      if (Result.isFailure(sealed)) {
        yield* outcomeOf("unavailable");

        return { status: "unavailable", reason: told(sealed.failure.message) };
      }

      if (sealed.success.status === "too_large") {
        yield* outcomeOf("failed");

        return backedOff(
          request,
          standing,
          trigger,
          "The server's access token is longer than 16 KiB",
          now,
        );
      }

      const { expiresIn } = outcome;
      const recordedScope = outcome.scope ?? scope ?? null;

      const expiresAt =
        expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0
          ? now + expiresIn * 1000
          : null;

      const metadataText = JSON.stringify(metadata);
      const { discovery } = discovered.success;

      if (
        byteLength(metadataText) > MAX_METADATA_BYTES ||
        (discovery !== undefined && byteLength(discovery) > MAX_METADATA_BYTES)
      ) {
        yield* outcomeOf("failed");

        return backedOff(
          request,
          standing,
          trigger,
          "The authorization server's metadata is longer than 64 KiB",
          now,
        );
      }

      // The request was out for a while: a sign-in that replaced or removed the row, or an entry that stopped signing in on
      // its own or changed, means this token is not this row's to write. Nothing is awaited between the check and the write.
      const changed = changedMeanwhile(request, entry, baseline);

      if (changed !== undefined) return yield* answerChanged(request, input.vault, changed, now);

      if (standing === undefined) {
        const put = deps.signIns.put(
          {
            key,
            status: "ok",
            issuer: metadata.issuer,
            metadata: metadataText,
            discovery: discovery ?? "",
            resource,
            client: {
              id: entry.clientId,
              kind: "client_grant",
              secretRef: credential.ref,
              registration: null,
            },
            scope: recordedScope,
            expiresAt,
            wantedScope: entry.configuredScope,
            stepUpCount: 0,
            sealed: sealed.success.sealed,
          },
          now,
        );

        if (put.status === "refused") {
          yield* outcomeOf("refused_by_store");

          return backedOff(request, standing, trigger, put.message, now);
        }

        // A revocation that failed is the new row's last problem, until its first renewal clears it.
        if (switched !== undefined) deps.signIns.update(hash, { lastError: switched }, now);
      } else {
        const renewed: Types.Mutable<Parameters<McpSignIns["replaceTokens"]>[1]> = {
          sealed: sealed.success.sealed,
          expiresAt,
          scope: recordedScope,
          secretRef: credential.ref,
        };

        // Discovered anew with this token: what the row records is updated with it.
        if (discovery !== undefined) {
          renewed.recorded = {
            issuer: metadata.issuer,
            metadata: metadataText,
            discovery,
            resource,
          };
        }

        deps.signIns.replaceTokens(hash, renewed, now);
      }

      backoffs.clear(hash);

      // The token that replaced one the server refused is remembered as such; any other forgets it.
      if (trigger === "401") afterRefusal.set(hash, sealed.success.sealed);
      else afterRefusal.delete(hash);

      yield* outcomeOf("fetched");

      const written = deps.signIns.get(hash);

      if (written === null) return { status: "failed", reason: "The sign-in could not be kept" };

      deps.signIns.touch(hash, now);

      return okAnswer(written, { access_token: outcome.accessToken }, key);
    }).pipe(Effect.withSpan("mcp.oauth.client_credentials"));

  return singleFlight(run);
};
