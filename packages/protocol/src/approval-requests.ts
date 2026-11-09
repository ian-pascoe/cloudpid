// The Approvals the Registry keeps for changes asked over the MCP endpoint (`docs/architecture/mcp-endpoint.md` →
// Approvals with no Session; ADR-0050; `docs/architecture/client-and-protocol.md` → Settings page): what the Settings page
// shows of one in its "Waiting for you" area, and what the owner's Approve, Decline and Try again answer. A Session's own
// Approvals are `ApprovalRequest` (`./session.ts`), over the same card.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";
import { McpAuth, McpClient } from "./mcp-api.ts";
import { openLiterals } from "./open-literals.ts";
import { ApprovalCardContent } from "./session.ts";

/** How long a request waits for the owner before it expires. */
export const APPROVAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a request that is settled (answered and done, expired or withdrawn) is kept, then forgotten. */
export const APPROVAL_RETENTION_MS = 24 * 60 * 60 * 1000;

/** The most requests one identity (`auth`) may have waiting or approved and not finished (`too_many_approvals`). */
export const MAX_PENDING_APPROVALS = 10;

/**
 * Where a request stands (#685 L5). `pending` waits for the owner; `approved` was approved and its change is not applied
 * yet (applying, or cut and waiting to be resumed); `finished` was applied. `declined` by the owner; `changed_since` when
 * the target changed between the ask and the Approve; `refused` when the Registry refused the write; `expired` after 7 days
 * unanswered; `withdrawn` by the caller, by a newer request for the same change (`superseded`), or with its Environment.
 * A status a version does not know reads as `unknown`.
 */
export const ApprovalStatus = openLiterals(
  Schema.Literals([
    "pending",
    "approved",
    "finished",
    "declined",
    "changed_since",
    "refused",
    "expired",
    "withdrawn",
    "unknown",
  ]),
  "unknown",
);

export type ApprovalStatus = typeof ApprovalStatus.Type;

/** Whether a request in `status` is done with: nothing more happens to it (only `pending` and `approved` move on). */
export const approvalSettled = (status: ApprovalStatus): boolean =>
  status !== "pending" && status !== "approved";

/** Why a request was withdrawn: by its caller, by a newer request for the same change, or with its Environment. */
export const ApprovalWithdrawal = openLiterals(
  Schema.Literals(["withdrawn", "superseded", "environment_deleted", "unknown"]),
  "unknown",
);

export type ApprovalWithdrawal = typeof ApprovalWithdrawal.Type;

/**
 * Whether the owner approved a request in `status`: its change is applied, being applied, or was not applied because the
 * target changed or the Registry refused it. Such a request can no longer be withdrawn.
 */
export const approvalApproved = (status: ApprovalStatus): boolean =>
  status === "approved" ||
  status === "finished" ||
  status === "changed_since" ||
  status === "refused";

/**
 * Why a request was withdrawn, as a clause the caller (`approval_wait`'s `reason`) and the owner (the Settings page) both
 * read after "Withdrawn: ": the one source of the words. Undefined when the cause is not known.
 */
export const withdrawalReason = (
  withdrawal: ApprovalWithdrawal | undefined,
): string | undefined => {
  switch (withdrawal) {
    case "withdrawn":
      return "the agent that asked took it back";
    case "superseded":
      return "a newer request for the same change, with another value, replaced it";
    case "environment_deleted":
      return "its Environment was deleted";
    default:
      return undefined;
  }
};

/**
 * A request as the Settings page shows it: its card, who asked (the client's name, never its id), where it stands, and,
 * once it is done with, what came of it.
 */
export const RegistryApproval = Schema.Struct({
  id: Schema.String,
  /** The Scope the change is at: an Environment's id, or `*` for Global. */
  scope: Schema.String,
  /** The Settings page section the card shows in (its slug: `limits`, `instructions`, `container`). */
  section: Schema.String,
  card: ApprovalCardContent,
  /** Who asked: the client's name as it gave it, and how it got in. */
  via: Schema.Struct({ client: Schema.optionalKey(McpClient), auth: McpAuth }),
  status: ApprovalStatus,
  /** For `approved`: its change is being applied now (another run holds it), rather than waiting for Try again. */
  applying: Schema.Boolean,
  createdAt: Schema.Finite,
  expiresAt: Schema.Finite,
  /**
   * Why it ended as it did: the owner's reason for a Decline (absent when they gave none), what the target is now for
   * `changed_since`, the Registry's refusal for `refused`.
   */
  reason: Schema.optionalKey(Schema.String),
  /** For `withdrawn`: by whom. */
  withdrawal: Schema.optionalKey(ApprovalWithdrawal),
  /** For `finished`: what the applied change says. */
  text: Schema.optionalKey(Schema.String),
});

export type RegistryApproval = typeof RegistryApproval.Type;

/** A request the Registry does not keep (never asked, or settled more than 24 h ago). */
export class ApprovalNotFound extends Schema.TaggedError<
  ApprovalNotFound,
  { readonly brand: unique symbol }
>()("ApprovalNotFound", { message: Schema.String }) {}
