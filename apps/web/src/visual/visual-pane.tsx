// docs/architecture/visuals.md → The frame (The Visual Pane). One Visual popped out into a Pane of its own (`visual:<callId>`),
// a sheet on a phone (the Pane area is one there). Its frame is mounted here instead of in its card, which says "Shown in the
// Visual Pane" with Show here: the Pane claims the call's `visual-pane` place, the highest, and a Visual has no teardown, so the
// card's frame goes at once. The Visual is shown at full size: the page fits its content in a scrolling Pane (the frame's own
// rule, `height.ts`), and the height is the card's to remember, not this Pane's, which is another width. Escape from the page
// returns the focus to the Pane, and Escape in the Pane's own chrome to the chat, as in an App Pane.
// @effect-diagnostics missingPipeableSignature:off -- hooks over the Session's atoms, not combinators.
import { isKeptVisual } from "@cloudpid/protocol";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { use, useRef, useState, type ReactNode } from "react";
import { copyToClipboard } from "../lib/clipboard.ts";
import { useShownSessionId } from "../chat/conversation.ts";
import type { PaneProps } from "../panes.ts";
import { focusChatOnEscape } from "../sandbox-frame/focus.ts";
import { visualsAtom } from "../session/atoms.ts";
import { type VisualLoad, visualKey, visualLoadAtom } from "./atoms.ts";
import {
  Chrome,
  HeaderButton,
  OpenFile,
  useVisualPlace,
  VisualDetails,
  VisualEvicted,
} from "./visual-call.tsx";
import { VisualFailed, VisualFrame } from "./visual-frame.tsx";
import { visualEntryOf } from "./visuals.ts";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";

/** What the Pane reads while it wants no page: nothing is loaded. */
const NO_LOAD = Atom.make(AsyncResult.initial<VisualLoad>());

/** A line of the Pane where there is no Visual: one the Session does not have, or has not kept. */
const PaneNote = ({ children }: { children: ReactNode }) => (
  <div className="m-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
    {children}
  </div>
);

/** The Pane of a kept Visual: the chrome with its actions, and the frame once this Pane has the call's place. */
const KeptVisualPane = ({ callId, close }: { callId: string; close: () => void }) => {
  const sessionId = useShownSessionId();
  const pane = useRef<HTMLDivElement>(null);
  const view = useVisualPlace(callId, "visual-pane");
  const [details, setDetails] = useState(false);
  const key = visualKey(sessionId, callId);
  const registry = use(RegistryContext);
  const entry = useAtomValue(visualsAtom(sessionId), (visuals) => visualEntryOf(visuals, callId));

  const loaded = useAtomValue(
    view.kind === "hosting" && !view.closing ? visualLoadAtom(key) : NO_LOAD,
  );

  const load = AsyncResult.isSuccess(loaded) ? loaded.value : undefined;
  const page = load?.status === "page" ? load : undefined;
  const title = page?.record.title ?? entry?.title ?? "…";

  const body = (() => {
    if (load?.status === "failed") {
      return (
        <VisualFailed
          reason={load.reason}
          onRetry={() => {
            registry.refresh(visualLoadAtom(key));
          }}
        />
      );
    }

    if (load?.status === "none") return <PaneNote>This Visual is not in this Session.</PaneNote>;

    if (load?.status === "evicted") {
      return <PaneNote>This Visual is no longer kept: {load.stub.summary}</PaneNote>;
    }

    if (page === undefined) return null;

    return (
      <VisualFrame
        record={page.record}
        origin={page.origin}
        onEscape={() => pane.current?.focus()}
      />
    );
  })();

  return (
    <div
      ref={pane}
      tabIndex={-1}
      role="group"
      aria-label={`Visual: ${title}`}
      className="flex min-h-0 flex-1 flex-col outline-none"
      data-visual-pane={callId}
      onKeyDown={focusChatOnEscape}
    >
      <Chrome title={title}>
        <HeaderButton onClick={close}>Show here</HeaderButton>
        <HeaderButton
          disabled={page === undefined}
          onClick={() => {
            // The kept copy, redacted, without the shim, which is never stored.
            if (page !== undefined) void copyToClipboard(page.record.html);
          }}
        >
          Copy HTML
        </HeaderButton>
        {entry !== undefined && <OpenFile sessionId={sessionId} entry={entry} />}
        {entry !== undefined && (
          <HeaderButton
            expanded={details}
            onClick={() => {
              setDetails((open) => !open);
            }}
          >
            Details
          </HeaderButton>
        )}
      </Chrome>
      {details && entry !== undefined && (
        <VisualDetails entry={entry} record={page?.record} origin={page?.origin} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
};

/**
 * The Visual Pane of the call named by `argument`. One the Session lists as evicted says so (with Open file, as its card
 * does) and claims nothing; any other claims the call's `visual-pane` place and loads the page by the call, so a link that
 * names a Visual of a thread the page has not watched still opens it, and one the Session does not have says so. Either
 * stays to be closed.
 */
export const VisualPane = ({ argument, close }: PaneProps) => {
  // A key without a call is no Pane the Pane types open.
  const callId = argument ?? "";
  const sessionId = useShownSessionId();
  const entry = useAtomValue(visualsAtom(sessionId), (visuals) => visualEntryOf(visuals, callId));

  if (entry !== undefined && !isKeptVisual(entry)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <VisualEvicted sessionId={sessionId} entry={entry} />
      </div>
    );
  }

  return <KeptVisualPane callId={callId} close={close} />;
};
