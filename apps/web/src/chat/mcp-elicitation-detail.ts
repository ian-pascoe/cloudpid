// What an MCP tool call's card says of the questions its server asked (`docs/architecture/mcp-server-requests.md` →
// Elicitation requests, Records): one line for each, from the call's `details.elicitation` (never a value, only the names
// of the fields answered). A form cloudpid declined or cancelled before the owner saw it says why, in cloudpid's words.
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { TranscriptPart } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** One question as the call recorded it. `action` and `by` are strings this build may not know, which read as they are. */
export const ShownElicitation = Schema.Struct({
  server: Schema.String,
  action: Schema.String,
  by: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  host: Schema.optionalKey(Schema.String),
  fields: Schema.Array(Schema.String),
});

export type ShownElicitation = typeof ShownElicitation.Type;

const decodeDetails = Schema.decodeUnknownOption(
  Schema.Struct({ elicitation: Schema.Array(ShownElicitation) }),
);

/** The questions a result's details record; none for a call whose server asked none. */
export const askedQuestions = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
): ReadonlyArray<ShownElicitation> =>
  Option.match(decodeDetails(details), { onNone: () => [], onSome: (found) => found.elicitation });

const decodeArtifact = Schema.decodeUnknownOption(
  Schema.Struct({ elicitations: Schema.Array(ShownElicitation) }),
);

/** The questions a card's artifact holds, if it holds any. */
export const questionsOf = (
  artifact: ToolCallMessagePartProps["artifact"],
): ReadonlyArray<ShownElicitation> =>
  Option.match(decodeArtifact(artifact), {
    onNone: () => [],
    onSome: (found) => found.elicitations,
  });

const verb = (action: string): string =>
  Match.value(action).pipe(
    Match.when("accept", () => "answered"),
    Match.when("decline", () => "declined"),
    Match.orElse(() => "cancelled"),
  );

/**
 * What the card says of a page the server asked the owner to open: the host, never the address. An accepted page was
 * opened (a cloudpid's own `accept` is the page being finished, which only the owner makes).
 */
const pageLine = (question: ShownElicitation): string => {
  const where = question.host === undefined ? "a page" : `a page on ${question.host}`;

  if (question.by === "owner") {
    return question.action === "accept"
      ? `You opened ${where} for ${question.server}`
      : `You ${verb(question.action)} ${question.server}'s request to open ${where}`;
  }

  return `cloudpid ${verb(question.action)} ${question.server}'s request to open ${where}${question.reason === undefined ? "" : `: ${question.reason}`}`;
};

/** What the card says of one question: who ended it, how, and for a cloudpid's own answer, why. */
export const elicitationLine = (question: ShownElicitation): string => {
  if (question.mode === "url") return pageLine(question);

  if (question.by === "owner") {
    return question.action === "accept"
      ? `You answered ${question.server}'s form${question.fields.length === 0 ? "" : ` (${Arr.join(question.fields, ", ")})`}`
      : `You ${verb(question.action)} ${question.server}'s form`;
  }

  return `cloudpid ${verb(question.action)} ${question.server}'s form${question.reason === undefined ? "" : `: ${question.reason}`}`;
};
