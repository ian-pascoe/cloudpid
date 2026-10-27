// What a Session tells the Registry (`docs/spec.md` → Durable Objects): whether it has a Run in progress, its subagents,
// what the owner should be notified of, and the title it generated.
import { type SessionAgent, SessionStatus } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PushEvent } from "../push/notification.ts";

export { SessionStatus };

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
    /**
     * Tell the Registry the Session's subagents, parents first (ADR-0024). A report that fails or hangs is retried by the
     * host's heartbeat.
     */
    readonly reportAgents: (
      agents: ReadonlyArray<SessionAgent>,
    ) => Effect.Effect<void, ReportError>;
    /** Tell the owner, by Web Push through the Registry, that this Session has something to hear. */
    readonly notify: (event: PushEvent) => Effect.Effect<void, ReportError>;
    /** Whether the Session still lacks a title: it has none, and the owner has not named it. */
    readonly titleWanted: Effect.Effect<boolean, ReportError>;
    /**
     * Offer the title the Session generated. The Registry keeps the owner's title, and an earlier generated one, over it.
     */
    readonly setTitle: (title: string) => Effect.Effect<void, ReportError>;
  }
>()("@cloudpid/server/session/status/SessionRegistry") {}
