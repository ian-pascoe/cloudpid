// What the Registry answers the `McpHost` about MCP sign-ins (`docs/architecture/mcp-sign-in.md` → Tokens reach the host
// object; ADR-0034): `mcpAccessToken`, which hands a short-lived access token over Durable Object RPC (the host keeps it in
// memory only), `reportMcpAuth`, which records the transitions a host sees, and `signInsRevision`. Only the Registry holds
// tokens at rest. The sign-in is found from the Environment's own MCP server set (its source, normalized name and URL),
// never from what the host says. The Registry never calls out: a refresh is a seam (`Refresh`, #454), and what a report
// resolves goes back in the answer.
//
// No answer but `ok` holds a token, and no log line, status or error does: a failure says which row by its hash, and a
// reason is the owner-facing last error (≤300 chars) or what the Registry found.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import { mcpSignInKey, type McpSignInKey, resolveMcpServerSet } from "@cloudpid/config";
import type { KeptVault, SecretVaultError } from "@cloudpid/extensions/secrets/core";
import { stepUpScope } from "@cloudpid/mcp/oauth";
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
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import type * as Types from "effect/Types";
import { type McpSignInRow, type McpSignIns } from "./mcp-sign-ins.ts";
import { openTokens, type McpTokens } from "./mcp-sign-in-seal.ts";
import { type DocumentStore, savedGlobalSettings } from "./settings.ts";
import type { RegistryStore } from "./store.ts";

/** A token is asked for again this long before it expires (→ Refresh and step-up). */
export const REFRESH_MARGIN_MS = 60_000;

/** An error kept on a row, and so shown, is cut to this many characters. */
export const MAX_SIGN_IN_ERROR_LENGTH = 300;

/** The store as the sign-in is found from the Environment's set: Global's document and the Environment's Overrides. */
export type SignInTargetStore = DocumentStore & Pick<RegistryStore, "getSettingsOverrides">;

/** The sign-in a server of an Environment's set uses, or why it has none. */
export type SignInTarget =
  | {
      readonly status: "target";
      readonly key: McpSignInKey;
      /** `oauth.scope`: what the entry asks for, which a step-up adds to what was granted and challenged. */
      readonly configuredScope: string | undefined;
    }
  | { readonly status: "unknown"; readonly reason: string }
  | { readonly status: "not_applicable"; readonly reason: string };

/**
 * The sign-in of `server` in `environment`'s set (→ MCP sign-ins, Which servers): OAuth applies only to HTTP entries
 * without an `Authorization` header, and `client_credentials` signs in on its own (not built here yet).
 */
export const signInTarget = (
  store: SignInTargetStore,
  environment: string,
  server: string,
): SignInTarget => {
  const overrides = store.getSettingsOverrides(environment);

  if (overrides === null) return { status: "unknown", reason: "The Environment is not registered" };

  const found = Arr.findFirst(
    resolveMcpServerSet(savedGlobalSettings(store), overrides, []).servers,
    (resolved) => resolved.name === server,
  );

  if (Option.isNone(found)) {
    return { status: "unknown", reason: "The server is not in the Environment's MCP set" };
  }

  const resolved = found.value;
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

  if (entry.oauth?.grantType === "client_credentials") {
    return {
      status: "not_applicable",
      reason: "The client credentials grant is not supported yet",
    };
  }

  const key = mcpSignInKey(resolved);

  return key === undefined
    ? { status: "not_applicable", reason: "The server has no URL" }
    : { status: "target", key, configuredScope: entry.oauth?.scope };
};

/** `text` cut to `limit` characters at a code point, for a row that holds what a server said. */
export const clip = (text: string, limit: number): string => {
  const points = Array.from(text);

  return points.length <= limit ? text : points.slice(0, limit).join("");
};

/** The scopes of space-separated `lists`, once each, in the order they first appear. */
const mergeScopes = (...lists: ReadonlyArray<string | undefined>): string | null => {
  const scopes = new Set(
    Arr.flatMap(lists, (list) => (list ?? "").split(/\s+/).filter((s) => s !== "")),
  );

  return scopes.size === 0 ? null : [...scopes].join(" ");
};

const sameScopeSet = (left: string, right: string): boolean => {
  const a = new Set(left.split(/\s+/).filter((s) => s !== ""));
  const b = new Set(right.split(/\s+/).filter((s) => s !== ""));

  return a.size === b.size && [...a].every((scope) => b.has(scope));
};

/** What a refresh answers: the token to use, or why there is none. The seam #454 fills. */
export type Refresh = (
  row: McpSignInRow,
  tokens: McpTokens,
  trigger: "expiry" | "401",
) => Effect.Effect<McpAccessTokenAnswer>;

/** Until a refresh is built, a token past its time is not served and nothing reaches an authorization server. */
const NO_REFRESH: Refresh = () =>
  Effect.succeed({
    status: "unavailable",
    reason: "Refreshing a sign-in's tokens is not available in this build",
  });

/** What `mcpAccessToken` reads and writes. */
export type SignInDeps = {
  readonly store: SignInTargetStore;
  readonly signIns: McpSignIns;
  /** The `mcp-oauth` vault, derived once: it fails while `SECRETS_ENCRYPTION_KEY` is malformed. */
  readonly vault: Effect.Effect<KeptVault, SecretVaultError>;
  readonly refresh?: Refresh | undefined;
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
        // A `rejected` token drives no further refresh on a 401: calls still try it (→ Refresh and step-up).
        const refused = input.stale !== undefined && input.stale === held.access_token;
        const mustRefresh = refused && row.status !== "rejected";
        const expiring = row.expiresAt !== null && row.expiresAt - REFRESH_MARGIN_MS <= now;

        if (!mustRefresh && !expiring) {
          deps.signIns.touch(key.hash, now);

          return Effect.succeed(okAnswer(row, held, key));
        }

        if (held.refresh_token === undefined) {
          return Effect.succeed<McpAccessTokenAnswer>({
            status: "required",
            reason: "The sign-in expired and has no refresh token: sign in again",
          });
        }

        return (deps.refresh ?? NO_REFRESH)(row, held, expiring ? "expiry" : "401");
      },
    }),
  );
};

/** The `ok` answer for `row`'s `tokens`. */
const okAnswer = (
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
 * - `step_up`: the status becomes `step_up` and the wanted scope granted ∪ challenged ∪ configured; a step-up challenged
 *   again for the scope set that was already stepped up counts (3 end `mcp_sign_in_ask` with `step_up_failed`);
 * - `rejected`: the status becomes `rejected`, the challenge's error and description kept; the tokens are kept;
 * - `working`: the status clears, and the open Sign-in requests of the key are resolved and returned.
 *
 * A server that is not in the set, or does not sign in, or an event this build does not know, is ignored with why.
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

      const again =
        row.status !== "step_up" &&
        row.wantedScope !== null &&
        wanted !== null &&
        sameScopeSet(row.wantedScope, wanted);

      signIns.update(
        hash,
        {
          status: "step_up",
          challenge,
          wantedScope: wanted,
          stepUpCount: again ? row.stepUpCount + 1 : row.status === "step_up" ? row.stepUpCount : 0,
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
          status: "rejected",
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
