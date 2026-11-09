// The transcript as the MCP endpoint's `session_transcript` reads it (`docs/architecture/mcp-endpoint.md` → Transcripts):
// one rendered block per entry, redacted, and cut into pages by rendered size. Pure, so a Session object renders at
// read time and megabytes of tool results never cross the RPC.
// @effect-diagnostics globalDate:off missingPipeableSignature:off preferEffectArray:off -- plain functions over short strings and arrays.
import type { JsonValue } from "@earendil-works/pi-ai";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import {
  DEFAULT_TRANSCRIPT_CHARS,
  inputViaChipLabel,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_ENTRIES,
  MIN_TRANSCRIPT_CHARS,
  type TranscriptDetail,
  type TranscriptEntry,
} from "./mcp-api.ts";
import type { TranscriptMessage, TranscriptPart } from "./transcript.ts";
import { shownVisualOf, visualPaneQuery, visualTranscriptLine } from "./visuals.ts";

/** The most characters one entry's text holds, by `detail`. */
export const ENTRY_TEXT_CHARS: Readonly<Record<TranscriptDetail, number>> = {
  summary: 2_000,
  full: 8_000,
};

/** The most characters of a tool call's arguments on its line. */
export const TOOL_ARGUMENT_CHARS = 160;

/** The most characters of a failed tool result's first line in `summary`. */
export const TOOL_ERROR_LINE_CHARS = 200;

/** The most characters of a tool result in `full`. */
export const TOOL_RESULT_CHARS = 1_500;

/**
 * `text` cut to at most `max` characters by dropping the middle, which says how much it dropped: both ends of a long
 * output are the ones that matter (a command's first lines and its failure).
 */
export const middleCut = (text: string, max: number): string => {
  if (text.length <= max) return text;

  const marker = (cut: number) => `\n… [${String(cut)} characters cut] …\n`;

  // The marker's own length depends on how much is cut, which depends on its length: settle it in a few rounds.
  let cut = text.length - max;

  for (let round = 0; round < 3; round++) cut = text.length - max + marker(cut).length;

  const room = max - marker(cut).length;

  // Too small a limit for a marker: the start of the text is all there is room for.
  if (room < 2) return text.slice(0, max);

  const head = Math.ceil(room / 2);
  const tail = room - head;

  return `${text.slice(0, head)}${marker(text.length - head - tail)}${tail === 0 ? "" : text.slice(-tail)}`;
};

/**
 * GitHub token shapes (`ghs_`, `ghp_`, `gho_`, `ghu_`, `ghr_`, `github_pat_`), which no Secret list need name. A
 * stateless installation token (`ghs_<app id>_<JWT>`, about 520 characters, every new one from 2026-10-02) holds dots,
 * dashes and underscores and varies in length, so `ghs_` takes GitHub's pattern for both formats, with no upper bound.
 */
const GITHUB_TOKEN =
  /\b(?:ghs_[A-Za-z0-9._-]{20,}|gh[pour]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g;

/** `text` with GitHub tokens replaced by `[REDACTED github token]` (`docs/architecture/mcp-endpoint.md` → Redaction). */
export const redactGithubTokens = (text: string): string =>
  text.replace(GITHUB_TOKEN, "[REDACTED github token]");

const text = (parts: readonly TranscriptPart[]): string =>
  parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();

const imageLabel = (part: { readonly mimeType: string; readonly data: string }): string => {
  const kind = part.mimeType.split("/")[1] ?? part.mimeType;
  const kilobytes = Math.max(1, Math.round((part.data.length * 3) / 4 / 1024));

  return `[image ${kind} ${String(kilobytes)} KB]`;
};

const images = (parts: readonly TranscriptPart[]): string[] =>
  parts.flatMap((part) => (part.type === "image" ? [imageLabel(part)] : []));

/** A tool call's arguments on one line: a lone string value as it is, anything else as JSON. */
const callArguments = (value: JsonValue): string => {
  if (Predicate.isString(value)) return value;

  if (Predicate.isObject(value) && !Array.isArray(value)) {
    const values = Record.values(value);

    if (values.length === 1 && Predicate.isString(values[0])) return values[0];
  }

  return JSON.stringify(value) ?? "";
};

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/** Text redacted before it is cut, so a Secret that would straddle a cut is never left as a prefix. */
type Redact = (text: string) => string;

const toolCall = (part: Extract<TranscriptPart, { type: "tool-call" }>, redact: Redact): string => {
  // Redacted as written, before its lines are joined: a multi-line Secret (a PEM key in a heredoc) is one match.
  const shown = middleCut(oneLine(redact(callArguments(part.arguments))), TOOL_ARGUMENT_CHARS);

  return shown === "" ? `→ ${part.name}` : `→ ${part.name}  ${shown}`;
};

/** ` · <link>` to a Visual's Pane on the Session's page (`/sessions/<id>?pane=visual:<callId>`), once both are known. */
const paneLink = (callId: string | undefined, sessionId: string | undefined): string =>
  callId === undefined || sessionId === undefined
    ? ""
    : ` · /sessions/${encodeURIComponent(sessionId)}${visualPaneQuery(callId)}`;

const toolResult = (
  part: Extract<TranscriptPart, { type: "tool-result" }>,
  detail: TranscriptDetail,
  redact: Redact,
  sessionId: string | undefined,
): string => {
  const body = redact(text(part.content));
  const pictures = images(part.content);

  // A Visual the call showed, which the transcript never renders (`docs/architecture/visuals.md` → Lifecycle).
  const shown = part.error ? undefined : shownVisualOf(part.details);

  const visual =
    shown === undefined
      ? []
      : [
          oneLine(
            redact(
              visualTranscriptLine(shown.title, shown.summary) + paneLink(shown.id, sessionId),
            ),
          ),
        ];

  if (detail === "full") {
    const lines = [middleCut(body, TOOL_RESULT_CHARS), ...pictures, ...visual].filter(
      (each) => each !== "",
    );

    return `${part.error ? "✗" : "✓"} ${lines.join("\n")}`.trimEnd();
  }

  if (part.error) {
    const first = body.split("\n").find((line) => line.trim() !== "") ?? "";

    return `✗ ${middleCut(first.trim(), TOOL_ERROR_LINE_CHARS)}`.trimEnd();
  }

  const lines = body === "" ? 0 : body.split("\n").length;

  return [
    [`✓ ${String(lines)} ${lines === 1 ? "line" : "lines"}`, ...pictures].join(" "),
    ...visual,
  ].join("\n");
};

/** `HH:MM` (UTC) of an epoch-millisecond time, or none for an entry with no time. */
const clock = (timestamp: number): string =>
  timestamp > 0 ? new Date(timestamp).toISOString().slice(11, 16) : "";

const isoTime = (timestamp: number): string =>
  timestamp > 0 ? new Date(timestamp).toISOString() : "";

const header = (message: TranscriptMessage): string => {
  const marks = [
    message.role === "tool"
      ? (message.parts.find((part) => part.type === "tool-result")?.name ?? "tool")
      : undefined,
    clock(message.timestamp) || undefined,
    message.via === undefined ? undefined : inputViaChipLabel(message.via),
  ].filter(Predicate.isNotUndefined);

  return `### ${[message.role, ...marks].join(" · ")}`;
};

/** One message's rendered block, header first; undefined when it shows nothing (thinking is always left out). */
const block = (
  message: TranscriptMessage,
  detail: TranscriptDetail,
  redact: Redact,
  sessionId: string | undefined,
): string | undefined => {
  if (message.role === "notice") {
    const body = oneLine(redact(text(message.parts)));
    const title = redact(message.title ?? "Notice");

    return `· ${body === "" ? title : `${title}: ${middleCut(body, TOOL_ERROR_LINE_CHARS)}`}`;
  }

  const lines: string[] = [];
  const body = redact(text(message.parts));

  if (message.role === "tool") {
    for (const part of message.parts) {
      if (part.type === "tool-result") lines.push(toolResult(part, detail, redact, sessionId));
    }
  } else {
    if (body !== "") lines.push(middleCut(body, ENTRY_TEXT_CHARS[detail]));

    lines.push(...images(message.parts));

    for (const part of message.parts) {
      if (part.type === "tool-call") lines.push(toolCall(part, redact));
    }

    if (message.error !== undefined)
      lines.push(`✗ ${oneLine(middleCut(redact(message.error), TOOL_ERROR_LINE_CHARS))}`);
  }

  return lines.length === 0 ? undefined : `${header(message)}\n${lines.join("\n")}`;
};

/**
 * The entries of a transcript as the endpoint shows them, oldest to newest, `redact`ed. A message with nothing to show
 * has no block. `redact` runs on each text before it is cut to its limit, and again on the block, so no cut leaves a
 * Secret as a prefix.
 */
export const renderTranscript = (
  messages: readonly TranscriptMessage[],
  options: {
    readonly detail?: TranscriptDetail;
    readonly redact?: (text: string) => string;
    /** The Session's ID: a Visual's line links to its Pane on the Session's page. */
    readonly sessionId?: string | undefined;
  } = {},
): TranscriptEntry[] => {
  const detail = options.detail ?? "summary";
  const redact = options.redact ?? redactGithubTokens;

  return messages.flatMap((message): TranscriptEntry[] => {
    const rendered = block(message, detail, redact, options.sessionId);
    const entryId = Number(message.id);

    if (rendered === undefined || !Number.isInteger(entryId)) return [];

    return [
      {
        entry_id: entryId,
        role: message.role,
        at: isoTime(message.timestamp),
        text: redact(rendered),
      },
    ];
  });
};

/** `max_chars` as the tool takes it: its default, kept within its bounds. */
export const transcriptChars = (requested: number | undefined): number =>
  Math.min(
    Math.max(requested ?? DEFAULT_TRANSCRIPT_CHARS, MIN_TRANSCRIPT_CHARS),
    MAX_TRANSCRIPT_CHARS,
  );

/** A page of rendered entries, and whether the transcript goes on past either end of it. */
export type TranscriptWindow = {
  readonly entries: readonly TranscriptEntry[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
};

/**
 * The page of `entries` (oldest first) a read asks for: with `after`, the entries after it, oldest first; with
 * `before`, those before it, nearest first; with neither, the latest. A page holds whole entries up to `maxChars` of
 * text and at most `MAX_TRANSCRIPT_ENTRIES`, and always at least one, trimmed to fit when it alone is over.
 */
export const pageTranscript = (
  entries: readonly TranscriptEntry[],
  request: {
    readonly before?: number | undefined;
    readonly after?: number | undefined;
    readonly maxChars?: number | undefined;
  },
): TranscriptWindow => {
  const maxChars = transcriptChars(request.maxChars);
  const { before, after } = request;

  const pool =
    after !== undefined
      ? entries.filter((entry) => entry.entry_id > after)
      : before !== undefined
        ? entries.filter((entry) => entry.entry_id < before)
        : entries;

  // Newest first for a page that ends at the end of the pool; oldest first for one that starts at its start.
  const forward = after !== undefined;
  const ordered = forward ? pool : pool.toReversed();
  const taken: TranscriptEntry[] = [];
  let chars = 0;

  for (const entry of ordered) {
    if (taken.length >= MAX_TRANSCRIPT_ENTRIES) break;

    if (taken.length > 0 && chars + entry.text.length > maxChars) break;

    taken.push(
      taken.length === 0 && entry.text.length > maxChars
        ? { ...entry, text: middleCut(entry.text, maxChars) }
        : entry,
    );
    chars += taken.at(-1)?.text.length ?? 0;
  }

  const page = forward ? taken : taken.toReversed();
  const first = page[0]?.entry_id;
  const last = page.at(-1)?.entry_id;

  return {
    entries: page,
    hasOlder:
      first === undefined
        ? pool.length > 0 && !forward
        : entries.some((entry) => entry.entry_id < first),
    hasNewer: last === undefined ? false : entries.some((entry) => entry.entry_id > last),
  };
};
