// What every tool that records an Agent change takes besides its target (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Retries: `request_id`; `docs/architecture/agent-changes.md`): the agent's `reason`,
// kept with the change for the owner to read, and, on the endpoint only, the `request_id` that makes a retry safe.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";

/** The longest reason a change may give. */
export const MAX_CHANGE_REASON = 500;

/** A changing tool's required `reason`, 1 to `MAX_CHANGE_REASON` characters; a tool may annotate its own example. */
export const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, for the user to read in the Environment's Agent changes, such as 'the tests read the API address from API_URL'",
});

/** The same `reason` on the endpoint, whose words name the owner. */
export const ReasonEndpoint = Reason.annotate({
  description:
    "Why you make the change, for the owner to read in the Environment's Agent changes, such as 'the tests read the API address from API_URL'",
});

/** The `reason` of a tool that changes the Settings, for `who` to read, with its own `example`. */
export const settingsReason = (who: "user" | "owner", example: string) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CHANGE_REASON)).annotate({
    description: `Why you make the change, for the ${who} to read in the Settings' Agent changes, such as '${example}'`,
  });

/** The longest `request_id` the endpoint takes. */
export const MAX_REQUEST_ID_LENGTH = 200;

/**
 * The prefix of the ids the Registry claims for an approved apply (`approval:<approval id>`): a caller may not use it
 * (`docs/architecture/mcp-endpoint.md` → Approvals with no Session).
 */
export const APPROVAL_REQUEST_PREFIX = "approval:";

/**
 * The endpoint's `request_id`: optional on every tool that records an Agent change. A repeat with the same id answers
 * what the first call did, for 24 h, and makes no second change; the same id with other arguments is refused.
 */
export const RequestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_REQUEST_ID_LENGTH),
).annotate({
  description:
    "An id of your own for this call (a UUID): a retry with the same request_id and arguments answers what the first call did and makes no second change, for 24 hours. The same request_id with other arguments is refused.",
});

/** The `request_id` key, as every endpoint input that records a change spreads it. */
export const RequestIdField = { request_id: Schema.optionalKey(RequestId) };
