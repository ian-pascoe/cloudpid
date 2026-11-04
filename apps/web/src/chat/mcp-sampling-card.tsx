// @effect-diagnostics preferEffectArray:off -- JSX lists of messages and tools are native arrays.
// The card for an MCP server's Sampling request (`docs/architecture/mcp-server-requests.md` → Sampling requests, The card):
// "<server> asks to use a model", what it asked (the system prompt, the messages, the tools it offers, what cloudpid
// changed), the Role and model that would answer, and the owner's choices: Allow for this call (the main button; its menu
// has Allow in this Session and Always allow) or Refuse (its menu has Refuse in this Session and Never). Always allow and
// Never write the server's definition, so they are offered only where the owner may (`writable`). A Role picker names
// the Role to run it on; it starts on the one the Session chose. Everything shown is plain text, made by the Session.
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
 * What a card takes: its request, whether answering is off, the clock (a test gives its own), the subagent that asked
 * (none for the root agent), and the owner's answer, which ends with the Session's refusal of it, or null.
 */
type CardProps = {
  request: McpSamplingRequest;
  disabled: boolean;
  now?: number;
  agent?: string | undefined;
  onAnswer: (choice: McpSamplingChoice, role?: McpSamplingRole) => Promise<string | null>;
};

/** Whether `role` is one this build can pick: a Role a later build adds is shown, never chosen. */
const isRole = Schema.is(McpSamplingRole);

/** What Always allow and Never change, which the owner is told when it is every Environment's. */
const reach = (request: McpSamplingRequest): string =>
  request.source?.kind === "global" ? " (every Environment)" : "";

/** The card for one MCP Sampling request. */
export const McpSamplingCard = ({
  request,
  disabled,
  now: fixedNow,
  agent,
  onAnswer,
}: CardProps) => {
  const [sent, setSent] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [role, setRole] = useState(request.role);
  const now = useNow(fixedNow);
  const off = disabled || sent;
  const origin = sourceLabel(request.source);

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
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          during <span className="font-mono">{request.tool}</span> ·{" "}
          {agent === undefined ? "the agent" : `subagent ${agent}`}
          {origin === undefined ? null : (
            <span className="ml-2 rounded border px-1 py-0.5 text-[0.7rem]">{origin}</span>
          )}
        </p>
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
        <SamplingAsked
          systemPrompt={request.systemPrompt}
          omitted={request.omitted}
          messages={request.messages}
          tools={request.tools}
          notes={request.notes}
        />
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
            : request.waits === "owner"
              ? `${request.server} waits for your answer`
              : `${request.server}'s call ends in ${countdown(request.deadline, now)}`}
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

/** The cards for the MCP Sampling requests waiting for the owner in the Session shown, oldest first. */
export const McpSamplingRequests = () => {
  const sessionId = useShownSessionId();
  const requests = useAtomValue(mcpSamplingRequestsAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  // Answered only over a live socket; the cards stay, off, while it is not.
  const disabled = useAtomValue(sessionStatusAtom(sessionId), (status) => status !== "live");
  const answer = useAtomSet(answerMcpSamplingAtom(sessionId), { mode: "promiseExit" });

  return Arr.map(requests, (request) => (
    <McpSamplingCard
      key={request.id}
      request={request}
      disabled={disabled}
      agent={agentLabel(graph, request.conversationId)}
      onAnswer={(choice, role) =>
        answer(
          role === undefined
            ? { request: request.id, choice }
            : { request: request.id, choice, role },
        ).then(exitFailure)
      }
    />
  ));
};
