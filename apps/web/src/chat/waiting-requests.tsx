import { ApprovalRequests } from "./approval-card.tsx";
import { BrowserHandoffRequests } from "./handoff-prompt.tsx";
import { SecretRequests } from "./secret-form.tsx";

/** The classes of the area: at most 60% of the viewport's height (72% where it is under 32rem tall), scrolling inside, so the composer stays in view. */
export const WAITING_REQUESTS_CLASS =
  "max-h-(--waiting-height) overflow-y-auto overscroll-contain px-4 [--waiting-height:60dvh] [@media(max-height:32rem)]:[--waiting-height:72dvh]";

/**
 * What waits for the owner above the composer: Browser Handoffs, Secret forms and Approval cards. The area is bounded and
 * scrolls on its own, so the thread and the composer stay usable when several are waiting.
 */
export const WaitingRequests = () => (
  <div className={WAITING_REQUESTS_CLASS}>
    <BrowserHandoffRequests />
    <SecretRequests />
    <ApprovalRequests />
  </div>
);
