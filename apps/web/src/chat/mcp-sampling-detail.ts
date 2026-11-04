// What an MCP tool call's card says of the Sampling requests its server made (`docs/architecture/mcp-server-requests.md` →
// Sampling requests, Records): one line for each, from the call's `details.sampling` (never what was asked or answered; the
// card expands one into its record with `mcp_sampling_get`). `status` and `by` are strings this build may not know, which
// read as they are.
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { TranscriptPart } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { dollars, tokenCount } from "../format.ts";

/** One request as the call recorded it. */
export const ShownSampling = Schema.Struct({
  server: Schema.String,
  status: Schema.String,
  by: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  why: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  tokens: Schema.optionalKey(Schema.Finite),
  cost: Schema.optionalKey(Schema.Finite),
  id: Schema.optionalKey(Schema.String),
});

export type ShownSampling = typeof ShownSampling.Type;

const decodeDetails = Schema.decodeUnknownOption(
  Schema.Struct({ sampling: Schema.Array(ShownSampling) }),
);

/** The Sampling requests a result's details record; none for a call whose server made none. */
export const sampledRequests = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
): ReadonlyArray<ShownSampling> =>
  Option.match(decodeDetails(details), { onNone: () => [], onSome: (found) => found.sampling });

const decodeArtifact = Schema.decodeUnknownOption(
  Schema.Struct({ samplings: Schema.Array(ShownSampling) }),
);

/** The Sampling requests a card's artifact holds, if it holds any. */
export const samplingsOf = (
  artifact: ToolCallMessagePartProps["artifact"],
): ReadonlyArray<ShownSampling> =>
  Option.match(decodeArtifact(artifact), {
    onNone: () => [],
    onSome: (found) => found.samplings,
  });

/** What an answered request ran on and cost: the Role and model, the tokens and the dollars, as far as they are known. */
const usedOf = (request: ShownSampling): string => {
  const parts = Arr.empty<string>();

  const ran = Arr.getSomes([
    Option.fromUndefinedOr(request.role),
    Option.fromUndefinedOr(request.model),
  ]);

  if (ran.length > 0) parts.push(Arr.join(ran, " · "));

  if (request.tokens !== undefined) parts.push(`${tokenCount(request.tokens)} tokens`);

  if (request.cost !== undefined) parts.push(dollars(request.cost));

  return parts.length === 0 ? "" : ` (${Arr.join(parts, ", ")})`;
};

/** What the card says of one request: who decided, what came of it and, for cloudpid's own refusal, why. */
export const samplingLine = (request: ShownSampling): string => {
  const asked = `${request.server}'s request to use a model`;
  const because = request.reason === undefined ? "" : `: ${request.reason}`;

  if (request.status === "answered") {
    switch (request.by) {
      case "owner":
        return `You let ${request.server} use a model${usedOf(request)}`;
      case "grant":
        return `${request.server} used a model, as you allowed for this Session${usedOf(request)}`;
      default:
        return `${request.server} used a model, as its definition allows${usedOf(request)}`;
    }
  }

  if (request.status === "refused") {
    switch (request.by) {
      case "owner":
        return `You refused ${asked}`;
      case "grant":
        return `You refused ${asked} for this Session`;
      default:
        return `cloudpid refused ${asked}${because}`;
    }
  }

  return `${asked} failed${because}`;
};
