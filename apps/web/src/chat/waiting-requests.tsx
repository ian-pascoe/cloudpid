import { ApprovalRequests } from "./approval-card.tsx";
import { BrowserHandoffRequests } from "./handoff-prompt.tsx";
import { SecretRequests } from "./secret-form.tsx";

/** The classes of the area: at most 60% of the viewport's height (72% where it is under 32rem tall), scrolling inside, so the composer stays in view. A lone Approval card shrinks to the area's height, with the others it keeps its own and the area scrolls. */
export const WAITING_REQUESTS_CLASS =
  "flex max-h-(--waiting-height) flex-col overflow-y-auto *:shrink-0 overscroll-contain px-4 not-empty:pt-1 [--waiting-height:60dvh] short:[--waiting-height:72dvh]";

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
