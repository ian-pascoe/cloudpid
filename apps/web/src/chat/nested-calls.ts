// The calls a tool made, as its card lists them: live from the view's `nestedTools` while it runs, and from the details of
// its result once it has ended (pi-durable's code mode writes `CodemodeToolDetails` there, which the view no longer has).

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over native arrays, not combinators.

import type { NestedTool, TranscriptPart } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { CallDiff, decodeRecordedDiff, toCallDiff } from "../call-diff.ts";

/** A nested call as the card shows it. */
export const NestedCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** The arguments, as far as they could be read: empty when they were cut short. */
  args: Schema.Record(Schema.String, Schema.Unknown),
  status: Schema.Literals(["running", "ok", "error", "cancelled"]),
  durationMs: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
  /** What an `edit` or `write` the script made recorded of its change; only a finished script's calls have one. */
  diff: Schema.optional(CallDiff),
});

export type NestedCall = typeof NestedCall.Type;

/** The calls of tool call `parentCallId` that are live now, in the order they started. */
export const liveCalls = (nested: readonly NestedTool[], parentCallId: string): NestedCall[] =>
  nested.flatMap((tool) => {
    if (tool.parentCallId !== parentCallId) return [];

    const call: Types.Mutable<NestedCall> = {
      id: tool.callId,
      name: tool.name,
      args: tool.args,
      status: tool.status === "running" ? "running" : tool.isError ? "error" : "ok",
    };

    if (tool.durationMs !== undefined) call.durationMs = tool.durationMs;

    if (tool.error !== undefined) call.error = tool.error;

    return [call];
  });

const Details = Schema.Struct({
  calls: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      name: Schema.String,
      /** Compact JSON, cut for display: a long call does not parse. */
      args: Schema.String,
      status: NestedCall.fields.status,
      durationMs: Schema.optional(Schema.Finite),
      error: Schema.optional(Schema.String),
    }),
  ),
  /** The Call diffs of the script's `edit` and `write` calls, by call (`id`); read one at a time, as one bad entry is not the list's. */
  diffs: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** Read apart from the calls, as a bad one is not the list's. */
  omittedCalls: Schema.optional(Schema.Unknown),
});

/** The calls a result's details left out of their list, which they cap: how many, and how many of those failed. */
export const OmittedCalls = Schema.Struct({
  count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type OmittedCalls = typeof OmittedCalls.Type;

const decodeDetails = Schema.decodeUnknownOption(Details);

const decodeOmitted = Schema.decodeUnknownOption(OmittedCalls);

const decodeArgs = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** The calls a code mode result lists in its details, or none for details of another shape. */
export const settledCalls = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
): NestedCall[] =>
  Option.match(decodeDetails(details), {
    onNone: () => [],
    onSome: ({ calls, diffs }) =>
      calls.map((listed) => {
        const call: Types.Mutable<NestedCall> = {
          id: String(listed.id),
          name: listed.name,
          args: Option.getOrElse(decodeArgs(listed.args), () => ({})),
          status: listed.status,
        };

        if (listed.durationMs !== undefined) call.durationMs = listed.durationMs;

        if (listed.error !== undefined) call.error = listed.error;

        const diff = Option.getOrUndefined(
          Option.flatMap(decodeRecordedDiff(diffs?.[String(listed.id)]), toCallDiff),
        );

        if (diff !== undefined) call.diff = diff;

        return call;
      }),
  });

/** The calls a code mode result's details left out of their list, or none when they left none out or say it badly. */
export const omittedCalls = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
): OmittedCalls | undefined =>
  Option.getOrUndefined(
    Option.flatMap(decodeDetails(details), ({ omittedCalls: omitted }) => decodeOmitted(omitted)),
  );
