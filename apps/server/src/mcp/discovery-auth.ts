// A discovery's token (`docs/architecture/mcp-sign-in.md` → Tokens reach the host object, Reports and pushes;
// `docs/architecture/mcp-connections.md` → Tokens and 401/403 at the connection): before it connects an OAuth-capable
// HTTP server the host asks `McpTokens` (the Registry's `mcpAccessToken`), and passes the token in the target's
// `Authorization` header. A background discovery has no `auth` hook (a function stub does not outlive its invocation,
// #409), so a token the server refuses gets one more engine call, with a token asked for with `stale`.
//
// - `required` with the server at `sign_in` or `rejected`: no network call, and the state stays. Any other `required`
//   (a server never signed in to, or one that may need no sign-in) connects without a token, and a 401 makes it
//   `sign_in`.
// - `step_up` and `rejected` with no token that stands, and `refresh_failing` and `unavailable`: no network call, and
//   the server is `sign_in`, `rejected` or `unavailable` with the reason.
// - A 401 with no token is reported `needs_sign_in`; with a token, asked again with `stale`, and a second 401 is
//   reported `rejected` (the sign-in keeps its tokens). A 403 for more scope is reported `step_up` with the wanted
//   scope. A server that works after being `sign_in` or `rejected`, or on a token whose note says `rejected`, is
//   reported `working`.
//
// Reports are on transitions of the Registry's own status of the sign-in, and best effort: the Registry that cannot be
// asked leaves them to the next discovery. The Registry's note on the token it handed over says what it already
// knows: a `rejected` is not sent when the note says `rejected`, and a `step_up` not when the note names the step-up
// for every scope the challenge asks for. The host's own state is not the test of a `rejected` or a `step_up`, since a
// report that was lost, or a new sign-in refused again, leaves the Registry behind the host; the next discovery
// sends it again. A `working` is sent when the server was waiting for a sign-in (`sign_in` or `rejected`) or the
// token's note says `rejected`; a note of `refresh_failing` is left, since the server works on a token that stands
// while the refresh still fails, and the refresh's own success is what clears it. A report carries the challenge of
// the 401 or 403 (`resource_metadata`, `scope`, `error`, `error_description`) so the Registry can keep it. No token is
// logged, put on a span, or kept anywhere but the cache of `McpTokens` and the one call's target.
// @effect-diagnostics missingPipeableSignature:off -- the discovery's operations, not combinators.
import {
  type McpAuthChallenge,
  type McpAuthEvent,
  type McpEngineDiscoverResult,
  type McpEngineTarget,
  type McpServerState,
  type McpSignInNote,
  scopesOf,
  SignInRequired,
} from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type { McpEngineUnreachable } from "./engine.ts";
import { McpRegistryPort } from "./registry-port.ts";
import type { ServerView } from "./server-state.ts";
import { McpTokens, type NoToken, type TokenFor } from "./tokens.ts";

/** What a discovery's access comes to: no call made, or the engine's answer. */
export type DiscoveryAccess =
  | { readonly kind: "blocked"; readonly state: McpServerState; readonly message: string }
  | { readonly kind: "answered"; readonly result: McpEngineDiscoverResult };

/** `target` with `token` as its `Authorization: Bearer`. */
const withBearer = (target: McpEngineTarget, token: string): McpEngineTarget => ({
  ...target,
  headers: { ...target.headers, Authorization: `Bearer ${token}` },
});

/**
 * Whether the entry sends an `Authorization` header of its own, which OAuth never replaces (a 401 is then `failed`).
 */
const hasOwnAuthorization = (target: McpEngineTarget): boolean =>
  Arr.some(Record.keys(target.headers ?? {}), (name) => name.toLowerCase() === "authorization");

const isSignInRequired = (result: McpEngineDiscoverResult): boolean =>
  result.kind === "failed" && Predicate.isTagged(result.error, "SignInRequired");

/** The challenge of the 401 a failed result carries, when it is one and its `WWW-Authenticate` had parameters. */
const signInChallengeOf = (result: McpEngineDiscoverResult): McpAuthChallenge | undefined =>
  result.kind === "failed" && Predicate.isTagged(result.error, "SignInRequired")
    ? result.error.challenge
    : undefined;

/** What a failed result that is a 403 for more scope asks for: its challenge (with the scope), else just the scope. */
const stepUpOf = (result: McpEngineDiscoverResult): McpAuthChallenge | undefined => {
  if (result.kind !== "failed" || !Predicate.isTagged(result.error, "StepUpRequired")) {
    return undefined;
  }

  if (result.error.challenge !== undefined) return result.error.challenge;

  return result.error.scope === undefined ? {} : { scope: result.error.scope };
};

/** A failed 401 as the server refusing the token it was sent: the state is `rejected`, whatever the core could tell. */
const asRejected = (result: McpEngineDiscoverResult): McpEngineDiscoverResult =>
  result.kind === "failed" && Predicate.isTagged(result.error, "SignInRequired")
    ? {
        ...result,
        error: SignInRequired.make({ message: result.error.message, rejected: true }),
      }
    : result;

/**
 * Why there is no token to connect with, as the state and message the server is left in; undefined to connect without
 * one.
 */
const blockedBy = (
  access: NoToken,
  previous: McpServerState | undefined,
): { readonly state: McpServerState; readonly message: string } | undefined => {
  if (access.kind === "unreachable") return { state: "unavailable", message: access.message };

  switch (access.status) {
    case "required":
      // A server never signed in to may need none: it is asked, and a 401 says. One that wanted a sign-in waits for
      // one.
      return previous === "sign_in" || previous === "rejected"
        ? { state: previous, message: access.reason }
        : undefined;
    case "step_up":
      return { state: "sign_in", message: access.reason };
    case "rejected":
      return { state: "rejected", message: access.reason };
    case "refresh_failing":
      return { state: "unavailable", message: `Can't refresh the sign-in: ${access.reason}` };
    default:
      return { state: "unavailable", message: access.reason };
  }
};

/** The server a report is about. */
type Subject = Pick<TokenFor, "environment" | "server">;

/** The Registry told, best effort: a failure is logged without anything of the report. */
const reportAuth = (subject: Subject, event: McpAuthEvent, challenge?: McpAuthChallenge) =>
  Effect.gen(function* () {
    const registry = yield* McpRegistryPort;

    const { environment, server } = subject;

    yield* registry.reportAuth(
      challenge === undefined
        ? { environment, server, event }
        : { environment, server, event, challenge },
    );
  }).pipe(
    Effect.catchCause(() =>
      Effect.logWarning(
        `Environment ${subject.environment}'s MCP sign-in report for ${subject.server} was not taken`,
      ),
    ),
  );

/**
 * Runs `call` (one engine discovery of `target`) with the access `view`'s server has. `previous` is the state the
 * server was in before this discovery. Returns `blocked` when no call was made.
 */
export const authorizedDiscovery = (
  environment: string,
  view: ServerView,
  previous: McpServerState | undefined,
  target: McpEngineTarget,
  call: (target: McpEngineTarget) => Effect.Effect<McpEngineDiscoverResult, McpEngineUnreachable>,
) =>
  Effect.gen(function* () {
    const tokens = yield* McpTokens;
    const { name } = view.server;
    const asked: TokenFor = { environment, server: name, url: target.url };

    const answered = (result: McpEngineDiscoverResult): DiscoveryAccess => ({
      kind: "answered",
      result,
    });

    if (hasOwnAuthorization(target)) return answered(yield* call(target));

    const access = yield* tokens.access(asked);

    if (access.kind !== "token") {
      const blocked = blockedBy(access, previous);

      if (blocked !== undefined) return { kind: "blocked", ...blocked } satisfies DiscoveryAccess;

      const result = yield* call(target);

      // Not at `sign_in` or `rejected` here: those are blocked above, so this 401 is a change.
      if (isSignInRequired(result)) {
        yield* reportAuth(asked, "needs_sign_in", signInChallengeOf(result));
      }

      yield* afterAnswer(asked, previous, undefined, result);

      return answered(result);
    }

    const first = yield* call(withBearer(target, access.token));

    if (!isSignInRequired(first)) {
      yield* afterAnswer(asked, previous, access.note, first);

      return answered(first);
    }

    // The server refused the token: the Registry refreshes it (or hands over what another host's refresh made), and the
    // call is made once more with the token it gives.
    const again = yield* tokens.refused({ ...asked, token: access.token });

    if (again.kind !== "token") {
      const blocked = blockedBy(again, previous);

      return {
        kind: "blocked",
        ...(blocked ?? {
          state: "sign_in",
          message: again.kind === "none" ? again.reason : again.message,
        }),
      } satisfies DiscoveryAccess;
    }

    // The same token again is what a rejected sign-in hands over (calls still try it): the second refusal is certain.
    const second =
      again.token === access.token ? first : yield* call(withBearer(target, again.token));

    if (isSignInRequired(second)) {
      // Only a change is reported: a sign-in the Registry has as `rejected` already is not. The host's own state is not the
      // test (a lost report, or a new sign-in refused again, leaves the Registry at `ok`).
      if (again.note?.status !== "rejected") {
        yield* reportAuth(asked, "rejected", signInChallengeOf(second));
      }

      return answered(asRejected(second));
    }

    yield* afterAnswer(asked, previous, again.note, second);

    return answered(second);
  });

/**
 * Whether the scope the Registry wants for a pending step-up (`held`: what was granted, challenged and configured) has
 * every scope this challenge asks for, so the Registry already knows of it.
 */
const covers = (held: string | undefined, challenged: string | undefined): boolean => {
  const have = new Set(scopesOf(held));

  return Arr.every(scopesOf(challenged), (scope) => have.has(scope));
};

/**
 * What an answer that is not a 401 says to the Registry: a server that works again, or one that wants more scope
 * (unless the Registry's own note on the token already names that step-up for the same scope). `note` is the
 * Registry's, on the token the call was made with.
 */
const afterAnswer = (
  subject: Subject,
  previous: McpServerState | undefined,
  note: McpSignInNote | undefined,
  result: McpEngineDiscoverResult,
) =>
  Effect.gen(function* () {
    const wanted = stepUpOf(result);

    if (wanted !== undefined) {
      const pending = note?.status === "step_up" && covers(note.scope, wanted.scope);

      if (!pending) yield* reportAuth(subject, "step_up", wanted);

      return;
    }

    const working =
      result.kind === "discovered" &&
      (previous === "sign_in" || previous === "rejected" || note?.status === "rejected");

    if (working) yield* reportAuth(subject, "working");
  });
