// docs/architecture/mcp-apps.md → App Panes. One App View popped out into a Pane of its own (`app:<callId>`), a sheet on a
// phone (the Pane area is one there). The View is mounted here instead of in its card, which says "Shown in the App Pane":
// the card's frame tears down first and this Pane's mounts once it has. In a Pane both axes of the View's container are
// fixed, and a resize reaches the View as a debounced `host-context-changed`. Escape here returns the focus to the chat.
import { useShownSessionId } from "../chat/conversation.ts";
import type { PaneProps } from "../panes.ts";
import { AppPlaceMount, useAppFacts } from "./app-call.tsx";

/**
 * Escape in the Pane returns the focus to the chat: the composer's input. (Escape inside the View is the View's own: its
 * frame takes the key, and the page never sees it.)
 */
export const focusChatOnEscape = (event: {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly preventDefault: () => void;
}): void => {
  if (event.key !== "Escape" || event.defaultPrevented) return;

  event.preventDefault();
  document.querySelector<HTMLElement>('textarea[aria-label="Message"]')?.focus();
};

/**
 * The App Pane of the call named by `argument`. A Pane is the owner's choice, so its View is live whatever generation its
 * call is in; one that cannot mount (its record evicted, its server off) says so, and the Pane stays to be closed.
 */
export const AppPane = ({ argument, close }: PaneProps) => {
  const sessionId = useShownSessionId();
  // A key without a call is no Pane the Pane types open.
  const callId = argument ?? "";
  const { tool, availability } = useAppFacts(callId, undefined);

  if (availability.kind === "none") {
    return <p className="p-4 text-sm text-muted-foreground">This App is not in this Session.</p>;
  }

  return (
    <div
      data-app-pane={callId}
      className="flex min-h-0 flex-1 flex-col p-2"
      onKeyDown={focusChatOnEscape}
    >
      <AppPlaceMount
        sessionId={sessionId}
        callId={callId}
        place="app-pane"
        tool={tool}
        badge={availability.kind === "mount" ? availability.badge : null}
        live={availability.kind === "mount"}
        idle={
          <p className="p-2 text-sm text-muted-foreground">
            {availability.kind === "evicted" ? "App data no longer kept" : "App unavailable"}
          </p>
        }
        controls={{ onBack: close }}
        onRequestMode={(mode) => {
          // `inline`: the View goes back to its card, which mounts it once this Pane's frame has torn down.
          if (mode === "inline") close();
        }}
      />
    </div>
  );
};
