// What tools give programs (`docs/architecture/agent-capabilities.md` → Values for programs): a tool that declares
// `structuredOutputSchema` returns a `structuredOutput` matching it, which a `codemode` script gets as the value of its
// call; pi-durable checks it against the schema. This module holds what the tools share: the schema as a tool declares
// it, the bounds on a list or text in a value (a nested call's value is one SQLite row, held to
// `MAX_NESTED_STRUCTURED_OUTPUT_BYTES` by `ResultBounds`: see `docs/architecture/workspace.md` → The rest of one tool
// result), and the shapes of an Agent change and an Approval, which the Environment, Settings and Approval tools share.
// Keys are snake_case, and "none" is null rather than a missing key.
// @effect-diagnostics missingPipeableSignature:off
import type { AgentChange } from "@cloudpid/protocol";
import type {
  AgentChangeOutput,
  ApprovalOutcome,
  ScopeRef,
} from "@cloudpid/protocol/harness-tools";
import type { JsonValue } from "@earendil-works/chord/json";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { cutStored, type Stored, storedBytes } from "./stored-bytes.ts";

// The shapes of an Agent change and an Approval are the shared declarations' (`@cloudpid/protocol/harness-tools`), since
// the endpoint declares the same tools; they are re-exported here, where the tools have always imported them from.
export {
  AgentChangeOutput,
  ApprovalOutcome,
  ChangeOutput,
  ChangeOutputFields,
  EnvironmentChangeOutput,
  ScopeRef,
} from "@cloudpid/protocol/harness-tools";

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
 * The most one part of a tool's value (a list, or a text without a bound) weighs stored by default, far under the cap
 * of a nested call's value (`MAX_NESTED_STRUCTURED_OUTPUT_BYTES`, 1.5 MiB), so a value with a few of them still fits.
 * A value with more parts gives each a smaller bound, so that together they stay under 1 MiB.
 */
export const MAX_PART_BYTES = 256 * 1024;

/** The first of `items` while they fit `maxBytes` stored together, and whether any were left out. */
export const boundItems = <A extends Stored>(
  items: ReadonlyArray<A>,
  maxBytes: number = MAX_PART_BYTES,
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
export const boundText = (text: string, maxBytes: number = MAX_PART_BYTES) => {
  const cut = cutStored(text, maxBytes, "");

  return { text: cut, truncated: cut !== text };
};

/** A value of a tool's output as the `JsonValue` a result carries; the two describe the same values. */
// SAFETY: a Schema type of JSON values is JSON; its arrays are only read-only where `JsonValue`'s are mutable.
export const asOutput = <S extends Schema.Top>(_schema: S, value: S["Type"]): JsonValue =>
  value as JsonValue;

/** An Environment or Global, by id and name, as a value gives it. */
export const scopeRef = ({
  id,
  name,
}: {
  readonly id: string;
  readonly name: string;
}): typeof ScopeRef.Type => ({ id, name });

/**
 * The Environments that override something (a setting, a variable, a Skill), as many as fit `maxBytes`, and whether
 * any were left out.
 */
export const overriddenInOutput = (
  environments: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  maxBytes: number = MAX_PART_BYTES,
) => {
  const { items, truncated } = boundItems(Arr.map(environments, scopeRef), maxBytes);

  return { overridden_in: items, overridden_in_truncated: truncated };
};

/**
 * The most an Agent change's `before` or `after` weighs stored in a value. The values a tool sets are mostly far
 * smaller (a script or the Instructions are at most 64 KiB of text, which escapes to more), but one change can hold a
 * list without a bound, such as an Environment's Repos.
 */
export const MAX_CHANGE_VALUE_BYTES = 128 * 1024;

/** The owner approved. */
export const APPROVED: typeof ApprovalOutcome.Type = { approved: true, reason: null };

/** The owner's answer as a value gives it: approved, or declined with their reason (null when they gave none). */
export const approvalOutput = (
  answer:
    | { readonly approved: true }
    | { readonly approved: false; readonly reason?: string | undefined },
): typeof ApprovalOutcome.Type =>
  answer.approved ? APPROVED : { approved: false, reason: answer.reason ?? null };

/** `value`, or null with a flag when it weighs more than `MAX_CHANGE_VALUE_BYTES` stored. */
const changeValue = (value: Schema.Json | null) =>
  storedBytes(value) > MAX_CHANGE_VALUE_BYTES
    ? { value: null, truncated: true }
    : { value, truncated: false };

/** `change` as a value gives it, each of its values left out when too large. */
export const agentChangeOutput = (change: AgentChange): typeof AgentChangeOutput.Type => {
  const before = changeValue(change.before);
  const after = changeValue(change.after);

  return {
    id: change.id,
    field: change.field,
    before: before.value,
    before_truncated: before.truncated,
    after: after.value,
    after_truncated: after.truncated,
    before_inherited: change.beforeInherited === true,
    after_inherited: change.afterInherited === true,
  };
};

/** `changes` as a value gives them: the first that fit `MAX_PART_BYTES`, and whether any were left out. */
export const changesOutput = (changes: ReadonlyArray<AgentChange>) => {
  const { items, truncated } = boundItems(Arr.map(changes, agentChangeOutput));

  return { changes: items, changes_truncated: truncated };
};
