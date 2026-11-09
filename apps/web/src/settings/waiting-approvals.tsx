// @effect-diagnostics preferEffectArray:off -- JSX lists of requests are native arrays.

// The "Waiting for you" area of the Settings page (docs/architecture/client-and-protocol.md → Settings page;
// docs/architecture/mcp-endpoint.md → Approvals with no Session): above a section, the Approvals a Local agent asked over
// the MCP endpoint for a change in it. One waiting shows the in-session card (`ApprovalCard`) with who asked; one
// approved shows its apply (`ApprovalProgress`), with Try again once a cut left it unapplied; one done with says what
// came of it for the 24 h the Registry keeps it. Each has the anchor `?request=` names (`useRequestInView`).

import { type RegistryApproval, withdrawalReason } from "@cloudpid/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { LoaderCircle } from "lucide-react";
import { ApprovalCard } from "../chat/approval-card.tsx";
import { requestCardId } from "../chat/request-anchor.ts";
import { Button } from "../components/ui/button.tsx";
import { DialogProblem } from "../components/ui/dialog.tsx";
import { settledFailureOf } from "../registry.ts";
import {
  type ApprovalAction,
  approvalActionAtom,
  approvalListAtom,
  approvalsIn,
  askedVia,
} from "./approvals.ts";

/** What a request's row says of it: its words, whether Try again applies it, and whether its apply is under way. */
interface Outcome {
  readonly text: string;
  readonly retry: boolean;
  readonly busy: boolean;
}

/** What came of a request no longer waiting, as its row says it; `retry` when Try again applies it. */
const outcomeOf = (approval: RegistryApproval): Outcome => {
  const because = approval.reason === undefined ? "" : `: ${approval.reason}`;

  switch (approval.status) {
    case "approved":
      return approval.applying
        ? { text: "Approved: applying the change…", retry: false, busy: true }
        : {
            text: "Approved, but the change was cut off before it was applied.",
            retry: true,
            busy: false,
          };
    case "finished":
      return { text: approval.text ?? "Approved and applied.", retry: false, busy: false };
    case "declined":
      return { text: `Declined${because}. Nothing was changed.`, retry: false, busy: false };
    case "changed_since":
    case "refused":
      return { text: `Not applied${because}`, retry: false, busy: false };
    case "expired":
      return {
        text: "Expired before you answered. Nothing was changed.",
        retry: false,
        busy: false,
      };
    case "withdrawn":
      return {
        text: `Withdrawn: ${withdrawalReason(approval.withdrawal) ?? "no longer asked"}. Nothing was changed.`,
        retry: false,
        busy: false,
      };
    default:
      return { text: `This request is ${approval.status}.`, retry: false, busy: false };
  }
};

/** A request no longer waiting for an answer: its change, who asked, and what came of it, with Try again when cut. */
export const ApprovalProgress = ({
  approval,
  disabled,
  onRetry,
}: {
  approval: RegistryApproval;
  disabled: boolean;
  onRetry: () => void;
}) => {
  const { text, retry, busy } = outcomeOf(approval);

  return (
    <section
      id={requestCardId(approval.id)}
      aria-label="Approval answered"
      className="mx-auto mb-3 flex w-full max-w-3xl flex-col gap-2 rounded-lg border bg-card px-4 py-3 text-sm shadow-sm"
    >
      <div>
        <p className="font-semibold">{approval.card.change}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {approval.card.target} · <span className="font-mono">{approval.card.tool}</span> ·{" "}
          {askedVia(approval)}
        </p>
      </div>
      <p role="status" className="flex items-start gap-2 break-words whitespace-pre-wrap">
        {busy ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden /> : null}
        {text}
      </p>
      {retry ? (
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={disabled} onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}
    </section>
  );
};

/** The requests `approvals` of one section, oldest first: a card for each waiting, the progress of the rest. */
export const WaitingApprovalsList = ({
  approvals,
  busy,
  problem,
  onAction,
}: {
  approvals: ReadonlyArray<RegistryApproval>;
  /** An answer or Try again is on its way: Try again waits for it. */
  busy: boolean;
  /** Why the last answer or Try again failed, or null. */
  problem: string | null;
  onAction: (action: ApprovalAction) => void;
}) => {
  if (approvals.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Waiting for you"
      className="mx-auto flex w-full max-w-3xl flex-col px-4 pt-6 md:px-8 md:pt-8"
    >
      <h2 className="mb-2 text-sm font-semibold">Waiting for you</h2>
      {approvals.map((approval) =>
        approval.status === "pending" ? (
          <ApprovalCard
            key={approval.id}
            request={{ id: approval.id, ...approval.card }}
            disabled={false}
            byline={askedVia(approval)}
            onAnswer={(approved, reason) => {
              onAction({
                kind: "answer",
                scope: approval.scope,
                id: approval.id,
                approved,
                reason,
              });
            }}
          />
        ) : (
          <ApprovalProgress
            key={approval.id}
            approval={approval}
            disabled={busy}
            onRetry={() => {
              onAction({ kind: "retry", scope: approval.scope, id: approval.id });
            }}
          />
        ),
      )}
      <DialogProblem problem={problem} />
    </div>
  );
};

/** The "Waiting for you" area of section `section` at Scope `scope`: nothing while no request is for it. */
export const WaitingForYou = ({ scope, section }: { scope: string; section: string }) => {
  const approvals = useAtomValue(approvalListAtom(scope));
  const [acted, act] = useAtom(approvalActionAtom);

  return (
    <WaitingApprovalsList
      approvals={approvalsIn(approvals, section)}
      busy={acted.waiting}
      problem={settledFailureOf(acted)}
      onAction={act}
    />
  );
};
