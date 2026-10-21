// The subagent a `subagent` tool call started, as its card needs it: which conversation to open.

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { TranscriptPart } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A subagent the owner can open: its canonical ID, and the conversation to watch. */
export const StartedSubagent = Schema.Struct({
  agentId: Schema.String,
  conversationId: Schema.Finite,
});

export type StartedSubagent = typeof StartedSubagent.Type;

const Details = Schema.Struct({ agent_id: Schema.String, conversation_id: Schema.Finite });

const decodeDetails = Schema.decodeUnknownOption(Details);

const decodeStarted = Schema.decodeUnknownOption(Schema.Struct({ subagent: StartedSubagent }));

/** The subagent a `subagent` result's details name, or none for a refused call. */
export const startedSubagent = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
): StartedSubagent | undefined =>
  Option.getOrUndefined(
    Option.map(decodeDetails(details), (found) => ({
      agentId: found.agent_id,
      conversationId: found.conversation_id,
    })),
  );

/** The subagent a card's artifact names, if it does. */
export const subagentOf = (
  artifact: ToolCallMessagePartProps["artifact"],
): StartedSubagent | undefined =>
  Option.getOrUndefined(Option.map(decodeStarted(artifact), (found) => found.subagent));
