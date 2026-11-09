// Who an Agent change is recorded as, where the Session's services make it (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Shared definitions and the core/wrapper split: No Session; → The recorded author): a
// service is built with an author source, a Session's (`{kind: "session", id}`: the Session the Registry lists, or none
// for one it does not, which then changes nothing) or the endpoint's (`{kind: "endpoint", via, request?}`: the verified
// caller, and the `request_id` claim the write records in its own transaction), and `registryAuthor` makes the Registry's
// author of it and of what the tool knows (the tool, the reason, the conversation, an Approval). The same services thus
// serve a Session and the main Worker's `api` target (`../harness/services.ts`); `authored` is how each of them asks for
// the Registry's author, refusing a change from a Session the Registry does not list.
// @effect-diagnostics missingPipeableSignature:off
import type { ChangeAuthor } from "@cloudpid/extensions/environment";
import type { AgentChangeVia } from "@cloudpid/protocol";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import type { AgentChangeAuthor } from "../registry/agent-changes.ts";
import type { ChangeClaim } from "../registry/change-requests.ts";

/** Where a change is made from: a Session, or the MCP endpoint with no Session. */
export type AuthorSource =
  | {
      readonly kind: "session";
      /** The Session's id in the Registry; undefined when unknown, for a Session that then changes nothing. */
      readonly id: string | undefined;
    }
  | {
      readonly kind: "endpoint";
      /** The verified caller, as the change records it. */
      readonly via: AgentChangeVia;
      /** The claim of the call's `request_id`, written in the transaction that records the change; none without one. */
      readonly request?: ChangeClaim | undefined;
    };

/** The author source of a Session, listed (`id`) or not. */
export const sessionSource = (id: string | undefined): AuthorSource => ({ kind: "session", id });

/** The Session's id of a source that is a listed Session's; undefined for the endpoint's, or a Session not listed. */
export const sessionOf = (source: AuthorSource): string | undefined =>
  source.kind === "session" ? source.id : undefined;

/**
 * The Registry's author of a change `author` describes (the tool, the reason, the conversation it was made from, an
 * Approval, the owner's own act), made from `source`; undefined for a Session the Registry does not list, which changes
 * nothing. A Session's change with no conversation named is the root conversation's.
 */
export const registryAuthor = (
  source: AuthorSource,
  author: ChangeAuthor,
): AgentChangeAuthor | undefined => {
  if (source.kind === "endpoint") {
    return {
      via: source.via,
      tool: author.tool,
      reason: author.reason,
      // Each is `undefined` when absent, which the Registry reads as not set.
      approved: author.approved,
      request: source.request,
    };
  }

  return source.id === undefined ? undefined : sessionAuthor(source.id, author);
};

/**
 * The Registry's author of a change Session `session` makes, as `author` describes it: with no conversation named, the
 * root conversation's.
 */
export const sessionAuthor = (session: string, author: ChangeAuthor): AgentChangeAuthor => ({
  session,
  conversation: author.conversation ?? ROOT_CONVERSATION_ID,
  tool: author.tool,
  reason: author.reason,
  // Each is `undefined` when absent, which the Registry reads as not set.
  approved: author.approved,
  actor: author.actor,
});

/** What a change from a Session the Registry does not list is refused with: it changes no `what`. */
export const unlistedSession = (what: "Environment" | "Settings"): string =>
  `This Session is not one the Registry lists, so it changes no ${what}.`;

/**
 * The Registry's author of a change `author` describes, made from `source`, or the failure `unlisted` for a Session the
 * Registry does not list. Asked when the change is made, not when the service is built.
 */
export const authored =
  <E>(source: AuthorSource, unlisted: E) =>
  (author: ChangeAuthor): Effect.Effect<AgentChangeAuthor, E> =>
    Effect.suspend(() => {
      const by = registryAuthor(source, author);

      return by === undefined ? Effect.fail(unlisted) : Effect.succeed(by);
    });
