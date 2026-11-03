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
// - A server that signs in on its own (OAuth Client Credentials, `docs/architecture/mcp-sign-in.md` → Client Credentials)
//   is asked the same way, but there is nobody to sign in: no token (the Registry's `failed`), a 401 that a renewed
//   token does not cure, and a 403 for more scope are all the server's `failed` with a problem, never `sign_in`,
//   `rejected` or `step_up`, and nothing is reported to the Registry. It never connects without a token.
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
//
// A Session's request (`requestAccess`, #452) has the same rules, through the engine's `auth(stale)` hook
// (`engineAuth`) instead of the target's headers: the call's invocation holds the hook, and the engine's connection
// asks it again with `stale` after a 401, retrying once. What the answer says is reported as a discovery's is. A
// request leaves the server's state as it was: the next discovery records it.
// @effect-diagnostics missingPipeableSignature:off -- the discovery's operations, not combinators.
import {
  type McpAuthChallenge,
  type McpAuthEvent,
  type McpEngineDiscoverResult,
  type McpEngineRequestResult,
  type McpEngineHttpTarget,
  type McpServerState,
  type McpSignInNote,
  scopesOf,
  SignInRequired,
} from "@cloudpid/mcp/types";
import { signsInOnItsOwn } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type { McpEngineUnreachable } from "./engine.ts";
import { McpRegistryPort } from "./registry-port.ts";
import type { ServerView } from "./server-state.ts";
import { engineAuth, McpTokens, type NoToken, type TokenAccess, type TokenFor } from "./tokens.ts";

/** An engine's answer to a discovery or a request: what the reports read of it. */
type EngineAnswer = McpEngineDiscoverResult | McpEngineRequestResult;

/**
 * Why a server is left without a token, as the state and message it is left in. `stepUp` (with the `scope` the Registry
 * names) says the sign-in lacks the scope the server wants, and `userSignIn` that the sign-in in the way is the owner's own
 * and cannot be used for now (a refresh that fails): a Session words those two for the agent (`docs/architecture/
 * mcp-sign-in.md` → Sign-in requests). A server that signs in on its own never sets either: no sign-in of the owner's is in
 * the way, and the agent is never pointed at `mcp_sign_in_ask`.
 */
type Blocked = {
  readonly state: McpServerState;
  readonly message: string;
  readonly stepUp?: { readonly scope?: string };
  readonly userSignIn?: boolean;
};

/** What a discovery's access comes to: no call made, or the engine's answer. */
export type DiscoveryAccess =
  | ({ readonly kind: "blocked" } & Blocked)
  | { readonly kind: "answered"; readonly result: McpEngineDiscoverResult };

/** `target` with `token` as its `Authorization: Bearer`. */
const withBearer = (target: McpEngineHttpTarget, token: string): McpEngineHttpTarget => ({
  ...target,
  headers: { ...target.headers, Authorization: `Bearer ${token}` },
});

/**
 * Whether the entry sends an `Authorization` header of its own, which OAuth never replaces (a 401 is then `failed`).
 */
const hasOwnAuthorization = (target: McpEngineHttpTarget): boolean =>
  Arr.some(Record.keys(target.headers ?? {}), (name) => name.toLowerCase() === "authorization");

const isSignInRequired = (result: EngineAnswer): boolean =>
  result.kind === "failed" && Predicate.isTagged(result.error, "SignInRequired");

/** The challenge of the 401 a failed result carries, when it is one and its `WWW-Authenticate` had parameters. */
const signInChallengeOf = (result: EngineAnswer): McpAuthChallenge | undefined =>
  result.kind === "failed" && Predicate.isTagged(result.error, "SignInRequired")
    ? result.error.challenge
    : undefined;

/** What a failed result that is a 403 for more scope asks for: its challenge (with the scope), else just the scope. */
const stepUpOf = (result: EngineAnswer): McpAuthChallenge | undefined => {
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
 * one. A Registry that cannot be asked at all is `unavailable` and no `userSignIn`: it is no problem of the sign-in's.
 */
const blockedBy = (access: NoToken, previous: McpServerState | undefined): Blocked | undefined => {
  if (access.kind === "unreachable") return { state: "unavailable", message: access.message };

  switch (access.status) {
    case "required":
      // A server never signed in to may need none: it is asked, and a 401 says. One that wanted a sign-in waits for
      // one.
      return previous === "sign_in" || previous === "rejected"
        ? { state: previous, message: access.reason }
        : undefined;
    case "step_up":
      return {
        state: "sign_in",
        message: access.reason,
        stepUp: access.scope === undefined ? {} : { scope: access.scope },
      };
    case "rejected":
      return { state: "rejected", message: access.reason };
    case "refresh_failing":
      return {
        state: "unavailable",
        message: `Can't refresh the sign-in: ${access.reason}`,
        userSignIn: true,
      };
    default:
      // `failed` is a client grant's: no sign-in of the owner's is in the way, even where its entry changed mid-call.
      return {
        state: "unavailable",
        message: access.reason,
        userSignIn: access.status === "unavailable",
      };
  }
};

/**
 * Why a server that signs in on its own has no token to connect with: always `failed` or `unavailable`, never a status
 * that sends the owner to a sign-in there is none of.
 */
const blockedClientGrant = (
  access: NoToken,
): { readonly state: McpServerState; readonly message: string } =>
  access.kind === "unreachable" || access.status === "unavailable"
    ? {
        state: "unavailable",
        message: access.kind === "unreachable" ? access.message : access.reason,
      }
    : { state: "failed", message: access.reason };

/** What the server's refusal of a client grant's token says, for the status: the HTTP answer, and its error code. */
const refusalOfClientGrant = (result: EngineAnswer): string | undefined => {
  if (result.kind !== "failed") return undefined;

  if (Predicate.isTagged(result.error, "SignInRequired")) {
    const code = result.error.challenge?.error;

    return `The server refused the access token its client credentials gave (HTTP 401${code === undefined ? "" : `, ${code}`})`;
  }

  if (Predicate.isTagged(result.error, "StepUpRequired")) {
    const scope = stepUpOf(result)?.scope;

    return `The server asks for more access than the client credentials give${scope === undefined ? "" : ` (scope ${scope})`}: set oauth.scope`;
  }

  return undefined;
};

/**
 * A discovery of a server that signs in on its own: its token comes from the Registry, a token the server refuses is
 * renewed once, and whatever the token comes to, no sign-in is asked for or reported.
 */
const clientGrantDiscovery = (
  asked: TokenFor,
  target: McpEngineHttpTarget,
  call: (
    target: McpEngineHttpTarget,
  ) => Effect.Effect<McpEngineDiscoverResult, McpEngineUnreachable>,
) =>
  Effect.gen(function* () {
    const tokens = yield* McpTokens;
    const access = yield* tokens.access(asked);

    if (access.kind !== "token") {
      return { kind: "blocked", ...blockedClientGrant(access) } satisfies DiscoveryAccess;
    }

    const refusedAs = (result: McpEngineDiscoverResult): DiscoveryAccess | undefined => {
      const message = refusalOfClientGrant(result);

      return message === undefined
        ? undefined
        : ({ kind: "blocked", state: "failed", message } satisfies DiscoveryAccess);
    };

    const first = yield* call(withBearer(target, access.token));

    // A 403 for more scope is not cured by a new token; any other answer is the server's.
    if (!isSignInRequired(first)) {
      return refusedAs(first) ?? answered(first);
    }

    // The server refused the token: the Registry fetches another once, and the call is made once more with it.
    const again = yield* tokens.refused({ ...asked, token: access.token });

    if (again.kind !== "token") {
      return { kind: "blocked", ...blockedClientGrant(again) } satisfies DiscoveryAccess;
    }

    // The same token again is what the Registry hands over when it already renewed once after a refusal.
    const second =
      again.token === access.token ? first : yield* call(withBearer(target, again.token));

    return refusedAs(second) ?? answered(second);
  });

/** `result` as what a discovery answers. */
const answered = (result: McpEngineDiscoverResult): DiscoveryAccess => ({
  kind: "answered",
  result,
});

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
  target: McpEngineHttpTarget,
  call: (
    target: McpEngineHttpTarget,
  ) => Effect.Effect<McpEngineDiscoverResult, McpEngineUnreachable>,
) =>
  Effect.gen(function* () {
    const tokens = yield* McpTokens;
    const { name } = view.server;
    const asked: TokenFor = { environment, server: name, url: target.url };

    if (hasOwnAuthorization(target)) return answered(yield* call(target));

    // Nobody signs in to this server: its token is the Registry's to get, and its failures are its own.
    if (signsInOnItsOwn(view.server.server))
      return yield* clientGrantDiscovery(asked, target, call);

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
  result: EngineAnswer,
) =>
  Effect.gen(function* () {
    const wanted = stepUpOf(result);

    if (wanted !== undefined) {
      const pending = note?.status === "step_up" && covers(note.scope, wanted.scope);

      if (!pending) yield* reportAuth(subject, "step_up", wanted);

      return;
    }

    const working =
      // Any answer that is not a failure: a discovery, a result, a task or its state.
      result.kind !== "failed" &&
      (previous === "sign_in" || previous === "rejected" || note?.status === "rejected");

    if (working) yield* reportAuth(subject, "working");
  });

/**
 * What a request to `view`'s server is sent with: `blocked` when there is no token to call with (no call is made, as a
 * discovery would make none), else the `auth` hook to pass the engine (none for a server with no token, or one whose
 * entry sets its own `Authorization`), and what to report once the engine answered.
 */
export type RequestAccess =
  | ({ readonly kind: "blocked" } & Blocked)
  | {
      readonly kind: "open";
      readonly auth?: (stale: boolean) => Effect.Effect<string | undefined>;
      /**
       * For a server that signs in on its own: why the server's refusal of the token (a 401 after the hook's one
       * renewal, or a 403 for more scope) fails the call, as a failure no sign-in answers; undefined for any other
       * answer.
       */
      readonly refusal?: (result: McpEngineRequestResult) => string | undefined;
      readonly answered: (
        result: McpEngineRequestResult,
      ) => Effect.Effect<void, never, McpRegistryPort>;
      /**
       * The MCP sign-in id of the token the request was last given (`mcpAccessToken`'s `signIn`: new with each completed
       * sign-in or step-up, the same through refreshes), which a `tasks/*` result carries; undefined for a server with
       * no sign-in, one whose entry sets its own `Authorization`, or when the last answer gave no token.
       */
      readonly signIn?: () => string | undefined;
    };

/**
 * The access a request to `view`'s server at `target` has (`docs/architecture/mcp-sign-in.md` → Tokens reach the host
 * object), with the rules of `authorizedDiscovery`: a `required` for a server not waiting for a sign-in calls without a
 * token, and a 401 then reports `needs_sign_in`; a token goes through `engineAuth`, whose `stale` ask refreshes it once,
 * and a 401 after that reports `rejected` unless the Registry's note says so already; a 403 for more scope reports
 * `step_up` unless the note names it; and a call that works on a token noted `rejected` reports `working`.
 */
export const requestAccess = (environment: string, view: ServerView, target: McpEngineHttpTarget) =>
  Effect.gen(function* () {
    const tokens = yield* McpTokens;
    const asked: TokenFor = { environment, server: view.server.name, url: target.url };
    const previous = view.state;

    if (hasOwnAuthorization(target)) {
      return { kind: "open", answered: () => Effect.void } satisfies RequestAccess;
    }

    // A server that signs in on its own never calls without a token, and no answer is a sign-in the owner could give.
    if (signsInOnItsOwn(view.server.server)) {
      const own = yield* tokens.access(asked);

      if (own.kind !== "token") {
        return { kind: "blocked", ...blockedClientGrant(own) } satisfies RequestAccess;
      }

      /** The last access the hook handed the engine: a renewal that gave none says why the server's refusal stands. */
      let last: TokenAccess = own;

      return {
        kind: "open",
        auth: engineAuth(tokens, asked, (seen) => {
          last = seen;
        }),
        answered: () => Effect.void,
        signIn: () => (last.kind === "token" ? last.signIn : undefined),
        refusal: (result) => {
          const refused = refusalOfClientGrant(result);

          return refused !== undefined && last.kind !== "token"
            ? blockedClientGrant(last).message
            : refused;
        },
      } satisfies RequestAccess;
    }

    const access = yield* tokens.access(asked);

    if (access.kind !== "token") {
      const blocked = blockedBy(access, previous);

      if (blocked !== undefined) return { kind: "blocked", ...blocked } satisfies RequestAccess;

      return {
        kind: "open",
        answered: (result) =>
          isSignInRequired(result)
            ? reportAuth(asked, "needs_sign_in", signInChallengeOf(result))
            : afterAnswer(asked, previous, undefined, result),
      } satisfies RequestAccess;
    }

    /** The last access the hook handed the engine, and whether the server refused one. */
    let last: TokenAccess = access;
    let refused = false;

    const auth = engineAuth(tokens, asked, (seen, stale) => {
      last = seen;

      if (stale) refused = true;
    });

    return {
      kind: "open",
      auth,
      signIn: () => (last.kind === "token" ? last.signIn : undefined),
      answered: (result) => {
        const note = last.kind === "token" ? last.note : undefined;

        if (!isSignInRequired(result)) return afterAnswer(asked, previous, note, result);

        // Refused again after the refresh (or the same token handed back): a change only if the Registry's note on it
        // is not `rejected` yet. Refused with no token to retry with: the Registry's answer already says why.
        return refused && last.kind === "token" && note?.status !== "rejected"
          ? reportAuth(asked, "rejected", signInChallengeOf(result))
          : Effect.void;
      },
    } satisfies RequestAccess;
  });
