// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
// The line under a waiting MCP question's header that says who is waiting (`docs/architecture/mcp-server-requests.md` →
// Questions, Elicitation requests): "during `mcp__github__create_issue` · the agent" (or "· subagent <name>") for a tool's
// call, "getting prompt <title>" for the `prompts/get` of a prompt send, "<server>'s app" for a call an App View made (drawn in
// the waiting area, never inside the View), "during `mcp__github__deploy` · MCP task mcp-task-3" for a question of an MCP
// task that goes on after its call, with the badge of where the server's definition is.
import type { McpElicitationSource } from "@cloudpid/protocol";
import { countdown, sourceLabel } from "./mcp-elicitation-form.ts";

/** The part of a waiting question that says where it came from: a tool's call, or a prompt send. */
export type McpAsker = {
  readonly server: string;
  readonly tool: string;
  /** The title of the prompt whose send asks it, when it is a prompt send's. */
  readonly prompt?: string | undefined;
  /** Whether it was asked in a `tools/call` of an App View. */
  readonly app?: true | undefined;
  /** The handle of the MCP task whose question it is, when it is one's ("MCP task <handle>"). */
  readonly task?: string | undefined;
  readonly source?: McpElicitationSource | undefined;
};

export const McpOriginLine = ({
  request,
  agent,
}: {
  request: McpAsker;
  /** The subagent that asked (none for the root agent). */
  agent: string | undefined;
}) => {
  const badge = sourceLabel(request.source);

  return (
    <p className="mt-1 text-xs text-muted-foreground">
      {request.task === undefined && request.app === true ? (
        `${request.server}'s app`
      ) : request.task !== undefined || request.prompt === undefined ? (
        <>
          during <span className="font-mono">{request.tool}</span> ·{" "}
          {request.task === undefined ? null : `MCP task ${request.task} · `}
          {agent === undefined ? "the agent" : `subagent ${agent}`}
        </>
      ) : (
        `getting prompt ${request.prompt}`
      )}
      {badge === undefined ? null : (
        <span className="ml-2 rounded border px-1 py-0.5 text-[0.7rem]">{badge}</span>
      )}
    </p>
  );
};

/**
 * What a question with a deadline says about it: a call ends then, and a prompt send's get or an App View's call goes on
 * without an answer.
 */
export const endsLine = (request: McpAsker, deadline: number, now: number): string => {
  // A task's is first, as in `askOriginOf`.
  if (request.task === undefined && request.app === true) {
    return `${request.server}'s app goes on without an answer in ${countdown(deadline, now)}`;
  }

  return request.task !== undefined || request.prompt === undefined
    ? `${request.server}'s call ends in ${countdown(deadline, now)}`
    : `${request.server}'s prompt goes on without an answer in ${countdown(deadline, now)}`;
};
