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

/**
 * The classes of a value on the card: one line as a sentence, several (a Skill's files, as written) in fixed-width
 * text that keeps its lines. The card's body bounds and scrolls them.
 */
const valueClass = (value: string): string =>
  value.includes("\n") ? "font-mono text-xs break-words whitespace-pre-wrap" : "break-words";

/**
 * The card for one Approval request (`docs/spec.md` → Approval): the change the agent wants to make, its target, the
 * value before and after (for a delete, what is deleted), and the agent's reason, with Approve and Decline. A Decline
 * may carry the owner's reason to the agent. The card closes when the Session's next list leaves the request out.
 */
const Card = ({
  request,
  disabled,
  onAnswer,
}: {
  request: ApprovalRequest;
  disabled: boolean;
  onAnswer: (approve: boolean, reason: string) => void;
}) => {
  const [{ reason, sent }, setState] = useAtom(CardState.use());
  const off = disabled || sent;

  const answer = (approve: boolean) => {
    setState((previous) => ({ ...previous, sent: true }));
    onAnswer(approve, reason);
  };

  return (
    <section
      aria-label="Approval requested"
      className="mx-auto mb-3 w-full max-w-3xl rounded-lg border bg-card px-4 py-3 shadow-sm"
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-4" aria-hidden />
        The agent asks your Approval: {request.change}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {request.target} · <span className="font-mono">{request.tool}</span>
      </p>
      {/* The values scroll in their own region, so the reason input and the buttons stay in view whatever the size. */}
      <div className="mt-3 max-h-[30dvh] overflow-y-auto overscroll-contain">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Now</dt>
          <dd className={valueClass(request.before)}>{request.before}</dd>
          <dt className="text-muted-foreground">After</dt>
          <dd className={valueClass(request.after)}>{request.after}</dd>
          <dt className="text-muted-foreground">Why</dt>
          <dd className="break-words">{request.reason}</dd>
        </dl>
      </div>
      <label className="mt-3 flex flex-col gap-1 text-sm">
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
          className="h-9 rounded-md border border-input bg-background px-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        />
      </label>
      <div className="mt-3 flex justify-end gap-2">
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
    </section>
  );
};

/** One card, keyed by its request in the list so that it starts unanswered. */
export const ApprovalCard = (props: {
  request: ApprovalRequest;
  disabled: boolean;
  onAnswer: (approve: boolean, reason: string) => void;
}) => (
  <CardState.Provider>
    <Card {...props} />
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
