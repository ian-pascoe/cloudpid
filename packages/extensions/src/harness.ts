// What a harness tool's core gives and how the endpoint's answers are bounded (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Shared definitions and the core/wrapper split, Reading a whole field, and the
// endpoint's limits). A core is an Effect over plain services that makes the checks and the reads and returns the
// answer's text, its structured value and its `details`, never touching `ToolExecutionApi`; the in-session wrapper adds
// replay and the rest, and the endpoint's `api` target runs the same core with `surface: "endpoint"`. On the endpoint
// an answer is cut to what a client can read: the text to `ENDPOINT_TEXT_CHARS`, the structured value to
// `ENDPOINT_STRUCTURED_BYTES`, and a long text is read whole, a page at a time (`pageOf`).
// @effect-diagnostics missingPipeableSignature:off
import {
  ENDPOINT_STRUCTURED_BYTES,
  ENDPOINT_TEXT_CHARS,
  type HarnessErrorCode,
  MAX_PAGE_BYTES,
  MAX_PAGE_CHARS,
  type Surface,
} from "@cloudpid/protocol/harness-tools";
import type { JsonValue } from "@earendil-works/chord";
import type * as Effect from "effect/Effect";
import { cutStored, type Stored, storedBytes } from "./stored-bytes.ts";

/** A core's answer: the text the model reads, the structured value a program gets, and the details of the card. */
export type HarnessAnswer = {
  readonly text: string;
  readonly structured: JsonValue;
  readonly details: JsonValue;
};

/**
 * A harness tool's core: its arguments and the surface it is served from, to its answer. A refusal is the service's
 * error, which may carry a `HarnessErrorCode`.
 */
export type HarnessRead<A, E> = (args: A, surface: Surface) => Effect.Effect<HarnessAnswer, E>;

/** The error codes a core's refusals carry: what the dispatcher maps to the endpoint's `not_found` and `invalid_argument`. */
export const NOT_FOUND = "not_found" satisfies HarnessErrorCode;

export const INVALID_ARGUMENT = "invalid_argument" satisfies HarnessErrorCode;

/** An answer as an in-session tool returns it: its text, its structured output and its details. */
export const toolResult = ({ text, structured, details }: HarnessAnswer) => ({
  output: [{ type: "text" as const, text }],
  structuredOutput: structured,
  details,
});

/** What an endpoint answer's cut text ends with: where it was cut, and what to do about it (`rest`). */
export const cutNote = (rest: string): string =>
  `[Cut at ${ENDPOINT_TEXT_CHARS.toLocaleString("en-US")} characters: ${rest}]`;

/**
 * `text` cut to at most `maxChars` characters, ending with `note` on a line of its own, at a character boundary (a
 * surrogate pair is never split); `text` itself when it fits.
 */
export const cutText = (
  text: string,
  note: string,
  maxChars: number = ENDPOINT_TEXT_CHARS,
): string => {
  if (text.length <= maxChars) return text;

  const room = maxChars - note.length - 1;
  const code = text.charCodeAt(room - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? room - 1 : room;

  return `${text.slice(0, end)}\n${note}`;
};

/**
 * `value` with `steps` applied one at a time until it weighs at most `ENDPOINT_STRUCTURED_BYTES` stored: each step
 * leaves something out and sets its `_truncated` flag, so a value that cannot be fitted by its parts' bounds still is.
 */
export const fitted = <A extends Stored>(
  value: A,
  steps: ReadonlyArray<(value: A) => A>,
  maxBytes: number = ENDPOINT_STRUCTURED_BYTES,
): A => {
  let fits = value;

  for (const step of steps) {
    if (storedBytes(fits) <= maxBytes) break;

    fits = step(fits);
  }

  return fits;
};

/** One page of a field's text. */
export type Page = {
  readonly text: string;
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset: number | undefined;
};

/**
 * The page of `text` that starts at `offset` (UTF-16 code units, the unit every limit here counts): at most
 * `MAX_PAGE_CHARS` characters and `MAX_PAGE_BYTES` stored, ending before a surrogate pair rather than inside it. An
 * `offset` that falls inside a pair starts at the pair. `undefined` when `offset` is past the end.
 */
export const pageOf = (text: string, offset: number): Page | undefined => {
  const total = text.length;

  if (offset > total) return undefined;

  // An offset between the two halves of a surrogate pair starts at the pair.
  const low = text.charCodeAt(offset);
  const start = offset > 0 && low >= 0xdc00 && low <= 0xdfff ? offset - 1 : offset;

  // The page ends before a pair that its length would split.
  const cap = Math.min(total, start + MAX_PAGE_CHARS);
  const last = text.charCodeAt(cap - 1);
  const stop = cap < total && last >= 0xd800 && last <= 0xdbff ? cap - 1 : cap;

  const page = cutStored(text.slice(start, stop), MAX_PAGE_BYTES, "");
  const end = start + page.length;

  return {
    text: page,
    offset: start,
    totalChars: total,
    nextOffset: end < total ? end : undefined,
  };
};

/** What a page answers, as the optional keys of a tool's flat output: `next_offset` only when more follows. */
export const pageFields = (id: string, field: string, page: Page) =>
  page.nextOffset === undefined
    ? { id, field, text: page.text, offset: page.offset, total_chars: page.totalChars }
    : {
        id,
        field,
        text: page.text,
        offset: page.offset,
        total_chars: page.totalChars,
        next_offset: page.nextOffset,
      };

/**
 * A page's text as the model reads it: the page whole, and where it sits in the field, so a client that reads only the
 * text knows where the next page starts. The text of a page is exempt from the endpoint's cut of the content text.
 */
export const pageText = (page: Page): string =>
  `${page.text}\n[Characters ${page.offset}-${page.offset + page.text.length} of ${page.totalChars}${
    page.nextOffset === undefined
      ? ": the end"
      : `: pass offset ${page.nextOffset} for the next page`
  }.]`;
