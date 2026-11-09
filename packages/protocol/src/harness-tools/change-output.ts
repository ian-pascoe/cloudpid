// What a tool that makes Agent changes gives programs, on both surfaces (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Shared definitions and the core/wrapper split; `docs/architecture/agent-capabilities.md`
// → Values for programs): the Agent change as the Registry recorded it, the Scope, the fields left alone, the owner's
// Approval where a change waits for it, and, for a Container setting, whom a change reached. The in-session shapes are
// the ones the tools have always declared (`packages/extensions/src/harness-session.test.ts` pins them); the endpoint's
// are flat objects with optional keys: `next` (`McpServer` fills it), `replayed` (an answer built from the records of an
// earlier call with the same `request_id`), and `new_build` (known only to the write that ran the Builds' upkeep).
// @effect-diagnostics missingPipeableSignature:off
import * as Schema from "effect/Schema";
import { NextField } from "./field-page.ts";
import { ScopeRef } from "./scope.ts";

/** The owner's answer to a change that waits for their Approval; null for a change that does not. */
export const ApprovalOutcome = Schema.NullOr(
  Schema.Struct({
    approved: Schema.Boolean.annotate({ description: "The owner approved the change" }),
    reason: Schema.NullOr(Schema.String).annotate({
      description: "Why the owner declined; null when they approved or gave none",
    }),
  }),
).annotate({ description: "The owner's Approval; null for a change that does not wait for it" });

/** One Agent change, as the Registry recorded it. */
export const AgentChangeOutput = Schema.Struct({
  id: Schema.Finite.annotate({ description: "The Agent change's number in the Registry" }),
  field: Schema.String.annotate({
    description: "What changed: a setting's path, or variables.<NAME> for a variable",
  }),
  before: Schema.NullOr(Schema.Json).annotate({
    description: "Its value before; null for none, or when before_truncated",
  }),
  before_truncated: Schema.Boolean.annotate({
    description: "The value before was too large to give (over 128 KiB), so before is null",
  }),
  after: Schema.NullOr(Schema.Json).annotate({
    description: "Its value after; null for none, or when after_truncated",
  }),
  after_truncated: Schema.Boolean.annotate({
    description: "The value after was too large to give (over 128 KiB), so after is null",
  }),
  before_inherited: Schema.Boolean.annotate({
    description: "At an Environment, the value before was inherited from Global",
  }),
  after_inherited: Schema.Boolean.annotate({
    description: "At an Environment, the value after is inherited from Global (a reset)",
  }),
});

/**
 * What a tool that makes Agent changes at one Scope gives programs: the Scope, the changes it made, the fields that
 * already had their value, and the owner's Approval where the change waits for it. An Environment's Container setting
 * tools add how a change reached the Environments (`EnvironmentChangeOutput`).
 */
export const ChangeOutputFields = {
  scope: ScopeRef,
  changes: Schema.Array(AgentChangeOutput).annotate({
    description: "The Agent changes made; empty when nothing changed",
  }),
  changes_truncated: Schema.Boolean.annotate({
    description: "Some changes were left out, the list being too large to give",
  }),
  unchanged: Schema.Array(Schema.String).annotate({
    description: "The fields that already had their value, so nothing was saved for them",
  }),
  approval: ApprovalOutcome,
};

export const ChangeOutput = Schema.Struct(ChangeOutputFields);

/** How a change at Global reached the Environments. */
const GlobalReachOutput = Schema.Struct({
  overridden_in: Schema.Array(ScopeRef).annotate({
    description: "The Environments that override the field, so the change does not reach them",
  }),
  overridden_in_truncated: Schema.Boolean.annotate({
    description: "More Environments override it than fit this value: the first are listed",
  }),
  new_builds: Schema.Array(ScopeRef).annotate({
    description: "The Environments in which a new Build was asked for",
  }),
  new_builds_truncated: Schema.Boolean.annotate({
    description: "More Builds were asked for than fit this value: the first are listed",
  }),
});

/** A Container setting changed at an Environment or at Global, and whom it reached. */
export const EnvironmentChangeOutput = Schema.Struct({
  ...ChangeOutputFields,
  own: Schema.Boolean.annotate({
    description: "The change reaches this Session's own Workspace",
  }),
  new_build: Schema.Boolean.annotate({
    description: "A new Build was asked for in the Environment changed",
  }),
  global: Schema.NullOr(GlobalReachOutput).annotate({
    description: "For a change at Global, how it reached the Environments; else null",
  }),
});

/**
 * What every endpoint answer of a change carries besides the change: `next`, and `replayed` when the answer was built
 * from the Agent changes an earlier call with the same `request_id` recorded, which kept no answer of its own.
 */
export const ReplayFields = {
  ...NextField,
  replayed: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description:
        "This answer was built from the Agent changes an earlier call with the same request_id recorded: the full answer was not kept",
    }),
  ),
};

/**
 * A change recorded at one Scope, on the endpoint (`environment_secret_build`): the Scope, the changes made, and the
 * fields left alone. There is no Session, so nothing is this Session's own, and the tools here wait for no Approval.
 */
export const ChangeEndpointOutput = Schema.Struct({
  ...ReplayFields,
  scope: ChangeOutputFields.scope,
  changes: ChangeOutputFields.changes,
  changes_truncated: ChangeOutputFields.changes_truncated,
  unchanged: ChangeOutputFields.unchanged,
});

/**
 * A Container setting changed at an Environment or at Global, on the endpoint: as `ChangeEndpointOutput`, with whether
 * a new Build was asked for (absent when the answer is replayed: `environment_get` shows the Build) and, for a change
 * at Global, whom it reached (null when not known, as for a replayed answer).
 */
export const EnvironmentChangeEndpointOutput = Schema.Struct({
  ...ChangeEndpointOutput.fields,
  new_build: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "A new Build was asked for in the Environment changed; absent when not known (a replayed answer): environment_get shows the Build",
    }),
  ),
  global: Schema.NullOr(GlobalReachOutput).annotate({
    description:
      "For a change at Global, how it reached the Environments; null for a change at an Environment, and when not known",
  }),
});
