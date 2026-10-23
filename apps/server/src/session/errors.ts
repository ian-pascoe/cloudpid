// What the Session host's calls fail with, shared by the modules it is made of.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
