// The Agent changes an `environment_*` or `settings_*` call made (`docs/spec.md` → Agent changes), as its card shows
// them: the Environment (none for the Settings), the field, and its values before and after, in full (a variable's value
// is plain).

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { TranscriptPart } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A change as a card shows it. */
export const ShownChange = Schema.Struct({
  /** The Environment changed; absent for a change to the Settings. */
  environment: Schema.optionalKey(Schema.Struct({ id: Schema.String, name: Schema.String })),
  field: Schema.String,
  before: Schema.NullOr(Schema.Json),
  after: Schema.NullOr(Schema.Json),
});

export type ShownChange = typeof ShownChange.Type;

const decodeDetails = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({ agentChange: ShownChange }),
    Schema.Struct({ agentChanges: Schema.Array(ShownChange) }),
  ]),
);

const decodeArtifact = Schema.decodeUnknownOption(
  Schema.Struct({ changes: Schema.Array(ShownChange) }),
);

/**
 * The changes a result's details record: the one an `environment_*` call made (`agentChange`), or those of a
 * `settings_*` call (`agentChanges`, one for each setting it changed); none for a call that changed nothing.
 */
export const madeChanges = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
): ReadonlyArray<ShownChange> =>
  Option.match(decodeDetails(details), {
    onNone: () => [],
    onSome: (found) => ("agentChange" in found ? [found.agentChange] : found.agentChanges),
  });

/** The changes a card's artifact holds, if it holds any. */
export const changesOf = (
  artifact: ToolCallMessagePartProps["artifact"],
): ReadonlyArray<ShownChange> =>
  Option.match(decodeArtifact(artifact), {
    onNone: () => [],
    onSome: (found) => found.changes,
  });
