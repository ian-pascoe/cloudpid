// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over records.
// What `/export` says of the questions a call asked (`docs/architecture/mcp-server-requests.md` → Elicitation requests,
// Records; Sampling requests, Records; #388 D10, #387 X8): one line for each settled elicitation record and each Sampling
// record, put under the result of the call that asked. Never a value: a record keeps none, and these lines are made from
// the names of the fields answered, the page's host, the Role, the tokens and the cost.
import type { McpQuestionRecord } from "./question-records.ts";
import { callKeysOf } from "./question-records.ts";
import type { McpSamplingRecord } from "./sampling-records.ts";

/** The longest a reason of cloudpid's is in a line, in characters. */
const REASON_CHARACTERS = 200;

/** The longest a field's name is in a line, in characters. */
const FIELD_CHARACTERS = 60;

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

/** The host of a page's origin as a record keeps it; the origin itself when it does not parse. */
const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** US dollars as an export reads them: cents, and the first digit a small amount has. */
const dollarsOf = (amount: number): string => {
  if (amount === 0) return "$0.00";

  return amount < 0.01 ? `$${amount.toPrecision(1)}` : `$${amount.toFixed(2)}`;
};

/**
 * The line for a settled elicitation record: "Elicitation: docs · form · submitted (name, email)", "· page on
 * example.com · opened", "· declined" or "· cancelled", and when cloudpid ended it, "by cloudpid" and why.
 */
export const elicitationLine = (record: McpQuestionRecord): string => {
  const kind = record.mode === "url" ? `page on ${hostOf(record.page?.origin ?? "")}` : "form";

  const fields = record.fields.map((name) => cut(name, FIELD_CHARACTERS)).join(", ");

  const outcome = (() => {
    if (record.action === "accept") {
      if (record.mode === "url") return "opened";

      return fields === "" ? "submitted" : `submitted (${fields})`;
    }

    const word = record.action === "decline" ? "declined" : "cancelled";

    if (record.by !== "cloudpid") return word;

    return record.reason === undefined
      ? `${word} by cloudpid`
      : `${word} by cloudpid: ${cut(record.reason, REASON_CHARACTERS)}`;
  })();

  return `Elicitation: ${record.server} · ${kind} · ${outcome}`;
};

/**
 * The line for a Sampling record that settled: "Sampling: docs · Smart · 1,204 tokens · $0.02" for one that was answered,
 * and "Sampling: docs · refused" (or "failed") otherwise. A request still waiting or running has none.
 */
export const samplingLine = (record: McpSamplingRecord): string | undefined => {
  if (record.status === "waiting" || record.status === "running") return undefined;

  if (record.status === "answered") {
    const parts = [record.server];

    if (record.role !== undefined) parts.push(record.role);

    if (record.tokens !== undefined) parts.push(`${record.tokens.toLocaleString("en-US")} tokens`);

    if (record.cost !== undefined) parts.push(dollarsOf(record.cost));

    return `Sampling: ${parts.join(" · ")}`;
  }

  const by = record.by === "cloudpid" ? " by cloudpid" : "";

  const why =
    record.by === "cloudpid" && record.reason !== undefined
      ? `: ${cut(record.reason, REASON_CHARACTERS)}`
      : "";

  return `Sampling: ${record.server} · ${record.status}${by}${why}`;
};

/**
 * The lines of the questions the calls asked, by the call whose result an export or Fork finds them under: a nested
 * call's under every call it is nested in (`callKeysOf`), oldest first.
 */
export const exportLinesOf = (
  questions: ReadonlyArray<McpQuestionRecord>,
  sampling: ReadonlyArray<McpSamplingRecord>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const lines: Array<{ readonly callId: string; readonly at: number; readonly line: string }> = [];

  for (const record of questions) {
    lines.push({ callId: record.callId, at: record.askedAt, line: elicitationLine(record) });
  }

  for (const record of sampling) {
    const line = samplingLine(record);

    if (line !== undefined) lines.push({ callId: record.callId, at: record.askedAt, line });
  }

  const byCall = new Map<string, string[]>();

  for (const { callId, line } of [...lines].sort((left, right) => left.at - right.at)) {
    for (const key of callKeysOf(callId)) {
      const held = byCall.get(key);

      if (held === undefined) byCall.set(key, [line]);
      else held.push(line);
    }
  }

  return byCall;
};
