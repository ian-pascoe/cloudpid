// The Live View Pane (#154, ADR-0013): the agent's browser tab, live, for the owner to use while a Browser Handoff
// waits. It is the handoff's chrome around the Live View's screen (`live-screen.tsx`): a header with the agent's
// instructions, the deadline, Done and Failed, and the Pane's closing when the handoff ends. It is the only place that
// knows the handoff's `requestId`. It opens only from the handoff card's Take over (or a push's link to it) and closes
// when the handoff ends; closing it does not end the handoff.

import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";
import { Check, X } from "lucide-react";
import { useEffect } from "react";
import { useShownSessionId } from "../chat/conversation.ts";
import { Button } from "../components/ui/button.tsx";
import { Dialog } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { timeOfDay } from "../lib/time.ts";
import type { PaneProps } from "../panes.ts";
import { liveViewStateAtom } from "./atoms.ts";
import {
  finishLiveViewAtom,
  handoffLiveViewAtom,
  handoffRequestAtom,
  handoffStateAtom,
  liveViewKey,
  type LiveViewKey,
} from "./handoff-atoms.ts";
import { keepFocus, LiveScreen } from "./live-screen.tsx";

/** Whether the Failed form, which asks for an optional reason, is open, for one Pane. */
const Failing = ScopedAtom.make(() => Atom.make(false));

/** Failed, with an optional reason for the agent. */
const FailedDialog = ({ liveView }: { liveView: LiveViewKey }) => {
  const [open, setOpen] = useAtom(Failing.use());
  const finish = useAtomSet(finishLiveViewAtom(liveView));

  return (
    <Dialog
      open={open}
      onClose={() => {
        setOpen(false);
      }}
      title="Tell the agent it failed"
      description="The agent resumes with this. Leave the reason empty to say only that it failed."
    >
      <form
        className="flex flex-col gap-3 p-4 pt-0"
        onSubmit={(event) => {
          event.preventDefault();

          const reason = new FormData(event.currentTarget).get("reason");

          setOpen(false);
          finish(
            reason === null || reason instanceof File || reason.trim() === ""
              ? { success: false }
              : { success: false, reason: reason.trim() },
          );
        }}
      >
        <Input name="reason" aria-label="Reason" placeholder="Reason (optional)" autoFocus />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" variant="destructive" size="sm">
            Failed
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** The header: what the agent asked for, until when, and Done and Failed. */
const Header = ({ liveView }: { liveView: LiveViewKey }) => {
  const status = useAtomValue(
    liveViewStateAtom(handoffLiveViewAtom(liveView)),
    (state) => state.status,
  );

  const handoff = useAtomValue(handoffStateAtom(liveView));

  const request = useAtomValue(handoffRequestAtom(liveView)) ?? undefined;
  const finish = useAtomSet(finishLiveViewAtom(liveView));
  const setFailing = useAtomSet(Failing.use());

  const instructions = handoff.instructions ?? request?.instructions;
  const deadline = handoff.deadline ?? request?.deadline;
  const live = status === "live";

  return (
    <header className="flex flex-col gap-2 border-b px-3 py-2">
      {instructions !== undefined && (
        <p className="line-clamp-3 text-sm break-words whitespace-pre-wrap" title={instructions}>
          {instructions}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {deadline !== undefined && (
          <span className="text-xs text-muted-foreground">Waits until {timeOfDay(deadline)}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!live}
            {...keepFocus}
            onClick={() => {
              setFailing(true);
            }}
          >
            <X aria-hidden />
            Failed
          </Button>
          <Button
            size="sm"
            disabled={!live}
            {...keepFocus}
            onClick={() => {
              finish({ success: true });
            }}
          >
            <Check aria-hidden />
            Done
          </Button>
        </div>
      </div>
      <FailedDialog liveView={liveView} />
    </header>
  );
};

const LiveViewOf = ({ liveView, close }: { liveView: LiveViewKey; close: () => void }) => {
  const view = handoffLiveViewAtom(liveView);
  const status = useAtomValue(liveViewStateAtom(view), (state) => state.status);

  // Null once a list of the Session's handoffs came without it: the handoff is over.
  const over = useAtomValue(handoffRequestAtom(liveView), (request) => request === null);

  // The handoff ended (Done, Failed, from here or another device, Stop, or its timeout): the Pane closes.
  useEffect(() => {
    if (status === "ended" || over) close();
  }, [status, over, close]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header liveView={liveView} />
      <LiveScreen view={view} />
    </div>
  );
};

/** The Live View of the Browser Handoff the Pane's argument names. */
export const LiveViewPane = ({ argument, close }: PaneProps) => {
  const sessionId = useShownSessionId();

  if (argument === undefined) return null;

  return (
    <Failing.Provider>
      <LiveViewOf liveView={liveViewKey(sessionId, argument)} close={close} />
    </Failing.Provider>
  );
};
