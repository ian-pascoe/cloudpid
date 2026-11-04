// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- JSX lists of messages and tools are native arrays.
// The card for an MCP server's Sampling requests (`docs/architecture/mcp-server-requests.md` → Sampling requests, The card):
// one per waiting call, listing the call's requests: "<server> asks to use a model", what each asked (the system prompt,
// the messages, the tools it offers, what cloudpid changed), the Role and model that would answer, and one decision for
// all of them: Allow for this call (the main button; its menu has Allow in this Session and Always allow) or Refuse (its
// menu has Refuse in this Session and Never). Always allow and Never write the server's definition, so they are offered
// only where the owner may (`writable`). A Role picker names the Role to run them on; it starts on the one the Session
// chose for the first. A form the call also waits on is its own card; this one says so. The wire sends one request each,
// grouped here by `callId`. Everything shown is plain text, made by the Session.
import {
  McpSamplingRole,
  type McpSamplingChoice,
  type McpSamplingRequest,
} from "@cloudpid/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChevronDown, Cpu } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Menu, MenuItem } from "../components/ui/menu.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { exitFailure } from "../registry.ts";
import { agentLabel } from "../session/agents.ts";
import {
  answerMcpSamplingAtom,
  mcpElicitationRequestsAtom,
  mcpSamplingRequestsAtom,
  sessionStatusAtom,
  taskGraphAtom,
} from "../session/atoms.ts";
import { useShownSessionId } from "./conversation.ts";
import { useNow } from "./mcp-elicitation-card.tsx";
import { countdown, sourceLabel } from "./mcp-elicitation-form.ts";
import { SamplingAsked } from "./mcp-sampling-asked.tsx";
import { requestCardId } from "./request-anchor.ts";

/**
 * What a card takes: the call's waiting requests (at least one, oldest first), what else the call waits on (`also`, the
 * forms and pages the owner is shown on their own cards), whether answering is off, the clock (a test gives its own), the
 * subagent that asked (none for the root agent), and the owner's answer, which ends with the Session's refusal of it, or
 * null. The answer is the first request's: the Session applies it to every request of the call.
 */
type CardProps = {
  requests: Arr.NonEmptyReadonlyArray<McpSamplingRequest>;
  also?: AlsoWaiting | undefined;
  disabled: boolean;
  now?: number;
  agent?: string | undefined;
  onAnswer: (choice: McpSamplingChoice, role?: McpSamplingRole) => Promise<string | null>;
};

/** What a call waits on beside its Sampling requests: how many forms, and how many pages to open. */
export type AlsoWaiting = { readonly forms: number; readonly pages: number };

/** The requests grouped by call, in the order each call first appears. */
export const samplingCalls = (
  requests: ReadonlyArray<McpSamplingRequest>,
): ReadonlyArray<Arr.NonEmptyReadonlyArray<McpSamplingRequest>> => {
  const calls = new Map<string, Arr.NonEmptyArray<McpSamplingRequest>>();

  for (const request of requests) {
    const held = calls.get(request.callId);

    if (held === undefined) calls.set(request.callId, [request]);
    else held.push(request);
  }

  return [...calls.values()];
};

/** `count` of `noun`, said as a card does: "form", "2 forms"; nothing for none. */
const counted = (count: number, noun: string): ReadonlyArray<string> => {
  if (count === 0) return [];

  return [count === 1 ? noun : `${count} ${noun}s`];
};

/** What else the call waits on, as one line: "also waiting: docs's form". */
export const alsoLine = (server: string, also: AlsoWaiting): string | undefined => {
  const parts = [...counted(also.forms, "form"), ...counted(also.pages, "page")];

  return parts.length === 0 ? undefined : `also waiting: ${server}'s ${parts.join(" and ")}`;
};

/** Whether `role` is one this build can pick: a Role a later build adds is shown, never chosen. */
const isRole = Schema.is(McpSamplingRole);

/** What Always allow and Never change, which the owner is told when it is every Environment's. */
const reach = (request: McpSamplingRequest): string =>
  request.source?.kind === "global" ? " (every Environment)" : "";

/** The card for the MCP Sampling requests of one call. */
export const McpSamplingCard = ({
  requests,
  also,
  disabled,
  now: fixedNow,
  agent,
  onAnswer,
}: CardProps) => {
  const [request] = requests;
  const [sent, setSent] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [role, setRole] = useState(request.role);
  const now = useNow(fixedNow);
  const off = disabled || sent;
  const origin = sourceLabel(request.source);

  const alsoText = also === undefined ? undefined : alsoLine(request.server, also);

  // A call's requests each have their own deadline; the call ends with the first, unless the owner is waited for.
  const waits = Arr.every(requests, (each) => each.waits === "owner");
  const deadline = Math.min(...Arr.map(requests, (each) => each.deadline));

  const model = Arr.findFirst(request.roles, (option) => option.role === role).pipe(
    Option.match({ onNone: () => request.model, onSome: (option) => option.model }),
  );

  /** The answer, which stays on the card (buttons back on, the reason shown) if the Session refuses it. */
  const answer = (choice: McpSamplingChoice) => {
    setSent(true);
    setRefusal(null);
    void onAnswer(choice, role !== request.role && isRole(role) ? role : undefined).then(
      (refused) => {
        if (refused === null) return;

        setSent(false);
        setRefusal(refused);
      },
    );
  };

  return (
    <section
      id={requestCardId(request.id)}
      aria-label={`${request.server} asks to use a model`}
      className="mx-auto mb-3 flex max-h-[calc(var(--waiting-height,60dvh)-0.75rem)] w-full max-w-3xl flex-col gap-3 rounded-lg border bg-card px-4 py-3 shadow-sm short:gap-2 short:py-2"
    >
      <div className="shrink-0">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Cpu className="size-4 shrink-0" aria-hidden />
          {request.server} asks to use a model
          {requests.length === 1 ? null : (
            <span className="font-normal text-muted-foreground"> · {requests.length} requests</span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          during <span className="font-mono">{request.tool}</span> ·{" "}
          {agent === undefined ? "the agent" : `subagent ${agent}`}
          {origin === undefined ? null : (
            <span className="ml-2 rounded border px-1 py-0.5 text-[0.7rem]">{origin}</span>
          )}
        </p>
        {alsoText === undefined ? null : (
          <p className="mt-1 text-xs text-muted-foreground">{alsoText}</p>
        )}
      </div>
      <div
        className="min-h-12 flex-1 overflow-y-auto"
        role="region"
        aria-label="The request"
        tabIndex={0}
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor={`${requestCardId(request.id)}-role`} className="text-xs font-medium">
            Run on
          </label>
          <NativeSelect
            id={`${requestCardId(request.id)}-role`}
            value={role}
            disabled={off}
            onChange={(event) => {
              Arr.findFirst(request.roles, (option) => option.role === event.target.value).pipe(
                Option.map((option) => {
                  setRole(option.role);
                }),
              );
            }}
            className="h-8 w-auto max-w-full text-sm"
          >
            {Arr.map(
              Arr.filter(request.roles, (option) => isRole(option.role)),
              (option) => (
                <option key={option.role} value={option.role}>
                  {option.role} · {option.model}
                </option>
              ),
            )}
          </NativeSelect>
          <span className="text-xs text-muted-foreground">
            answers on <span className="font-mono">{model}</span>
          </span>
        </div>
        {Arr.map(requests, (each, index) => (
          <div
            key={each.id}
            id={index === 0 ? undefined : requestCardId(each.id)}
            className={requests.length === 1 ? undefined : "mt-3 border-t pt-2"}
          >
            {requests.length === 1 ? null : (
              <div className="text-xs font-semibold">
                Request {index + 1} of {requests.length}
              </div>
            )}
            <SamplingAsked
              systemPrompt={each.systemPrompt}
              omitted={each.omitted}
              messages={each.messages}
              tools={each.tools}
              notes={each.notes}
            />
          </div>
        ))}
      </div>
      {refusal === null ? null : (
        <p role="alert" className="shrink-0 text-xs text-destructive">
          {refusal}
        </p>
      )}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {disabled
            ? "Reconnecting…"
            : waits
              ? `${request.server} waits for your answer`
              : `${request.server}'s call ends in ${countdown(deadline, now)}`}
        </span>
        <div className="flex flex-wrap gap-2">
          <div className="flex items-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={off}
              className="rounded-r-none"
              onClick={() => {
                answer("refuse");
              }}
            >
              Refuse
            </Button>
            <Menu
              label="More ways to refuse"
              icon={<ChevronDown className="size-4" aria-hidden />}
              disabled={off}
              className="h-8 w-7 rounded-l-none border border-l-0"
            >
              <MenuItem
                onSelect={() => {
                  answer("refuse_session");
                }}
              >
                Refuse in this Session
              </MenuItem>
              {request.writable ? (
                <MenuItem
                  destructive
                  onSelect={() => {
                    answer("refuse_never");
                  }}
                >
                  Never{reach(request)}
                </MenuItem>
              ) : null}
            </Menu>
          </div>
          <div className="flex items-center">
            <Button
              type="button"
              size="sm"
              disabled={off}
              className="rounded-r-none"
              onClick={() => {
                answer("allow_call");
              }}
            >
              Allow for this call
            </Button>
            <Menu
              label="More ways to allow"
              icon={<ChevronDown className="size-4" aria-hidden />}
              disabled={off}
              className="h-8 w-7 rounded-l-none bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
            >
              <MenuItem
                onSelect={() => {
                  answer("allow_session");
                }}
              >
                Allow in this Session
              </MenuItem>
              {request.writable ? (
                <MenuItem
                  onSelect={() => {
                    answer("allow_always");
                  }}
                >
                  Always allow{reach(request)}
                </MenuItem>
              ) : null}
            </Menu>
          </div>
        </div>
      </div>
    </section>
  );
};

/** The cards for the MCP Sampling requests waiting for the owner in the Session shown: one per call, oldest first. */
export const McpSamplingRequests = () => {
  const sessionId = useShownSessionId();
  const requests = useAtomValue(mcpSamplingRequestsAtom(sessionId));
  const forms = useAtomValue(mcpElicitationRequestsAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  // Answered only over a live socket; the cards stay, off, while it is not.
  const disabled = useAtomValue(sessionStatusAtom(sessionId), (status) => status !== "live");
  const answer = useAtomSet(answerMcpSamplingAtom(sessionId), { mode: "promiseExit" });

  return Arr.map(samplingCalls(requests), (call) => {
    const [first] = call;
    const same = Arr.filter(forms, (form) => form.callId === first.callId);

    return (
      <McpSamplingCard
        key={first.callId}
        requests={call}
        also={{
          forms: Arr.filter(same, (form) => form.page === undefined).length,
          pages: Arr.filter(same, (form) => form.page !== undefined).length,
        }}
        disabled={disabled}
        agent={agentLabel(graph, first.conversationId)}
        onAnswer={(choice, role) =>
          answer(
            role === undefined
              ? { request: first.id, choice }
              : { request: first.id, choice, role },
          ).then(exitFailure)
        }
      />
    );
  });
};
