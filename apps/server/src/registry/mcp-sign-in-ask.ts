// What the Registry answers a Session about a Sign-in request (`docs/architecture/mcp-sign-in.md` → Sign-in requests;
// ADR-0034): `mcpSignInAsk`, which decides from the sign-in as it stands whether there is anything to ask the owner, and
// keeps the Session's waiter row (`mcp_sign_in_waiters`, bounded at 100, each living 30 days) when there is, and
// `mcpSignInWithdraw`, which drops one. The Registry never calls out: when a sign-in completes, the main Worker carries the
// answer's `resolved` on to the Sessions (`mcp/sign-in-sessions.ts`); a Session that was not reached, or was on an older
// deploy, asks again when it resumes, which is the backstop.
//
// Asking is idempotent per (Session, request): the same pair joins the waiter it already has, so a resume re-checks the
// sign-in without a second waiter or a second Notification. No answer holds a token.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import type {
  McpAccessTokenAnswer,
  McpSignInAskAnswer,
  McpSignInAskInput,
  McpSignInWithdrawInput,
} from "@cloudpid/mcp/types";
import { scopesOf } from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";
import { resolvedServer } from "./mcp-registry.ts";
import { hostOf } from "./mcp-sign-in-flow.ts";
import {
  clip,
  MAX_SIGN_IN_ERROR_LENGTH,
  mcpAccessToken,
  signInAskNotApplicable,
  type SignInDeps,
  signInTarget,
} from "./mcp-sign-in-registry.ts";

/** How many completed step-ups, each challenged again for the same scope set, end the ask with `step_up_failed`. */
export const STEP_UP_LIMIT = 3;

/** Why an ask is open: the sign-in state that stands in the way. */
type Why = "required" | "step_up" | "rejected" | "refresh_failing";

type Standing =
  | { readonly kind: "signed_in" }
  | { readonly kind: "open"; readonly why: Why; readonly reason?: string; readonly scope?: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/** The open standing of a sign-in that is `why`, with the reason and scope its answer gave. */
const openOf = (why: Why, reason: string | undefined, scope: string | undefined): Standing => {
  const open: Types.Mutable<Extract<Standing, { kind: "open" }>> = { kind: "open", why };

  if (reason !== undefined) open.reason = reason;

  if (scope !== undefined) open.scope = scope;

  return open;
};

/** What an access answer says of whether the sign-in stands, and why not. */
const standingOf = (access: McpAccessTokenAnswer): Standing => {
  switch (access.status) {
    case "ok": {
      const note = "note" in access ? access.note : undefined;

      return note?.status === "step_up" || note?.status === "rejected"
        ? openOf(note.status, note.reason, note.scope)
        : { kind: "signed_in" };
    }

    case "required":
    case "step_up":
    case "rejected":
    case "refresh_failing":
      return openOf(
        access.status,
        "reason" in access ? access.reason : undefined,
        "scope" in access ? access.scope : undefined,
      );
    case "unavailable":
    case "failed":
      return {
        kind: "unavailable",
        reason: "reason" in access ? access.reason : "The sign-in is not available",
      };
    default:
      return { kind: "unavailable", reason: "The sign-in is in a state this build does not know" };
  }
};

/**
 * The Session's `mcpSignInAsk` (→ Sign-in requests): `signed_in` when the sign-in stands (the Session's waiter, if it had
 * one, is dropped), `not_applicable` for a client grant, an `Authorization` header or a stdio server, `step_up_failed`
 * after `STEP_UP_LIMIT` completed step-ups challenged again for the same scope set, and otherwise `open` with the waiter
 * kept and what the card shows. The token is asked of `mcpAccessToken`, so a refresh the sign-in is due runs here too.
 */
export const askMcpSignIn = (
  deps: SignInDeps,
  input: McpSignInAskInput,
  now: number,
): Effect.Effect<McpSignInAskAnswer> =>
  Effect.gen(function* () {
    const ended = (answer: McpSignInAskAnswer): McpSignInAskAnswer => {
      deps.signIns.removeWaiter(input.session, input.request);

      return answer;
    };

    const target = signInTarget(deps.store, input.environment, input.server);

    if (target.status === "unknown") {
      return ended({ status: "unavailable", reason: target.reason });
    }

    if (target.status !== "target") {
      return ended({
        status: "not_applicable",
        reason: signInAskNotApplicable(target) ?? "The server has no sign-in to ask for",
      });
    }

    const access = yield* mcpAccessToken(
      deps,
      { environment: input.environment, server: input.server },
      now,
    );

    const standing = standingOf(access);

    if (standing.kind === "signed_in") return ended({ status: "signed_in" });

    if (standing.kind === "unavailable") {
      return ended({
        status: "unavailable",
        reason: clip(standing.reason, MAX_SIGN_IN_ERROR_LENGTH),
      });
    }

    const row = deps.signIns.get(target.key.hash);

    const scopes = scopesOf(
      standing.scope ?? (standing.why === "step_up" ? (row?.wantedScope ?? undefined) : undefined),
    );

    if (standing.why === "step_up" && row !== null && row.stepUpCount >= STEP_UP_LIMIT) {
      return ended({
        status: "step_up_failed",
        reason: `The server asked for more access ${String(STEP_UP_LIMIT)} times and still wants it after each sign-in`,
        scopes,
      });
    }

    const added = deps.signIns.addWaiter(
      { keyHash: target.key.hash, session: input.session, request: input.request },
      now,
    );

    if (added.status === "full") return { status: "full", message: added.message };

    const resolved = resolvedServer(deps.store, input.environment, input.server);
    const source = resolved?.source;
    const oauth = resolved?.server.type === "http" ? resolved.server.oauth : undefined;
    const issuer = row?.issuer ?? oauth?.issuer ?? oauth?.authServerMetadataUrl;

    // `required` says only that nobody has signed in, which the card's heading already does.
    const problem =
      (standing.why === "required" ? undefined : standing.reason) ?? row?.lastError ?? undefined;

    const answer: Types.Mutable<Extract<McpSignInAskAnswer, { status: "open" }>> = {
      status: "open",
      first: added.status === "added" && added.first,
      key: target.key.hash,
      why: standing.why,
      scopes,
      source:
        source === undefined
          ? { kind: "environment" }
          : source.kind === "repo"
            ? { kind: "repo", slug: source.slug }
            : { kind: source.kind },
      urlHost: hostOf(target.key.url),
    };

    if (issuer !== undefined && issuer !== null) answer.issuerHost = hostOf(issuer);

    if (problem !== undefined) answer.problem = clip(problem, MAX_SIGN_IN_ERROR_LENGTH);

    return answer;
  });

/** The Session's `mcpSignInWithdraw`: its request ended (declined or withdrawn), so its waiter goes. */
export const withdrawMcpSignIn = (
  deps: Pick<SignInDeps, "signIns">,
  input: McpSignInWithdrawInput,
) => ({ removed: deps.signIns.removeWaiter(input.session, input.request) });
