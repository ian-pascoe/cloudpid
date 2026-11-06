// docs/architecture/mcp-apps.md → App Panes. One App View popped out into a Pane of its own (`app:<callId>`), a sheet on a
// phone (the Pane area is one there). The View is mounted here instead of in its card, which says "Shown in the App Pane":
// the card's frame tears down first and this Pane's mounts once it has. In a Pane both axes of the View's container are
// fixed, and a resize reaches the View as a debounced `host-context-changed`. Escape in the Pane's own chrome returns the
// focus to the chat.
import { useAtom } from "@effect/atom-react";
import { useShownLayoutKey } from "../chat/conversation.ts";
import type { PaneProps } from "../panes.ts";
import { focusChatOnEscape } from "../sandbox-frame/focus.ts";
import { appChoiceAtom } from "../session-layout-state.ts";
import { AppIdle, AppNote, AppPlaceMount, useAppFacts } from "./app-call.tsx";

/**
 * The App Pane of the call named by `argument`. A Pane is the owner's choice, so its View is live whatever generation its
 * call is in, except in an archived Session, where App Views are collapsed until reopened here or in the card, and then
 * read only. One that cannot mount (its record evicted, its server off) says so, and the Pane stays to be closed.
 */
export const AppPane = ({ argument, close }: PaneProps) => {
  // A key without a call is no Pane the Pane types open.
  const callId = argument ?? "";
  const facts = useAppFacts(callId, undefined);
  const [choice, choose] = useAtom(appChoiceAtom(useShownLayoutKey(), callId));

  if (facts.availability.kind === "none") {
    return <AppNote>This App is not in this Session.</AppNote>;
  }

  const live = facts.mountable && (!facts.archived || choice === "open");

  return (
    <div className="flex min-h-0 flex-1 flex-col p-2" onKeyDown={focusChatOnEscape}>
      <AppPlaceMount
        facts={facts}
        place="app-pane"
        live={live}
        idle={
          <AppIdle
            facts={facts}
            onReopen={() => {
              choose("open");
            }}
          />
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
