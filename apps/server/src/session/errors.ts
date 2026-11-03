// What the Session host's calls fail with, shared by the modules it is made of.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** The `operation` of a `SessionError` for a conversation the Session does not have (a cursor of another Session names one). */
export const CONVERSATION_MISSING = "conversation_missing";

/**
 * The `operation` of the `SessionError` a message fails with when Stop withdrew it before it was placed
 * (docs/architecture/mcp-in-a-session.md → Getting a prompt at send). Not a failure: the owner pressed Stop.
 */
export const WITHDRAWN = "withdrawn";

/** A Harness or Durable Object storage call failed. */
export class SessionError extends Schema.TaggedError<
  SessionError,
  { readonly brand: unique symbol }
>()("SessionError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

/** Run `run`, failing with a `SessionError` of `operation` when it rejects. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a constructor of Effects, called directly.
export const attempt = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, SessionError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => SessionError.make({ operation, message: String(cause) }),
  });

/** A failure the owner is told about, with why. */
export const refuse = (message: string): SessionError =>
  SessionError.make({ operation: "command", message });

/** The failure of a message Stop withdrew before it was placed: nothing was sent. */
export const withdrawnFailure = (): SessionError =>
  SessionError.make({
    operation: WITHDRAWN,
    message: "Stopped before it was sent: nothing was sent, so send it again.",
  });

/**
 * Whether `error` says Stop withdrew the message. Not a type guard: callers hold errors of several kinds (`SessionError`
 * and others), and narrowing them to `SessionError` would make their other branches `never`. It takes anything tagged.
 */
export const isWithdrawn = (error: { readonly _tag: string }): boolean =>
  Schema.is(SessionError)(error) && error.operation === WITHDRAWN;
