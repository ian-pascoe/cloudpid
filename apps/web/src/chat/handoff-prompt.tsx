import { liveViewPaneKey, type BrowserHandoffRequest } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Exit from "effect/Exit";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";
import { ExternalLink, Hand, MonitorPlay } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { mintLiveViewAtom } from "../live-view/handoff-atoms.ts";
import { timeOfDay } from "../lib/time.ts";
import { hostedLiveViewUrl } from "../live-view/hosted.ts";
import { panesAtom } from "../panes-state.ts";
import { agentLabel } from "../session/agents.ts";
import { browserHandoffRequestsAtom, taskGraphAtom } from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";

/** Why the last "Open in Cloudflare" of one card failed, or null. */
const HostedFailure = ScopedAtom.make(() => Atom.make<string | null>(null));

/**
 * One Browser Handoff (`docs/spec.md` → Browser): the agent asks the owner to take over its browser for a step it cannot
 * do. **Take over** opens the Live View Pane, which connects to the tab with links minted for it; the small **Open in
 * Cloudflare** link mints one the same way and opens Browser Run's hosted page instead (a fallback). The owner presses
 * Done there; the agent resumes by itself, so the card has no answer to give, and it goes away when the handoff ends.
 * Stopping the run ends the handoff.
 */
const BrowserHandoffPrompt = ({
  request,
  agent,
}: {
  request: BrowserHandoffRequest;
  /** The subagent whose tab it is, when it is not the root agent's: the owner may have several tabs to look after. */
  agent: string | undefined;
}) => {
  const sessionId = useShownSessionId();
  const act = useAtomSet(panesAtom);
  const mint = useAtomSet(mintLiveViewAtom(sessionId), { mode: "promiseExit" });
  const [failure, setFailure] = useAtom(HostedFailure.use());

  // The window opens in the tap, before the link is minted: a browser blocks one opened after a wait.
  const openHosted = () => {
    const opened = window.open("", "_blank");

    if (opened !== null) opened.opener = null;

    setFailure(null);
    void mint(request.id).then((exit) => {
      if (Exit.isSuccess(exit)) {
        if (opened === null) window.location.assign(hostedLiveViewUrl(exit.value.tab.link));
        else opened.location.href = hostedLiveViewUrl(exit.value.tab.link);

        return;
      }

      opened?.close();
      setFailure("The Live View link could not be made. Try again.");
    });
  };

  return (
    <section
      aria-label="Browser handoff"
      className="mx-auto mb-3 w-full max-w-3xl rounded-lg border bg-card px-4 py-3 shadow-sm"
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Hand className="size-4" aria-hidden />
        {agent ?? "The agent"} needs you in its browser
      </div>
      <p className="mt-1 text-sm break-words whitespace-pre-wrap">{request.instructions}</p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Press Done in the Live View when you are finished. Stop the run to cancel. This waits
          until {timeOfDay(request.deadline)}.
        </p>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={openHosted}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline [&_svg]:size-3"
          >
            Open in Cloudflare
            <ExternalLink aria-hidden />
          </button>
          <Button
            size="sm"
            onClick={() => {
              act({ type: "open", key: liveViewPaneKey(request.id) });
            }}
          >
            <MonitorPlay aria-hidden />
            Take over
          </Button>
        </div>
      </div>
      {failure !== null && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {failure}
        </p>
      )}
    </section>
  );
};

/** The Browser Handoffs waiting for the owner in the Session shown, oldest first. */
export const BrowserHandoffRequests = () => {
  const sessionId = useShownSessionId();
  const requests = useAtomValue(browserHandoffRequestsAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));

  return Arr.map(requests, (request) => (
    <HostedFailure.Provider key={request.id}>
      <BrowserHandoffPrompt request={request} agent={agentLabel(graph, request.conversationId)} />
    </HostedFailure.Provider>
  ));
};
