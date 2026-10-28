import { type ApprovalRequest, MAX_APPROVAL_REASON } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Arr from "effect/Array";
import * as Atom from "effect/reactivity/Atom";
import { ShieldCheck } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { answerApprovalAtom, approvalRequestsAtom, sessionStatusAtom } from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";

/** One card's state: the reason typed for a Decline, and whether the card was answered. */
const CardState = ScopedAtom.make(() =>
  Atom.make<{ readonly reason: string; readonly sent: boolean }>({ reason: "", sent: false }),
);

/** What a card takes: its request, whether answering is off, and what to do with the owner's answer. */
type CardProps = {
  request: ApprovalRequest;
  disabled: boolean;
  onAnswer: (approve: boolean, reason: string) => void;
};

/**
 * The classes of a value on the card: one line as a sentence, several (a Skill's files, as written) in fixed-width
 * text that keeps its lines. The card's values region bounds and scrolls them.
 */
const valueClass = (value: string): string =>
  value.includes("\n") ? "font-mono text-xs break-words whitespace-pre-wrap" : "break-words";

/**
 * The card for one Approval request (`docs/architecture/agent-changes.md` → Approval): the change the agent wants to make, its target, the
 * value before and after (for a delete, what is deleted), and the agent's reason, with Approve and Decline. A Decline
 * may carry the owner's reason to the agent. The card closes when the Session's next list leaves the request out.
 */
const ApprovalCardBody = ({ request, disabled, onAnswer }: CardProps) => {
  const [{ reason, sent }, setState] = useAtom(CardState.use());
  const off = disabled || sent;

  const answer = (approve: boolean) => {
    setState((previous) => ({ ...previous, sent: true }));
    onAnswer(approve, reason);
  };

  return (
    <section
      aria-label="Approval requested"
      className="mx-auto mb-3 flex only:min-h-0 only:shrink short:only:shrink-0 max-h-[calc(var(--waiting-height,60dvh)-0.75rem)] w-full max-w-3xl flex-col gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm short:gap-2 short:py-2"
    >
      <div className="shrink-0">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4 shrink-0" aria-hidden />
          The agent asks your Approval: {request.change}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {request.target} · <span className="font-mono">{request.tool}</span>
        </p>
      </div>
      {/* Only Now and After scroll, in the room the card leaves: the rest of the card is never pushed out of view. */}
      <div
        role="region"
        aria-label="What the change does"
        tabIndex={0}
        className="min-h-12 flex-1 overflow-y-auto focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <dl className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Now</dt>
          <dd className={valueClass(request.before)}>{request.before}</dd>
          <dt className="text-muted-foreground">After</dt>
          <dd className={valueClass(request.after)}>{request.after}</dd>
        </dl>
      </div>
      <dl className="grid max-h-16 short:max-h-10 shrink-0 grid-cols-[3rem_minmax(0,1fr)] gap-x-3 overflow-y-auto text-sm">
        <dt className="text-muted-foreground">Why</dt>
        <dd className="break-words">{request.reason}</dd>
      </dl>
      <div className="flex shrink-0 flex-col gap-3 short:flex-row short:items-end short:gap-2">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-xs font-medium">
            Reason for a Decline (optional, the agent sees it)
          </span>
          <input
            type="text"
            value={reason}
            maxLength={MAX_APPROVAL_REASON}
            disabled={off}
            onChange={(event) => {
              const typed = event.currentTarget.value;

              setState((previous) => ({ ...previous, reason: typed }));
            }}
            className="h-9 rounded-md short:h-8 border border-input bg-background px-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={off}
            onClick={() => {
              answer(false);
            }}
          >
            Decline
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={off}
            onClick={() => {
              answer(true);
            }}
          >
            Approve
          </Button>
        </div>
      </div>
    </section>
  );
};

/** The card for one Approval request with its own state; the list keys it by request, so each starts unanswered. */
export const ApprovalCard = (props: CardProps) => (
  <CardState.Provider>
    <ApprovalCardBody {...props} />
  </CardState.Provider>
);

/** The cards for the Approval requests waiting for the owner in the Session shown, oldest first. */
export const ApprovalRequests = () => {
  const sessionId = useShownSessionId();
  const requests = useAtomValue(approvalRequestsAtom(sessionId));
  // Answered only over a live socket.
  const disabled = useAtomValue(sessionStatusAtom(sessionId), (status) => status !== "live");
  const answer = useAtomSet(answerApprovalAtom(sessionId));

  return Arr.map(requests, (request) => (
    <ApprovalCard
      key={request.id}
      request={request}
      disabled={disabled}
      onAnswer={(approve, reason) => {
        answer(
          approve ? { request: request.id, approve } : { request: request.id, approve, reason },
        );
      }}
    />
  ));
};
