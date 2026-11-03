// @effect-diagnostics preferEffectArray:off -- JSX lists of scopes are native arrays.
// The card for a Sign-in request (`docs/architecture/mcp-sign-in.md` → Sign-in requests): an agent asked the owner to sign
// in to an MCP server. It shows the server, where its definition is, the hosts the sign-in goes through, the agent's reason
// (marked as the agent's own words, never as cloudpid's) and what is in the way. "Sign in" is a link that opens the start
// page in a new tab, naming this Session and request so the callback tells the Session; Decline tells the agent no, with
// the owner's reason when they give one. Nothing here holds a token: the page the link opens does the sign-in.
import type { McpSignInRequest } from "@cloudpid/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { exitFailure } from "../registry.ts";
import { sessionPath } from "../router.ts";
import { agentLabel } from "../session/agents.ts";
import {
  declineMcpSignInAtom,
  mcpSignInRequestsAtom,
  sessionStatusAtom,
  taskGraphAtom,
} from "../session/atoms.ts";
import { mcpSignInRequestHref } from "../settings/mcp-sign-in-model.ts";
import { useShownSessionId } from "./conversation.ts";
import { sourceLabel } from "./mcp-elicitation-form.ts";
import { requestCardId } from "./request-anchor.ts";

/** What stands in the way of the sign-in, in the owner's words; a reason this build does not know reads as needing one. */
export const whyLabel = (why: string): string => {
  switch (why) {
    case "step_up":
      return "The server wants more access than the sign-in has";
    case "rejected":
      return "The server rejected the sign-in";
    case "refresh_failing":
      return "The sign-in could not be renewed";
    default:
      return "Not signed in";
  }
};

/** What a card takes: its request, the Session it is in, whether declining is off, the subagent that asked, and the decline. */
type CardProps = {
  request: McpSignInRequest;
  sessionId: string;
  disabled: boolean;
  agent?: string | undefined;
  /** Sends the decline; resolves to the Session's refusal, or null when it took it. */
  onDecline: (reason: string | undefined) => Promise<string | null>;
};

/**
 * The card for one Sign-in request. While the Session is not live Decline is off and the card reads "Reconnecting…"; the
 * Sign in link still works, because the sign-in happens on the start page and not over the socket.
 */
export const McpSignInCard = ({ request, sessionId, disabled, agent, onDecline }: CardProps) => {
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const origin = sourceLabel(request.source);
  const off = disabled || sent;

  const href = mcpSignInRequestHref({
    environment: request.environment,
    server: request.server,
    session: sessionId,
    request: request.id,
    stepUp: request.why === "step_up",
    returnPath: sessionPath(sessionId),
  });

  return (
    <section
      id={requestCardId(request.id)}
      aria-label={`${request.server} needs you to sign in`}
      className="mx-auto mb-3 flex w-full max-w-3xl flex-col gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm short:gap-2 short:py-2"
    >
      <div>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound className="size-4 shrink-0" aria-hidden />
          {request.server} needs you to sign in
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {agent === undefined ? "the agent" : `subagent ${agent}`} asked · {whyLabel(request.why)}
          {origin === undefined ? null : (
            <span className="ml-2 rounded border px-1 py-0.5 text-[0.7rem]">{origin}</span>
          )}
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Server</dt>
        <dd className="font-mono break-all">{request.urlHost}</dd>
        {request.issuerHost === undefined ? null : (
          <>
            <dt className="text-muted-foreground">Signs in at</dt>
            <dd className="font-mono break-all">{request.issuerHost}</dd>
          </>
        )}
        {request.scopes.length === 0 ? null : (
          <>
            <dt className="text-muted-foreground">Access</dt>
            <dd className="font-mono break-all">{Arr.join(request.scopes, " ")}</dd>
          </>
        )}
      </dl>
      <blockquote className="border-l-2 pl-3 text-sm whitespace-pre-wrap">
        <span className="block text-xs text-muted-foreground">The agent says:</span>
        {request.reason}
      </blockquote>
      {request.problem === undefined ? null : (
        <p role="status" className="text-xs text-destructive">
          {request.problem}
        </p>
      )}
      {refusal === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {refusal}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {disabled
            ? "Reconnecting…"
            : "Opens in a new tab; the agent continues once you are signed in"}
        </span>
        <div className="flex items-center gap-2">
          <Input
            aria-label="Why you decline (optional, the agent sees it)"
            placeholder="Why not (optional)"
            className="h-8 w-48 text-xs"
            value={reason}
            disabled={off}
            maxLength={300}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={off}
            onClick={() => {
              setSent(true);
              setRefusal(null);
              void onDecline(reason.trim() === "" ? undefined : reason.trim()).then((refused) => {
                if (refused === null) return;

                setSent(false);
                setRefusal(refused);
              });
            }}
          >
            Decline
          </Button>
          <a href={href} target="_blank" rel="noopener" className={buttonVariants({ size: "sm" })}>
            Sign in
          </a>
        </div>
      </div>
    </section>
  );
};

/** The cards for the Sign-in requests waiting for the owner in the Session shown, oldest first. */
export const McpSignInRequests = () => {
  const sessionId = useShownSessionId();
  const requests = useAtomValue(mcpSignInRequestsAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  // Declined only over a live socket; the cards stay, off, while it is not.
  const disabled = useAtomValue(sessionStatusAtom(sessionId), (status) => status !== "live");
  const decline = useAtomSet(declineMcpSignInAtom(sessionId), { mode: "promiseExit" });

  return Arr.map(requests, (request) => (
    <McpSignInCard
      key={request.id}
      request={request}
      sessionId={sessionId}
      disabled={disabled}
      agent={agentLabel(graph, request.conversationId)}
      onDecline={(reason) =>
        decline(
          reason === undefined ? { request: request.id } : { request: request.id, reason },
        ).then(exitFailure)
      }
    />
  ));
};
