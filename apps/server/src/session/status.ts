// What a Session tells the Registry (`docs/spec.md` → Durable Objects): whether it has a Run in progress.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Whether a Session has a Run in progress. */
export const SessionStatus = Schema.Literals(["idle", "running"]);

export type SessionStatus = typeof SessionStatus.Type;

/** A status report could not be made. */
export class ReportError extends Schema.TaggedError<
  ReportError,
  { readonly brand: unique symbol }
>()("ReportError", { message: Schema.String }) {}

/**
 * The Registry, as the Session host sees it. The Session DO provides it from the Registry DO and its own name; a test
 * provides its own.
 */
export class SessionRegistry extends Context.Service<
  SessionRegistry,
  {
    /** Tell the Registry the Session is `status`. A report that fails or hangs is retried by the host's heartbeat. */
    readonly report: (status: SessionStatus) => Effect.Effect<void, ReportError>;
  }
>()("@cloudpid/server/session/status/SessionRegistry") {}
