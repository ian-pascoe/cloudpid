// Refreshing an MCP sign-in's tokens, in the Registry (`docs/architecture/mcp-sign-in.md` → Refresh and step-up,
// Telemetry and redaction; ADR-0034): the `Refresh` seam `mcpAccessToken` calls when the access token is at `exp − 60
// s`, or the host's request was refused with it by a 401.
//
// - **Single-flight per sign-in** (`singleFlight` in `mcp-sign-in-backoff.ts`, with the retry and the backoff, which a client
//   grant shares). A Durable Object's input gate opens on `fetch`, so a second refresh racing with the
//   same rotating refresh token would get `invalid_grant`: callers that arrive while one is in flight wait for it and
//   share its answer. A refresh once sent is never cancelled (its region is uninterruptible), and one an eviction cuts
//   short may have lost a rotated refresh token, which the owner mends by signing in again.
// - **The row is read again, and checked before each write.** A caller reads the row and opens its tokens before it
//   joins a flight, and a refresh takes a while: another refresh may have stored rotated tokens, or the owner may have
//   completed a sign-in or a step-up, in between. The flight reads the row again when it starts, and again before it
//   writes anything (the new tokens, the failing status, a drop): when the sealed tokens are no longer the ones the flight
//   asked about, nothing is written and the answer is the row's current token. So an old grant's tokens and scope never
//   overwrite a new grant's, and an old refresh token's `invalid_grant` never drops them.
// - **What the authorization server's answer means.** `invalid_grant` and `invalid_scope` drop the tokens (`required`);
//   `invalid_client` and `unauthorized_client` do for a registered client (with its registration) and a configured one
//   (the reason names the problem) but are transient for a document client, whose id is a URL the server may fail to
//   fetch. Network errors, the 15 s timeout, 408, 429, 5xx, `server_error`, `temporarily_unavailable` and any code this
//   build does not know are transient too, since dropping a grant on an answer nobody described would lose more than it
//   saves.
// - **Transient failures** retry once after a second, then leave the status `refresh_failing` with the reason; the next
//   attempt waits a backoff of 10 s that doubles up to 5 min and resets on success (held in memory: an evicted Registry
//   tries again at the next ask). The tokens are kept, and the access token is served while it still stands.
// - **What a response keeps.** A new refresh token replaces the old one, else the old one stays, and so does the scope;
//   `expires_in` is trusted from each response.
//
// No token, code or secret is logged or put on a span: the span `mcp.oauth.refresh` says the server, the source kind,
// the issuer host, the client kind, the trigger, the outcome, the OAuth error code, the HTTP status, whether the
// refresh token rotated and the scope. A reason kept on the row is the owner-facing text, cut to 300 characters.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off asyncFunction:off
import {
  type AuthorizationServerMetadata,
  OAuthError,
  type OAuthTokens,
  refreshAuthorization,
} from "@cloudpid/mcp/oauth";
import type { McpAccessTokenAnswer } from "@cloudpid/mcp/types";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as Types from "effect/Types";
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
  clientInformation,
  errorCodeOf,
  type FlowDeps,
  hostOf,
  metadataOf,
  told,
} from "./mcp-sign-in-flow.ts";
import {
  clip,
  MAX_SIGN_IN_ERROR_LENGTH,
  okAnswer,
  REFRESH_MARGIN_MS,
  type Refresh,
  type RefreshRequest,
} from "./mcp-sign-in-registry.ts";
import type { KeptVault } from "@cloudpid/extensions/secrets/core";
import { type McpTokens, openTokens, sealTokens } from "./mcp-sign-in-seal.ts";
import type { ClientKind } from "./mcp-sign-ins.ts";

/** What a refresh needs: the flow's stores, vault, network and `${NAME}` sources, and the pause before a retry. */
export type RefreshDeps = Pick<FlowDeps, "store" | "signIns" | "vault" | "fetch" | "sources"> & {
  /** Defaults to `RETRY_MS`; a test shortens it. */
  readonly retryMs?: number | undefined;
};

/** What one request to the token endpoint came to. */
type Outcome =
  | { readonly kind: "issued"; readonly tokens: OAuthTokens; readonly status: number | undefined }
  | {
      readonly kind: "refused";
      /** The OAuth error code, as a plain token of at most 64 characters. */
      readonly code: string;
      readonly message: string;
      readonly status: number | undefined;
    }
  | { readonly kind: "failed"; readonly message: string; readonly status: number | undefined };

/** `invalid_client` and `unauthorized_client`: the server does not accept the client. */
const isClientRefused = (code: string): boolean =>
  code === "invalid_client" || code === "unauthorized_client";

/** The answers that settle it: a retry a second later would get the same. */
const isFinal = (outcome: Outcome, client: ClientKind): boolean =>
  outcome.kind === "issued" ||
  (outcome.kind === "refused" &&
    (outcome.code === "invalid_grant" ||
      outcome.code === "invalid_scope" ||
      (isClientRefused(outcome.code) && client !== "document")));

/**
 * Whether the token of the request still stands at `now`: only for a refresh the expiry asked for, never a refused
 * token.
 */
const stands = (asked: RefreshRequest, now: number): boolean =>
  asked.trigger === "expiry" && asked.row.expiresAt !== null && asked.row.expiresAt > now;

/** What a send is made from. */
type Send = {
  readonly issuer: string;
  readonly metadata: AuthorizationServerMetadata;
  readonly info: { readonly client_id: string; readonly client_secret?: string };
  readonly refreshToken: string;
  readonly resource: string | null;
};

/** One request to the token endpoint through `fetch`; never rejects, the answer says what happened. */
const send = async (deps: Pick<RefreshDeps, "fetch">, input: Send): Promise<Outcome> => {
  const seen = new Map<"status", number>();

  const options: Types.Mutable<Parameters<typeof refreshAuthorization>[1]> = {
    metadata: input.metadata,
    clientInformation: input.info,
    refreshToken: input.refreshToken,
    fetch: async (url, init) => {
      const response = await deps.fetch(url, init);

      seen.set("status", response.status);

      return response;
    },
  };

  if (input.resource !== null) options.resource = input.resource;

  try {
    const tokens = await refreshAuthorization(input.issuer, options);

    return { kind: "issued", tokens, status: seen.get("status") };
  } catch (error) {
    if (error instanceof OAuthError) {
      return {
        kind: "refused",
        code: errorCodeOf(error.code),
        message: error.message,
        status: seen.get("status"),
      };
    }

    return {
      kind: "failed",
      message: error instanceof Error ? error.message : "The authorization server did not answer",
      status: seen.get("status"),
    };
  }
};

/** The refresh over `deps`: single-flight per sign-in, with its backoff in memory. */
export const mcpTokenRefresh = (deps: RefreshDeps): Refresh => {
  const backoffs = inMemoryBackoffs();

  /** The answer for a refresh that did not give a new token: the old while it stands (with its note), else why not. */
  const withoutNewToken = (
    asked: RefreshRequest,
    reason: string,
    now: number,
  ): McpAccessTokenAnswer => {
    if (!stands(asked, now)) return { status: "refresh_failing", reason };

    deps.signIns.touch(asked.key.hash, now);

    return okAnswer(deps.signIns.get(asked.key.hash) ?? asked.row, asked.tokens, asked.key);
  };

  /**
   * A refresh that failed in a way that may pass: the status `refresh_failing` (a pending step-up keeps its own) and
   * the backoff.
   */
  const answerFailing = (
    asked: RefreshRequest,
    reason: string,
    now: number,
  ): McpAccessTokenAnswer => {
    const { hash } = asked.key;
    backoffs.failed(hash, now);

    // A pending step-up keeps its status, and its error, which marks its token as rejected.
    if ((deps.signIns.get(hash) ?? asked.row).status !== "step_up") {
      deps.signIns.update(hash, { status: "refresh_failing", lastError: told(reason) }, now);
    }

    return withoutNewToken(asked, told(reason), now);
  };

  /** The tokens are no use any more: dropped, `required`, with the reason. */
  const answerDropped = (
    asked: RefreshRequest,
    reason: string,
    now: number,
  ): McpAccessTokenAnswer => {
    const kept = clip(reason, MAX_SIGN_IN_ERROR_LENGTH);

    deps.signIns.dropTokens(asked.key.hash, kept, now);
    backoffs.clear(asked.key.hash);

    return { status: "required", reason: kept };
  };

  const sendWithRetry = (input: Send, client: ClientKind): Effect.Effect<Outcome> =>
    retryOnce(
      Effect.promise(() => send(deps, input)),
      (outcome) => isFinal(outcome, client),
      deps.retryMs ?? RETRY_MS,
    );

  /**
   * The tokens are no use any more: the span says why (`outcome`), the row drops them, and the answer is `required`.
   */
  const dropAs = (
    asked: RefreshRequest,
    reason: string,
    now: number,
    outcome = "dropped",
  ): Effect.Effect<McpAccessTokenAnswer> =>
    Effect.as(outcomeOf(outcome), answerDropped(asked, reason, now));

  /**
   * What a response with tokens comes to: they are sealed and kept, and the new access token is the answer. A token
   * that is not a Bearer one, or does not seal, leaves the old tokens as they were.
   */
  const issuedAnswer = (
    asked: RefreshRequest,
    vault: KeptVault,
    issued: OAuthTokens,
    now: number,
  ): Effect.Effect<McpAccessTokenAnswer> =>
    Effect.gen(function* () {
      const { key, row, tokens } = asked;
      const { hash } = key;

      if (issued.token_type.toLowerCase() !== "bearer") {
        yield* outcomeOf("failing");

        return answerFailing(
          asked,
          `The server issued a ${clip(issued.token_type, 32)} token, not a Bearer one`,
          now,
        );
      }

      const refreshToken = issued.refresh_token ?? tokens.refresh_token;

      const next: McpTokens =
        refreshToken === undefined
          ? { access_token: issued.access_token }
          : { access_token: issued.access_token, refresh_token: refreshToken };

      const sealed = yield* sealTokens(vault, hash, next).pipe(Effect.result);

      if (Result.isFailure(sealed)) {
        yield* outcomeOf("unavailable");

        return { status: "unavailable", reason: told(sealed.failure.message) };
      }

      if (sealed.success.status === "too_large") {
        return yield* dropAs(
          asked,
          `The server's ${sealed.success.token === "access_token" ? "access" : "refresh"} token is longer than 16 KiB`,
          now,
        );
      }

      // Sealing took a moment: the sign-in may have been replaced meanwhile, and then these tokens are the old grant's.
      const replaced = yield* changedSince(asked, vault, now);

      if (replaced !== undefined) return replaced;

      const expiresIn = issued.expires_in;
      const scope = issued.scope ?? row.scope;

      deps.signIns.replaceTokens(
        hash,
        {
          sealed: sealed.success.sealed,
          expiresAt:
            expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0
              ? now + expiresIn * 1000
              : null,
          scope,
        },
        now,
      );
      backoffs.clear(hash);
      deps.signIns.touch(hash, now);

      yield* Effect.annotateCurrentSpan({
        "mcp.outcome": "refreshed",
        "mcp.rotated": next.refresh_token !== tokens.refresh_token,
        "mcp.scope": clip(scope ?? "", 256),
      });

      return okAnswer(deps.signIns.get(hash) ?? row, next, key);
    });

  /**
   * `asked` as the row holds it now: when another refresh replaced the tokens after `asked` was made, a late caller's
   * refresh token would be refused and its `invalid_grant` would drop the fresh tokens, so the request is made again
   * from the row. Fails with the answer when the row no longer has tokens that open.
   */
  const current = (
    asked: RefreshRequest,
    vault: KeptVault,
  ): Effect.Effect<RefreshRequest, McpAccessTokenAnswer> =>
    Effect.gen(function* () {
      const row = deps.signIns.get(asked.key.hash);

      if (row === null || row.sealed === null) {
        yield* outcomeOf("gone");

        return yield* Effect.fail<McpAccessTokenAnswer>({
          status: "required",
          reason: row?.lastError ?? "Not signed in",
        });
      }

      if (sameSealed(row.sealed, asked.row.sealed)) return asked;

      const opened = yield* openTokens(vault, asked.key.hash, row.sealed).pipe(Effect.result);

      if (Result.isFailure(opened)) {
        yield* outcomeOf("gone");

        return yield* Effect.fail<McpAccessTokenAnswer>({
          status: "required",
          reason: "The kept sign-in cannot be opened: sign in again",
        });
      }

      return { ...asked, row, tokens: opened.success };
    });

  /**
   * Whether the sign-in still holds the tokens `asked` is about, checked just before a write: when it does not (a refresh
   * or the owner's own sign-in replaced them while this flight was out) there is nothing to write, and the answer is the
   * row's current token, or `required` when it has none any more. Undefined when the write may go on. Nothing is awaited
   * between a check that finds the row unchanged and the write that follows it, so the check is not out of date.
   */
  const changedSince = (
    asked: RefreshRequest,
    vault: KeptVault,
    at: number,
  ): Effect.Effect<McpAccessTokenAnswer | undefined> =>
    Effect.gen(function* () {
      const reread = yield* current(asked, vault).pipe(Effect.result);

      if (Result.isFailure(reread)) return reread.failure;

      if (reread.success === asked) return undefined;

      yield* outcomeOf("replaced");
      deps.signIns.touch(asked.key.hash, at);

      return okAnswer(reread.success.row, reread.success.tokens, reread.success.key);
    });

  const run = (first: RefreshRequest, startedAt: number): Effect.Effect<McpAccessTokenAnswer> =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "mcp.server": first.key.name,
        "mcp.source_kind": first.key.source.startsWith("repo:") ? "repo" : "owner",
        "mcp.issuer_host": first.row.issuer === null ? "" : hostOf(first.row.issuer),
        "mcp.client_kind": first.row.client?.kind ?? "none",
        "mcp.trigger": first.trigger,
        "mcp.step_up": first.row.status === "step_up",
      });

      // Time as the caller counts it (`startedAt`) plus what this refresh has taken since.
      const began = yield* Clock.currentTimeMillis;
      const elapsed = Effect.map(Clock.currentTimeMillis, (at) => startedAt + (at - began));

      const held = backoffs.held(first.key.hash);

      if (held !== undefined && startedAt < held.retryAt) {
        yield* outcomeOf("backoff");

        return withoutNewToken(first, first.row.lastError ?? "The last refresh failed", startedAt);
      }

      const vault = yield* deps.vault.pipe(Effect.result);

      if (Result.isFailure(vault)) {
        yield* outcomeOf("unavailable");

        return { status: "unavailable", reason: vault.failure.message };
      }

      // The caller read the row before the flight it joined was clear: another refresh may have replaced its tokens
      // since.
      const reread = yield* current(first, vault.success).pipe(Effect.result);

      if (Result.isFailure(reread)) return reread.failure;

      const asked = reread.success;

      // Tokens another refresh made are fresh: served as they are, with no request to the authorization server.
      if (
        asked !== first &&
        (asked.row.expiresAt === null || asked.row.expiresAt - REFRESH_MARGIN_MS > startedAt)
      ) {
        yield* outcomeOf("replaced");
        deps.signIns.touch(asked.key.hash, startedAt);

        return okAnswer(asked.row, asked.tokens, asked.key);
      }

      const { row, tokens, environment, server } = asked;

      const metadata = row.metadata === null ? Option.none() : metadataOf(row.metadata);

      if (row.client === null || row.issuer === null || Option.isNone(metadata)) {
        return yield* dropAs(
          asked,
          "The recorded sign-in cannot be read: sign in again",
          startedAt,
        );
      }

      const { client } = row;

      const info = yield* clientInformation(deps, vault.success, environment, {
        server,
        client,
      }).pipe(Effect.result);

      if (Result.isFailure(info)) {
        const problem = info.failure;

        // The keys that do not open, or a secret that resolves to nothing for now, leave the tokens as they are.
        if (problem.code === "vault" || problem.code === "secret_missing") {
          yield* outcomeOf(problem.code);

          return { status: "unavailable", reason: told(problem.message) };
        }

        const replaced = yield* changedSince(asked, vault.success, startedAt);

        return (
          replaced ?? (yield* dropAs(asked, problem.message, startedAt, problem.code ?? "gone"))
        );
      }

      const outcome = yield* sendWithRetry(
        {
          issuer: row.issuer,
          metadata: metadata.value,
          info: info.success,
          // `refresh_token` is there: a sign-in without one never reaches a refresh (`mcpAccessToken`).
          refreshToken: tokens.refresh_token ?? "",
          resource: row.resource,
        },
        client.kind,
      );

      yield* Effect.annotateCurrentSpan({ "http.status_code": outcome.status });

      const now = yield* elapsed;

      // The request was out for a while: whatever it came to, it is about the tokens it was sent with, and is written
      // only if the row still holds them.
      const replaced = yield* changedSince(asked, vault.success, now);

      if (replaced !== undefined) return replaced;

      if (outcome.kind === "issued")
        return yield* issuedAnswer(asked, vault.success, outcome.tokens, now);

      if (outcome.kind === "refused") {
        yield* Effect.annotateCurrentSpan({ "mcp.oauth_error": outcome.code });

        if (outcome.code === "invalid_grant" || outcome.code === "invalid_scope") {
          return yield* dropAs(
            asked,
            `The authorization server no longer accepts the sign-in (${outcome.code}): sign in again`,
            now,
          );
        }

        if (isClientRefused(outcome.code) && client.kind === "registered") {
          if (client.registration !== null) deps.signIns.deleteRegistration(client.registration);

          return yield* dropAs(
            asked,
            `The authorization server no longer knows the client registered for cloudpid (${outcome.code}): sign in again`,
            now,
          );
        }

        if (isClientRefused(outcome.code) && client.kind === "configured") {
          return yield* dropAs(
            asked,
            `The authorization server does not accept the entry's client id or secret (${outcome.code}): check its oauth settings, then sign in again`,
            now,
          );
        }
      }

      // Everything else is transient, a document client's `invalid_client` and a code nobody described included.
      yield* outcomeOf("failing");

      return answerFailing(asked, reasonOf(outcome), now);
    }).pipe(Effect.withSpan("mcp.oauth.refresh"));

  return singleFlight(run);
};
