// The Agent change an `environment_*` call made (`docs/spec.md` → Agent changes), as its card shows it: the
// Environment, the field, and its values before and after, in full (a variable's value is plain).

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { TranscriptPart } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A change as a card shows it. */
export const ShownChange = Schema.Struct({
  environment: Schema.Struct({ id: Schema.String, name: Schema.String }),
  field: Schema.String,
  before: Schema.NullOr(Schema.Json),
  after: Schema.NullOr(Schema.Json),
});

export type ShownChange = typeof ShownChange.Type;

const decodeDetails = Schema.decodeUnknownOption(Schema.Struct({ agentChange: ShownChange }));

const decodeArtifact = Schema.decodeUnknownOption(Schema.Struct({ change: ShownChange }));

/** The change a result's details record, or none for a call that changed nothing. */
export const madeChange = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
): ShownChange | undefined =>
  Option.getOrUndefined(Option.map(decodeDetails(details), (found) => found.agentChange));

/** The change a card's artifact holds, if it does. */
export const changeOf = (artifact: ToolCallMessagePartProps["artifact"]): ShownChange | undefined =>
  Option.getOrUndefined(Option.map(decodeArtifact(artifact), (found) => found.change));
