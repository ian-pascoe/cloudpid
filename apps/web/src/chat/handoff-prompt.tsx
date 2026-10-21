// @effect-diagnostics preferEffectArray:off globalDate:off -- browser code in a React app with no Effect runtime: native arrays and Date are the platform here.
import type { BrowserHandoffRequest, TaskGraphSummary } from "@cloudpid/protocol";
import { ExternalLink, Hand } from "lucide-react";
import { buttonVariants } from "../components/ui/button.tsx";
import { agentLabel } from "../session/agents.ts";

/** The time of day a handoff times out, as the owner reads it. */
const until = (deadline: number): string =>
  new Date(deadline).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * One Browser Handoff (`docs/spec.md` → Browser): the agent asks the owner to take over its browser for a step it cannot
 * do. The owner opens the Live View link, does the step there, and presses Done; the agent resumes by itself, so the card
 * has no answer to give, and it goes away when the handoff ends. The link opens in a new window and is not kept in the
 * chat; stopping the run ends the handoff.
 */
const BrowserHandoffPrompt = ({
  request,
  agent,
}: {
  request: BrowserHandoffRequest;
  /** The subagent whose tab it is, when it is not the root agent's: the owner may have several tabs to look after. */
  agent: string | undefined;
}) => (
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
        Press Done in the Live View when you are finished. Stop the run to cancel. This waits until{" "}
        {until(request.deadline)}.
      </p>
      <a
        href={request.url}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({ size: "sm" })}
      >
        Open Live View
        <ExternalLink aria-hidden />
      </a>
    </div>
  </section>
);

/** The Browser Handoffs waiting for the owner, oldest first. */
export const BrowserHandoffRequests = ({
  requests,
  graph,
}: {
  requests: readonly BrowserHandoffRequest[];
  graph: TaskGraphSummary | null;
}) =>
  requests.map((request) => (
    <BrowserHandoffPrompt
      key={request.id}
      request={request}
      agent={agentLabel(graph, request.conversationId)}
    />
  ));
