// What tools give programs (`docs/architecture/agent-capabilities.md` → Values for programs): a tool that declares
// `structuredOutputSchema` returns a `structuredOutput` matching it, which a `codemode` script gets as the value of its
// call; pi-durable checks it against the schema. This module holds what the tools share: the schema as a tool declares
// it, the bounds on a list or text in a value (a nested call's value is one SQLite row, held to
// `MAX_NESTED_STRUCTURED_OUTPUT_BYTES` by `ResultBounds`: see `docs/architecture/workspace.md` → The rest of one tool
// result), and the shapes of an Agent change and an Approval, which the Environment, Settings and Approval tools share.
// Keys are snake_case, and "none" is null rather than a missing key.
// @effect-diagnostics missingPipeableSignature:off
import type { AgentChange } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { cutStored, type Stored, storedBytes } from "./stored-bytes.ts";

/**
 * `schema` as a tool's `structuredOutputSchema`: its JSON Schema, which must hold no definitions, since a tool declares
 * one schema without them (an identified or recursive schema would leave a dangling `$ref`).
 */
export const outputSchema = <S extends Schema.Top>(schema: S) => {
  const document = Schema.toJsonSchemaDocument(schema);

  if (!Record.isEmptyRecord(document.definitions)) {
    throw new Error("An output schema must not hold identified or recursive schemas");
  }

  return document.schema;
};

/**
 * The most one list or text in a tool's value weighs stored, far under the cap of a nested call's value
 * (`MAX_NESTED_STRUCTURED_OUTPUT_BYTES`, 1.5 MiB), so a value with a few of them still fits.
 */
export const MAX_LIST_BYTES = 256 * 1024;

/** The first of `items` while they fit `maxBytes` stored together, and whether any were left out. */
export const boundItems = <A extends Stored>(
  items: ReadonlyArray<A>,
  maxBytes: number = MAX_LIST_BYTES,
) => {
  // The brackets of the array, then each item and the comma before it.
  let used = 2;
  let kept = 0;

  for (const item of items) {
    const weight = storedBytes(item) + (kept === 0 ? 0 : 1);

    if (used + weight > maxBytes) break;

    used += weight;
    kept++;
  }

  return {
    items: kept === items.length ? items : items.slice(0, kept),
    truncated: kept < items.length,
  };
};

/** `text` cut to `maxBytes` stored, and whether it was. */
export const boundText = (text: string, maxBytes: number = MAX_LIST_BYTES) => {
  const cut = cutStored(text, maxBytes, "");

  return { text: cut, truncated: cut !== text };
};

/** A value of a tool's output as the `JsonValue` a result carries; the two describe the same values. */
// SAFETY: a Schema type of JSON values is JSON; its arrays are only read-only where `JsonValue`'s are mutable.
export const asOutput = <S extends Schema.Top>(_schema: S, value: S["Type"]): JsonValue =>
  value as JsonValue;

/** An Environment, or Global (id `*`), by id and name. */
export const ScopeRef = Schema.Struct({
  id: Schema.String.annotate({ description: 'The Environment\'s id, or "*" for Global' }),
  name: Schema.String,
});

/** The owner's answer to a change that waits for their Approval; null for a change that does not. */
export const ApprovalOutcome = Schema.NullOr(
  Schema.Struct({
    approved: Schema.Boolean,
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
  before: Schema.NullOr(Schema.Json).annotate({ description: "Its value before; null for none" }),
  after: Schema.NullOr(Schema.Json).annotate({ description: "Its value after; null for none" }),
  before_inherited: Schema.Boolean.annotate({
    description: "At an Environment, the value before was inherited from Global",
  }),
  after_inherited: Schema.Boolean.annotate({
    description: "At an Environment, the value after is inherited from Global (a reset)",
  }),
});

/** `change` as a value gives it. */
export const agentChangeOutput = (change: AgentChange): typeof AgentChangeOutput.Type => ({
  id: change.id,
  field: change.field,
  before: change.before,
  after: change.after,
  before_inherited: change.beforeInherited === true,
  after_inherited: change.afterInherited === true,
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
  unchanged: Schema.Array(Schema.String).annotate({
    description: "The fields that already had their value, so nothing was saved for them",
  }),
  approval: ApprovalOutcome,
};

export const ChangeOutput = Schema.Struct(ChangeOutputFields);

/** A Container setting changed at an Environment or at Global, and whom it reached. */
export const EnvironmentChangeOutput = Schema.Struct({
  ...ChangeOutputFields,
  own: Schema.Boolean.annotate({
    description: "The change reaches this Session's own Workspace",
  }),
  new_build: Schema.Boolean.annotate({
    description: "A new Build was asked for in the Environment changed",
  }),
  global: Schema.NullOr(
    Schema.Struct({
      overridden_in: Schema.Array(ScopeRef).annotate({
        description: "The Environments that override the field, so the change does not reach them",
      }),
      new_builds: Schema.Array(ScopeRef).annotate({
        description: "The Environments in which a new Build was asked for",
      }),
    }),
  ).annotate({ description: "For a change at Global, how it reached the Environments; else null" }),
});
