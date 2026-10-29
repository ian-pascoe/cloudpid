// What the coordinator tools return to programs (`docs/architecture/agent-capabilities.md` → Subagents): each tool's
// `structuredOutput`, which a `codemode` script gets from its call, declared as the tool's `structuredOutputSchema`.
// pi-durable checks a nested call's structured output against it, and turns one from a tool that declares none into an
// error. A child's answer is cut to `MAX_CHILD_OUTPUT_BYTES` stored, since a nested call's result is one SQLite row.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";
import { boundText } from "../outputs.ts";

/** The most a child's answer weighs stored in a structured output, so it fits one nested call's result. */
export const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;

/** `text` cut to `MAX_CHILD_OUTPUT_BYTES` stored, and whether it was. */
export const boundChildOutput = (text: string) => boundText(text, MAX_CHILD_OUTPUT_BYTES);

const AgentId = Schema.String.annotate({ description: "Canonical agent ID" });

const TurnId = Schema.NullOr(Schema.String).annotate({ description: "Turn ID, or null for none" });

const ConversationId = Schema.Int.annotate({ description: "The agent's conversation" });

const Workspace = Schema.NullOr(
  Schema.Struct({ id: Schema.String, branch: Schema.String }),
).annotate({ description: "The agent's Subagent Workspace; null when it works in its parent's" });

const Delegation = Schema.Literals(["none", "fanout"]);

const SessionContext = Schema.Literals(["omit", "inherit", "compact"]);

/** `subagent`: the child started and its first turn. */
export const SpawnOutput = Schema.Struct({
  agent_id: AgentId,
  turn_id: Schema.String,
  conversation_id: ConversationId,
  model: Schema.String,
  thinking_level: Schema.String,
  role: Schema.NullOr(Schema.String),
  tools: Schema.Array(Schema.String),
  coordinator_tools: Schema.Array(Schema.String),
  tool_selection: Schema.String,
  delegation: Delegation,
  session_context: SessionContext,
  warnings: Schema.Array(Schema.String),
  workspace: Workspace,
});

/** `agent_message`: how the message reached its recipient. */
export const MessageOutput = Schema.Struct({
  agent_id: AgentId,
  disposition: Schema.Literals(["delivered-via-wait", "queued", "started-turn"]),
  turn_id: TurnId,
  conversation_id: ConversationId,
});

/** `subagent_wait`: what ended the wait. */
export const WaitOutput = Schema.Struct({
  event: Schema.Literals(["turn", "message", "timeout", "steered"]),
  agent_id: AgentId,
  turn_id: TurnId,
  status: Schema.String.annotate({
    description:
      "turn: how the turn ended, or deleted; timeout and steered: whether the child is running or idle",
  }),
  output: Schema.NullOr(Schema.String).annotate({
    description: "turn: the child's answer, unless it was already delivered automatically",
  }),
  output_truncated: Schema.Boolean.annotate({ description: "output was cut at 1 MiB" }),
  error: Schema.NullOr(Schema.String),
  already_delivered: Schema.Boolean.annotate({
    description: "turn: the result already reached the caller automatically, so it is not repeated",
  }),
  message: Schema.NullOr(Schema.String).annotate({
    description: "message: what the child sent",
  }),
  elapsed_ms: Schema.Finite,
});

const AgentState = Schema.Literals(["running", "idle"]);

/** `subagent_status` without `agent_id`: the caller's direct children. */
export const StatusListOutput = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      agent_id: AgentId,
      state: AgentState,
      model: Schema.String.annotate({ description: "provider/modelId:thinking level" }),
      turns: Schema.Int,
      child_count: Schema.Int,
      branch: Schema.NullOr(Schema.String).annotate({
        description: "Its Subagent Workspace's branch; null when it works in its parent's",
      }),
    }),
  ),
});

/** `subagent_status` with `agent_id`: one agent's launch contract, turns, latest answer and usage. */
export const StatusAgentOutput = Schema.Struct({
  agent_id: AgentId,
  parent_id: AgentId,
  state: AgentState,
  conversation_id: ConversationId,
  model: Schema.String,
  thinking_level: Schema.String,
  role: Schema.NullOr(Schema.String),
  tools: Schema.Array(Schema.String),
  tool_selection: Schema.String,
  delegation: Delegation,
  session_context: SessionContext,
  capability_ceiling: Schema.Array(Schema.String),
  task: Schema.String,
  child_count: Schema.Int,
  turns: Schema.Array(
    Schema.Struct({
      turn_id: Schema.String,
      status: Schema.Literals(["running", "completed", "failed", "aborted"]),
      delivery: Schema.NullOr(Schema.Literals(["wait", "pending", "auto", "duplicate", "none"])),
    }),
  ),
  latest_output: Schema.String.annotate({ description: "Its latest answer; empty for none" }),
  latest_output_truncated: Schema.Boolean.annotate({
    description: "latest_output was cut at 1 MiB",
  }),
  usage: Schema.Struct({ total_tokens: Schema.Finite, cost: Schema.Finite }),
  workspace: Workspace,
});

/** `subagent_status`: the list, or one agent. */
export const StatusOutput = Schema.Union([StatusListOutput, StatusAgentOutput]);

/** `subagent_cancel`: the agents whose work was stopped. */
export const CancelOutput = Schema.Struct({
  agent_id: AgentId,
  affected_agent_ids: Schema.Array(Schema.String),
});

/** `subagent_delete`: the agents deleted with it, whose IDs are retired. */
export const DeleteOutput = Schema.Struct({
  agent_id: AgentId,
  deleted_agent_ids: Schema.Array(Schema.String),
});
