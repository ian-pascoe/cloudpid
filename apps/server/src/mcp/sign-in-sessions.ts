// The main Worker's carry of a completed MCP sign-in to the Sessions whose Sign-in requests it resolved
// (`docs/architecture/mcp-sign-in.md` → Sign-in requests → Learning the outcome): `completeMcpSignIn` answers with the
// requests it resolved (`resolved: [{ session, request }]`, their waiter rows already deleted), the Registry never calls
// out, so the Worker that has the answer tells each Session with its `mcpSignInsResolved({ requests })` RPC. A Session that
// is not reached, or an old deploy that does not know the method, loses nothing for good: it asks the Registry again when
// it resumes and at each request start (`recheck`), and finds the sign-in done. A carry never fails the owner's page; what
// it logs is a Session's id and the failure's tag, never a request's words.
import type { McpResolvedWaiter } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Record from "effect/Record";
import type { SessionMethods } from "../session/Session.ts";

/** How long a Session is waited for: the owner's page does not wait longer for one that is slow or gone. */
export const SESSION_CARRY_TIMEOUT = Duration.seconds(5);

/** The Session objects, by id, as the main Worker reaches them. */
export type McpSignInSessions = {
  readonly session: (id: string) => Pick<SessionMethods, "mcpSignInsResolved">;
};

/** What carries a completed sign-in's resolved requests on to their Sessions. */
export type McpSignInSessionCarry = {
  /** Tell each Session which of its requests resolved. Never fails. */
  readonly carry: (resolved: ReadonlyArray<McpResolvedWaiter>) => Effect.Effect<void>;
};

/** A carry that reaches no Session: for a Worker or a test that has none. */
export const noSignInSessionCarry: McpSignInSessionCarry = { carry: () => Effect.void };

/** The carry over `sessions`. */
export const mcpSignInSessions = (sessions: McpSignInSessions): McpSignInSessionCarry => ({
  carry: (resolved) =>
    Effect.forEach(
      Record.toEntries(Arr.groupBy(resolved, ({ session }) => session)),
      ([session, group]) =>
        sessions
          .session(session)
          .mcpSignInsResolved({ requests: Arr.map(group, ({ request }) => request) })
          .pipe(
            Effect.timeout(SESSION_CARRY_TIMEOUT),
            Effect.asVoid,
            // A Session that does not answer does not hold the callback page: it catches up when it asks again.
            Effect.catchCause((cause) =>
              Effect.logWarning(`Session ${session} was not told of a resolved sign-in`, cause),
            ),
          ),
      { discard: true, concurrency: "unbounded" },
    ),
});
