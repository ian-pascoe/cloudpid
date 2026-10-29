// What the coordinator tools return to programs (`docs/architecture/agent-capabilities.md` → Subagents): each tool's
// `structuredOutput`, which a `codemode` script gets from its call, declared as the tool's `structuredOutputSchema`
// (`docs/architecture/agent-capabilities.md` → Values for programs).
// pi-durable checks a nested call's structured output against it, and turns one from a tool that declares none into an
// error. A child's answer is cut to `MAX_CHILD_OUTPUT_BYTES` stored, since a nested call's result is one SQLite row.
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";

/** The most a child's answer weighs stored in a structured output, so it fits one nested call's result. */
export const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;

const AgentId = Schema.String.annotate({ description: "Canonical agent ID" });

const TurnId = Schema.NullOr(Schema.String).annotate({ description: "Turn ID, or null for none" });

const ConversationId = Schema.Int.annotate({ description: "The agent's conversation" });

const Workspace = Schema.NullOr(
  Schema.Struct({ id: Schema.String, branch: Schema.String }),
).annotate({ description: "The agent's Subagent Workspace; null when it works in its parent's" });

const Delegation = Schema.Literals(["none", "fanout"]).annotate({
  description: "fanout: it may start subagents of its own; none: it may only message",
});

const SessionContext = Schema.Literals(["omit", "inherit", "compact"]).annotate({
  description:
    "What it started with of its parent's conversation: nothing, all of it, or a summary",
});

/** `subagent`: the child started and its first turn. */
export const SpawnOutput = Schema.Struct({
  agent_id: AgentId,
  turn_id: Schema.String.annotate({ description: "Its first turn, which works on the task" }),
  conversation_id: ConversationId,
  model: Schema.String.annotate({ description: "Its model, provider/modelId" }),
  thinking_level: Schema.String.annotate({ description: "Its thinking level" }),
  role: Schema.NullOr(Schema.String).annotate({
    description: "The model role it was launched with; null for none",
  }),
  tools: Schema.Array(Schema.String).annotate({ description: "Its ordinary tools" }),
  coordinator_tools: Schema.Array(Schema.String).annotate({
    description: "Its coordinator tools: all six with fanout, else agent_message",
  }),
  tool_selection: Schema.String.annotate({
    description:
      "What tools asked for: a preset (none, read, modify), exact, or inherit when omitted",
  }),
  delegation: Delegation,
  session_context: SessionContext,
  warnings: Schema.Array(Schema.String).annotate({
    description:
      "What the launch noted of what was asked, such as a pattern that matched none of the caller's tools",
  }),
  workspace: Workspace,
});

/** `agent_message`: how the message reached its recipient. */
export const MessageOutput = Schema.Struct({
  agent_id: AgentId,
  disposition: Schema.Literals(["delivered-via-wait", "queued", "started-turn"]).annotate({
    description:
      "How it reached the recipient: through its open wait, queued into its running turn, or as a new turn",
  }),
  turn_id: TurnId,
  conversation_id: ConversationId,
});

/** `subagent_wait`: what ended the wait. */
export const WaitOutput = Schema.Struct({
  event: Schema.Literals(["turn", "message", "timeout", "steered"]).annotate({
    description:
      "What ended the wait: the turn settled, the child sent a message, the time ran out, or a message was queued for the caller",
  }),
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
  error: Schema.NullOr(Schema.String).annotate({
    description: "turn: why the turn failed; null otherwise",
  }),
  already_delivered: Schema.Boolean.annotate({
    description: "turn: the result already reached the caller automatically, so it is not repeated",
  }),
  message: Schema.NullOr(Schema.String).annotate({
    description: "message: what the child sent",
  }),
  elapsed_ms: Schema.Finite.annotate({ description: "How long the wait took" }),
});

const AgentState = Schema.Literals(["running", "idle"]).annotate({
  description: "Whether it is working on a turn now",
});

/** `subagent_status` without `agent_id`: the caller's direct children. */
export const StatusListOutput = Schema.Struct({
  agents: Schema.Array(
    Schema.Struct({
      agent_id: AgentId,
      state: AgentState,
      model: Schema.String.annotate({ description: "provider/modelId:thinking level" }),
      turns: Schema.Int.annotate({ description: "How many turns it has had" }),
      child_count: Schema.Int.annotate({ description: "How many subagents of its own it has" }),
      branch: Schema.NullOr(Schema.String).annotate({
        description: "Its Subagent Workspace's branch; null when it works in its parent's",
      }),
    }),
  ),
});

/** `subagent_status` with `agent_id`: one agent's launch contract, turns, latest answer and usage. */
export const StatusAgentOutput = Schema.Struct({
  agent_id: AgentId,
  parent_id: AgentId.annotate({ description: "Its parent's canonical agent ID" }),
  state: AgentState,
  conversation_id: ConversationId,
  model: Schema.String.annotate({ description: "Its model, provider/modelId" }),
  thinking_level: Schema.String.annotate({ description: "Its thinking level" }),
  role: Schema.NullOr(Schema.String).annotate({
    description: "The model role it was launched with; null for none",
  }),
  tools: Schema.Array(Schema.String).annotate({ description: "Its ordinary tools" }),
  tool_selection: Schema.String.annotate({
    description:
      "What tools asked for: a preset (none, read, modify), exact, or inherit when omitted",
  }),
  delegation: Delegation,
  session_context: SessionContext,
  capability_ceiling: Schema.Array(Schema.String).annotate({
    description: "Its caller's ordinary tools at the launch, which its grant stayed within",
  }),
  task: Schema.String.annotate({ description: "The task it was launched with" }),
  child_count: Schema.Int.annotate({ description: "How many subagents of its own it has" }),
  turns: Schema.Array(
    Schema.Struct({
      turn_id: Schema.String.annotate({ description: "The turn's ID" }),
      status: Schema.Literals(["running", "completed", "failed", "aborted"]).annotate({
        description: "How the turn stands",
      }),
      delivery: Schema.NullOr(
        Schema.Literals(["wait", "pending", "auto", "duplicate", "none"]),
      ).annotate({
        description:
          "How its answer reached the parent: claimed by a wait, held while the parent is busy, reported automatically, the same as an earlier turn's, or not at all; null while running",
      }),
    }),
  ).annotate({ description: "Its recent turns" }),
  latest_output: Schema.String.annotate({ description: "Its latest answer; empty for none" }),
  latest_output_truncated: Schema.Boolean.annotate({
    description: "latest_output was cut at 1 MiB",
  }),
  usage: Schema.Struct({
    total_tokens: Schema.Finite.annotate({ description: "Tokens it used" }),
    cost: Schema.Finite.annotate({ description: "What it cost, in dollars" }),
  }).annotate({ description: "What its turns used, together" }),
  workspace: Workspace,
});

/** `subagent_status`: the list, or one agent. */
export const StatusOutput = Schema.Union([StatusListOutput, StatusAgentOutput]);

/** `subagent_cancel`: the agents whose work was stopped. */
export const CancelOutput = Schema.Struct({
  agent_id: AgentId,
  affected_agent_ids: Schema.Array(Schema.String).annotate({
    description: "The agents whose work was stopped: it and, recursively, those below it",
  }),
});

/** `subagent_delete`: the agents deleted with it, whose IDs are retired. */
export const DeleteOutput = Schema.Struct({
  agent_id: AgentId,
  deleted_agent_ids: Schema.Array(Schema.String).annotate({
    description: "The agents deleted: it and, recursively, those below it",
  }),
});
