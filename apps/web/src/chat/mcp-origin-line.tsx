// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
// The line under a waiting MCP question's header that says who is waiting (`docs/architecture/mcp-server-requests.md` →
// Questions, Elicitation requests): "during `mcp__github__create_issue` · the agent" (or "· subagent <name>") for a tool's
// call, "getting prompt <title>" for the `prompts/get` of a prompt send, with the badge of where the server's definition is.
import type { McpElicitationSource } from "@cloudpid/protocol";
import { countdown, sourceLabel } from "./mcp-elicitation-form.ts";

/** The part of a waiting question that says where it came from: a tool's call, or a prompt send. */
export type McpAsker = {
  readonly server: string;
  readonly tool: string;
  /** The title of the prompt whose send asks it, when it is a prompt send's. */
  readonly prompt?: string | undefined;
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
      {request.prompt === undefined ? (
        <>
          during <span className="font-mono">{request.tool}</span> ·{" "}
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

/** What a question with a deadline says about it: a call ends then, and a prompt send's get goes on without an answer. */
export const endsLine = (request: McpAsker, deadline: number, now: number): string =>
  request.prompt === undefined
    ? `${request.server}'s call ends in ${countdown(deadline, now)}`
    : `${request.server}'s prompt goes on without an answer in ${countdown(deadline, now)}`;
