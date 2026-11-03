// What the Registry answers the `McpHost` about MCP sign-ins (`docs/architecture/mcp-sign-in.md` → Tokens reach the host
// object; ADR-0034): `mcpAccessToken`, which hands a short-lived access token over Durable Object RPC (the host keeps it in
// memory only), `reportMcpAuth`, which records the transitions a host sees, and `signInsRevision`. Only the Registry holds
// tokens at rest. The sign-in is found from the Environment's own MCP server set (its source, normalized name and URL),
// never from what the host says. The Registry never calls out to a host: a refresh is a seam (`Refresh`, filled by
// `mcp-sign-in-refresh.ts` with single-flight, backoff and the authorization server's answers), and what a report
// resolves goes back in the answer.
//
// No answer but `ok` holds a token, and no log line, status or error does: a failure says which row by its hash, and a
// reason is the owner-facing last error (≤300 chars) or what the Registry found.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import {
  mcpSignInKey,
  type McpResolvedServer,
  type McpSignInKey,
  signsInOnItsOwn,
} from "@cloudpid/config";
import type { KeptVault, SecretVaultError } from "@cloudpid/extensions/secrets/core";
import { stepUpScope } from "@cloudpid/mcp/oauth";
import { scopesOf } from "@cloudpid/mcp/types";
import type {
  McpAccessTokenAnswer,
  McpAccessTokenInput,
  McpAuthChallenge,
  McpAuthReport,
  McpAuthReportAnswer,
  McpSignInNote,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import type * as Types from "effect/Types";
import { resolvedServer, type ResolvedServersStore } from "./mcp-registry.ts";
import { type McpSignInRow, type McpSignIns } from "./mcp-sign-ins.ts";
import { openTokens, type McpTokens } from "./mcp-sign-in-seal.ts";

/** A token is asked for again this long before it expires (→ Refresh and step-up). */
export const REFRESH_MARGIN_MS = 60_000;

/** An error kept on a row, and so shown, is cut to this many characters. */
export const MAX_SIGN_IN_ERROR_LENGTH = 300;

/** The sign-in a server of an Environment's set uses, or why it has none. */
export type SignInTarget =
  | {
      readonly status: "target";
      readonly key: McpSignInKey;
      /** `oauth.scope`: what the entry asks for, which a step-up adds to what was granted and challenged. */
      readonly configuredScope: string | undefined;
    }
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "not_applicable"; readonly reason: string }
  /**
   * An HTTP entry with `oauth.grantType: "client_credentials"`: it signs in on its own (→ Client Credentials). It has a
   * sign-in key and a row (kind `client_grant`) but no owner step: nothing starts, completes or signs out of it, and
   * a report or an ask about it is not applicable.
   */
  | {
      readonly status: "client_grant";
      readonly key: McpSignInKey;
      readonly reason: string;
      readonly resolved: McpResolvedServer;
    };

/** Why a server that signs in on its own has no sign-in to start, ask for or sign out of. */
export const CLIENT_GRANT_REASON =
  "The server signs in on its own with client credentials, so there is no sign-in to make";

/**
 * The sign-in `resolved` uses (→ MCP sign-ins, Which servers): OAuth applies only to HTTP entries without an
 * `Authorization` header, and `client_credentials` signs in on its own (`client_grant`, → Client Credentials).
 */
export const signInTargetOf = (resolved: McpResolvedServer): SignInTarget => {
  const entry = resolved.server;

  if (entry.type !== "http") {
    return { status: "not_applicable", reason: "Only an HTTP server signs in with OAuth" };
  }

  if (Arr.some(Record.keys(entry.headers), (name) => name.toLowerCase() === "authorization")) {
    return {
      status: "not_applicable",
      reason: "The entry sends its own Authorization header, so OAuth does not apply",
    };
  }

  const key = mcpSignInKey(resolved);

  if (key === undefined) return { status: "not_applicable", reason: "The server has no URL" };

  if (signsInOnItsOwn(entry)) {
    return { status: "client_grant", key, reason: CLIENT_GRANT_REASON, resolved };
  }

  return { status: "target", key, configuredScope: entry.oauth?.scope };
};

/**
 * Why `mcp_sign_in_ask` answers `not_applicable` at once for the server `target` describes (→ Sign-in requests): a
 * client grant (it signs in on its own: failures are the server's `failed`, never `sign_in`), an entry with an
 * `Authorization` header, a stdio server. Undefined when there is an owner sign-in to ask for, or `target` is `unknown`
 * (which the ask answers as a server that is not there).
 */
export const signInAskNotApplicable = (target: SignInTarget): string | undefined =>
  target.status === "not_applicable" || target.status === "client_grant"
    ? target.reason
    : undefined;

/** The sign-in of `server` in `environment`'s set, or why it has none. */
export const signInTarget = (
  store: ResolvedServersStore,
  environment: string,
  server: string,
): SignInTarget => {
  if (store.getSettingsOverrides(environment) === null) {
    return { status: "unknown", reason: "The Environment is not registered" };
  }

  const resolved = resolvedServer(store, environment, server);

  return resolved === undefined
    ? { status: "unknown", reason: "The server is not in the Environment's MCP set" }
    : signInTargetOf(resolved);
};

/** `text` cut to `limit` characters at a code point, for a row that holds what a server said. */
export const clip = (text: string, limit: number): string => {
  const points = Array.from(text);

  return points.length <= limit ? text : points.slice(0, limit).join("");
};

/** The scopes of space-separated `lists`, once each, in the order they first appear. */
export const mergeScopes = (...lists: ReadonlyArray<string | undefined>): string | null => {
  const scopes = new Set(Arr.flatMap(lists, scopesOf));

  return scopes.size === 0 ? null : [...scopes].join(" ");
};

const sameScopeSet = (left: string, right: string): boolean => {
  const a = new Set(scopesOf(left));
  const b = new Set(scopesOf(right));

  return a.size === b.size && [...a].every((scope) => b.has(scope));
};

/** What a refresh is asked: the sign-in, its open tokens, and why the access token is wanted anew. */
export type RefreshRequest = {
  readonly environment: string;
  /** The server's name as the host spells it, to find the entry a configured client's secret is read from. */
  readonly server: string;
  readonly key: McpSignInKey;
  readonly row: McpSignInRow;
  readonly tokens: McpTokens;
  /** `expiry`: the token is in its last minute; `401`: the server just refused it. */
  readonly trigger: "expiry" | "401";
};

/** What a refresh answers: the token to use, or why there is none (`mcp-sign-in-refresh.ts`). */
export type Refresh = (request: RefreshRequest, now: number) => Effect.Effect<McpAccessTokenAnswer>;

/** Without a refresh, a token past its time is not served and nothing reaches an authorization server. */
const NO_REFRESH: Refresh = () =>
  Effect.succeed({
    status: "unavailable",
    reason: "Refreshing a sign-in's tokens is not available in this build",
  });

/** What a client grant is asked: the server that signs in on its own, and the token it just had refused, if any. */
export type ClientGrantRequest = {
  readonly environment: string;
  /** The server's name as the host spells it. */
  readonly server: string;
  readonly key: McpSignInKey;
  readonly resolved: McpResolvedServer;
  /** The access token a request just carried and the server refused with a 401. */
  readonly stale?: string | undefined;
};

/**
 * What a client grant answers: the token to use, or `failed` with why (`mcp-client-grant.ts`). It gets a token on first
 * use and again at `exp − 60 s` or after a 401; there is no refresh token and no owner.
 */
export type ClientGrant = (
  request: ClientGrantRequest,
  now: number,
) => Effect.Effect<McpAccessTokenAnswer>;

/** What `mcpAccessToken` reads and writes. */
export type SignInDeps = {
  readonly store: ResolvedServersStore;
  readonly signIns: McpSignIns;
  /** The `mcp-oauth` vault, derived once: it fails while `SECRETS_ENCRYPTION_KEY` is malformed. */
  readonly vault: Effect.Effect<KeptVault, SecretVaultError>;
  readonly refresh?: Refresh | undefined;
  readonly clientGrant?: ClientGrant | undefined;
};

const unavailable = (reason: string): McpAccessTokenAnswer => ({ status: "unavailable", reason });

/**
 * The host's `mcpAccessToken({ environment, server, stale? })` (→ Tokens reach the host object): `ok` with the token, when
 * the server's sign-in holds one that stands for at least a minute and was not just refused; else a refresh (`Refresh`);
 * else why not. A sign-in whose status is `step_up`, `rejected` or `refresh_failing` still serves its token, with a `note`.
 * Under a malformed `SECRETS_ENCRYPTION_KEY` every answer is `unavailable` with the reason, rows kept unopened; a row that
 * does not open under a well-formed key counts as `required`.
 */
export const mcpAccessToken = (
  deps: SignInDeps,
  input: McpAccessTokenInput,
  now: number,
): Effect.Effect<McpAccessTokenAnswer> => {
  const target = signInTarget(deps.store, input.environment, input.server);

  if (target.status === "client_grant") {
    return deps.clientGrant === undefined
      ? Effect.succeed(unavailable("Client credentials are not available in this build"))
      : deps.clientGrant(
          {
            environment: input.environment,
            server: input.server,
            key: target.key,
            resolved: target.resolved,
            stale: input.stale,
          },
          now,
        );
  }

  if (target.status !== "target") return Effect.succeed(unavailable(target.reason));

  return deps.vault.pipe(
    Effect.matchEffect({
      onFailure: (error) => Effect.succeed(unavailable(error.message)),
      onSuccess: (vault) => answerFor(deps, vault, target.key, input, now),
    }),
  );
};

/** The answer for the sign-in `key`, whose tokens `vault` opens. */
const answerFor = (
  deps: SignInDeps,
  vault: KeptVault,
  key: McpSignInKey,
  input: McpAccessTokenInput,
  now: number,
): Effect.Effect<McpAccessTokenAnswer> => {
  const row = deps.signIns.get(key.hash);

  if (row === null || row.sealed === null) {
    return Effect.succeed({ status: "required", reason: row?.lastError ?? "Not signed in" });
  }

  // The token of a client grant, under a key whose entry now signs in with a code: not a sign-in of this entry's.
  if (row.client?.kind === "client_grant") {
    return Effect.succeed({ status: "required", reason: "Not signed in" });
  }

  return openTokens(vault, key.hash, row.sealed).pipe(
    Effect.matchEffect({
      onFailure: () =>
        Effect.logWarning(
          `The MCP sign-in ${key.hash} does not open: its tokens are not served`,
        ).pipe(
          Effect.as<McpAccessTokenAnswer>({
            status: "required",
            reason: "The kept sign-in cannot be opened: sign in again",
          }),
        ),
      onSuccess: (held) => {
        // A rejected token drives no further refresh on a 401: calls still try it (→ Refresh and step-up). A pending
        // step-up stays `step_up` when its token is rejected, with the error kept: that is the marker.
        const refused = input.stale !== undefined && input.stale === held.access_token;

        const tokenRejected =
          row.status === "rejected" || (row.status === "step_up" && row.lastError !== null);

        const mustRefresh = refused && !tokenRejected;
        // The token is asked for again from a minute before it expires (`REFRESH_MARGIN_MS`); the last minute's token is
        // never served as it is: a refresh is asked for it (`Refresh`), or it is withheld when there is no refresh token.
        const expiring = row.expiresAt !== null && row.expiresAt - REFRESH_MARGIN_MS <= now;

        if (!mustRefresh && !expiring) {
          deps.signIns.touch(key.hash, now);

          return Effect.succeed(okAnswer(row, held, key));
        }

        if (held.refresh_token === undefined) {
          const reason = "The sign-in expired and has no refresh token: sign in again";

          // A token past its time with nothing to refresh it is gone: the row says `required` too, so Settings does not
          // show it as signed in. A token in its last minute, or one the server refused, is withheld but kept: a token
          // that has a refresh token is refreshed (→ Refresh and step-up).
          if (row.expiresAt !== null && row.expiresAt <= now) {
            deps.signIns.dropTokens(key.hash, reason, now);
          }

          return Effect.succeed<McpAccessTokenAnswer>({ status: "required", reason });
        }

        return (deps.refresh ?? NO_REFRESH)(
          {
            environment: input.environment,
            server: input.server,
            key,
            row,
            tokens: held,
            trigger: expiring ? "expiry" : "401",
          },
          now,
        );
      },
    }),
  );
};

/** The `ok` answer for `row`'s `tokens`. */
export const okAnswer = (
  row: McpSignInRow,
  tokens: McpTokens,
  key: McpSignInKey,
): McpAccessTokenAnswer => {
  const base = {
    status: "ok" as const,
    token: tokens.access_token,
    resource: row.resource ?? key.url,
    signIn: row.grantId,
  };

  const timed = row.expiresAt === null ? base : { ...base, expiresAt: row.expiresAt };

  if (row.status === "ok" || row.status === "required") return timed;

  const note: Types.Mutable<McpSignInNote> = { status: row.status };

  if (row.lastError !== null) note.reason = row.lastError;

  if (row.status === "step_up" && row.wantedScope !== null) note.scope = row.wantedScope;

  return { ...timed, note };
};

const ignored = (reason: string): McpAuthReportAnswer => ({ status: "ignored", reason });

/** A challenge as it is kept: each part cut to what a row may hold. */
const keptChallenge = (challenge: McpAuthChallenge | undefined): McpAuthChallenge => {
  const kept: Types.Mutable<McpAuthChallenge> = {};

  if (challenge?.resourceMetadataUrl !== undefined) {
    kept.resourceMetadataUrl = clip(challenge.resourceMetadataUrl, 2048);
  }

  if (challenge?.scope !== undefined) kept.scope = clip(challenge.scope, 1024);

  if (challenge?.error !== undefined) kept.error = clip(challenge.error, 64);

  if (challenge?.errorDescription !== undefined) {
    kept.errorDescription = clip(challenge.errorDescription, MAX_SIGN_IN_ERROR_LENGTH);
  }

  return kept;
};

/**
 * The host's `reportMcpAuth({ environment, server, event, challenge? })`, on transitions only (→ Tokens reach the host
 * object, Reports and pushes):
 *
 * - `needs_sign_in`: the challenge is remembered on a row with no tokens, so a start discovers from it;
 * - `step_up`: the status becomes `step_up` and the wanted scope granted ∪ challenged ∪ configured. The count rises when
 *   the owner completed a step-up and the server then challenges for the very scope set that step-up wanted (3 end
 *   `mcp_sign_in_ask` with `step_up_failed`); a challenge while a step-up is still pending counts nothing;
 * - `rejected`: the status becomes `rejected`, the challenge's error and description kept; the tokens are kept. A
 *   pending step-up stays `step_up` (the error is kept);
 * - `working`: the status clears, and the open Sign-in requests of the key are resolved and returned. A pending step-up
 *   is not cleared, and its requests stay open: calls that work are no sign-in with the wider scope.
 *
 * The answer is `recorded` (with the Sign-in requests a `working` report resolved) or `ignored` with why: a server that
 * is not in the set or does not sign in, no sign-in to change, a full store, or an event this build does not know.
 */
export const reportMcpAuth = (
  deps: Pick<SignInDeps, "store" | "signIns">,
  report: McpAuthReport,
  now: number,
): McpAuthReportAnswer => {
  const target = signInTarget(deps.store, report.environment, report.server);

  if (target.status !== "target") return ignored(target.reason);

  const { signIns } = deps;
  const { hash } = target.key;
  const row = signIns.get(hash);
  const challenge = keptChallenge(report.challenge);

  switch (report.event) {
    case "needs_sign_in": {
      const noted = signIns.noteChallenge(target.key, challenge, now);

      return noted.status === "refused"
        ? ignored(noted.message)
        : { status: "recorded", resolved: [] };
    }

    case "step_up": {
      if (row === null || !row.hasTokens) return ignored("There is no sign-in to step up");

      const wanted = mergeScopes(
        stepUpScope(row.scope ?? undefined, challenge.scope),
        row.scope ?? undefined,
        target.configuredScope,
      );

      // While a step-up is pending the owner has completed none since the last report, so a challenge for the same scope
      // set counts nothing. Otherwise one was completed (a completed step-up leaves `wantedScope` as it was wanted), and
      // this challenge counts when it asks for the same scope set again. A different scope set starts the count again.
      const pending = row.status === "step_up";

      const same =
        row.wantedScope !== null && wanted !== null && sameScopeSet(row.wantedScope, wanted);

      signIns.update(
        hash,
        {
          status: "step_up",
          challenge,
          wantedScope: wanted,
          stepUpCount: !same ? 0 : pending ? row.stepUpCount : row.stepUpCount + 1,
        },
        now,
      );

      return { status: "recorded", resolved: [] };
    }

    case "rejected": {
      if (row === null || !row.hasTokens) return ignored("There is no sign-in the server refused");

      signIns.update(
        hash,
        {
          status: row.status === "step_up" ? "step_up" : "rejected",
          challenge,
          lastError: clip(
            challenge.errorDescription ?? challenge.error ?? "The server refused the access token",
            MAX_SIGN_IN_ERROR_LENGTH,
          ),
        },
        now,
      );

      return { status: "recorded", resolved: [] };
    }

    case "working": {
      // Calls that work with the old scope are no answer to a step-up: it stays, with its requests, until the owner signs in.
      if (row?.status === "step_up") return { status: "recorded", resolved: [] };

      if (row !== null && row.hasTokens && (row.status !== "ok" || row.lastError !== null)) {
        signIns.update(hash, { status: "ok", challenge: null, lastError: null }, now);
      }

      const resolved = signIns.resolveWaiters(hash, now);

      return {
        status: "recorded",
        resolved: Arr.map(resolved, ({ session, request }) => ({ session, request })),
      };
    }

    default:
      return ignored("The event is not one this build knows");
  }
};
