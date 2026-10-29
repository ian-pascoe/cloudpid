// The rest of one tool result (`docs/architecture/workspace.md` → The rest of one tool result, #97). A tool result is
// one row of the Session DO's SQLite, which workerd caps at 8 MiB (`MAX_ROW_BYTES`): a write over it fails the commit
// and the Session. pi-durable bounds a result's text, `ResultImages` its images, and `CodemodeDiffs` a script's Call
// diffs; this holds the other parts a tool controls to caps of their own, each counted as stored (`storedBytes`), and
// says what it cut:
//
// - the diagnostics a tool reports, which pi-durable stores twice (appended to the content, and in the entry's data);
// - a nested call's `structuredOutput`, stored in its caller's `NestedCallDoc` (a model-issued call's is never stored);
// - `details`, as a backstop: `codemode`'s call list is cut by the pi-durable patch, and its Call diffs by their budget.
//
// The hook runs last, after the Secrets extension's redaction, so a Secret is never cut in two before it is redacted.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import {
  defineExtension,
  hook,
  type ToolDiagnostic,
  type ToolExecutionResult,
  ToolTask,
} from "@earendil-works/pi-durable";
import { MAX_CODEMODE_DIFF_BYTES } from "./call-diff.ts";
import { cutStored, storedBytes } from "./stored-bytes.ts";

/**
 * A stored row's limit: 8 MiB, workerd's `SqliteDatabase::MAX_ROW_LENGTH` (8 MiB and 34 bytes) since
 * [workerd#7493](https://github.com/cloudflare/workerd/pull/7493) (2 MB until
 * [workerd#7020](https://github.com/cloudflare/workerd/pull/7020)). Cloudflare's docs still say 2 MB
 * ([cloudflare-docs#34502](https://github.com/cloudflare/cloudflare-docs/issues/34502)); a deployed Durable Object and
 * local workerd both accept 8 MiB and refuse more with `SQLITE_TOOBIG`.
 */
export const MAX_ROW_BYTES = 8 * 1024 * 1024;

/**
 * The most characters of text a `codemode` result holds: pi-durable's `OUTPUT_LIMITS` (4 MiB, of which it keeps a
 * quarter as characters), however much `max_output_tokens` asks for.
 */
export const MAX_CODEMODE_TEXT_CHARACTERS = 1_048_576;

/** The most the diagnostics a tool reports may weigh stored, together; pi-durable stores them twice. */
export const MAX_RESULT_DIAGNOSTICS_BYTES = 16 * 1024;

/**
 * The most a nested call's `structuredOutput` may weigh stored. Above `web_fetch`'s 1 MiB of text (`STRUCTURED_MAX_BYTES`,
 * counted unescaped), so a page at that bound is still stored, and with its details and diagnostics well within the row.
 */
export const MAX_NESTED_STRUCTURED_OUTPUT_BYTES = 1536 * 1024;

/** The most a result's `details` may weigh stored, but a `codemode` result's. */
export const MAX_RESULT_DETAILS_BYTES = 64 * 1024;

/**
 * The most the call list of a `codemode` result's details weighs stored: the pi-durable patch's
 * `MAX_DETAILS_CALLS_BYTES` (`patches/@earendil-works__pi-durable@1.4.0.patch`), which keeps them to it.
 */
export const MAX_CODEMODE_CALLS_BYTES = 64 * 1024;

/**
 * The most a `codemode` result's `details` may weigh stored: its call list and its Call diffs (`MAX_CODEMODE_DIFF_BYTES`),
 * with 4 KiB for the rest (the keys, `omittedCalls`, `fullOutputPath`).
 */
export const MAX_CODEMODE_DETAILS_BYTES =
  MAX_CODEMODE_CALLS_BYTES + MAX_CODEMODE_DIFF_BYTES + 4 * 1024;

/** The most one diagnostic's message is kept to, stored, so one long message does not crowd out the rest. */
const MAX_DIAGNOSTIC_MESSAGE_BYTES = 4 * 1024;

/** What ends a cut message. */
const CUT_MARKER = "… [cut]";

/** Bytes kept back for the note that ends cut diagnostics, and its separator. */
const NOTE_BYTES = 256;

/** The least room a message is cut to: with less, it and the diagnostics after it are left out. */
const MIN_MESSAGE_BYTES = 2 + CUT_MARKER.length * 3 + 64;

/** The call whose result is bounded. */
export type BoundedCall = {
  /** The tool's name. */
  readonly tool: string;
  /** Whether a program (a `codemode` script) made the call, whose result is stored as a nested call's. */
  readonly nested: boolean;
};

const formatKib = (size: number) => `${size / 1024} KiB`;

const formatBytes = (size: number) => `${size.toLocaleString("en-US")} bytes`;

/**
 * The diagnostics a tool reported followed by those `added` here, within `MAX_RESULT_DIAGNOSTICS_BYTES` together: the
 * reported ones are cut to the room the added ones leave, ending with a note when any was shortened or left out.
 * `reported` itself when nothing is added or cut.
 */
const boundDiagnostics = (
  reported: readonly ToolDiagnostic[],
  added: readonly ToolDiagnostic[],
): readonly ToolDiagnostic[] => {
  // The added diagnostics, each with its separator.
  const budget = MAX_RESULT_DIAGNOSTICS_BYTES - storedBytes(added) + 2 - added.length;

  if (storedBytes(reported) <= budget)
    return added.length === 0 ? reported : [...reported, ...added];

  return [...cutDiagnostics(reported, budget), ...added];
};

/** `diagnostics` within `budget` stored bytes, ending with a note saying how many were shortened or left out. */
const cutDiagnostics = (
  diagnostics: readonly ToolDiagnostic[],
  budget: number,
): readonly ToolDiagnostic[] => {
  // The array's brackets and the note are kept back from the start.
  let remaining = budget - 2 - NOTE_BYTES;
  let shortened = 0;
  const kept: ToolDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const separator = kept.length === 0 ? 0 : 1;
    const frame = storedBytes({ ...diagnostic, message: "" }) - 2 + separator;
    const room = Math.min(MAX_DIAGNOSTIC_MESSAGE_BYTES, remaining - frame);

    // Too little room left for a message worth reading: the rest are left out.
    if (room < MIN_MESSAGE_BYTES) break;

    const message = cutStored(diagnostic.message, room, CUT_MARKER);

    if (message !== diagnostic.message) shortened++;

    kept.push(message === diagnostic.message ? diagnostic : { ...diagnostic, message });
    remaining -= frame + storedBytes(message);
  }

  const leftOut = diagnostics.length - kept.length;

  kept.push({
    severity: "warn",
    code: "diagnostics_truncated",
    message: `Diagnostics were cut to fit one tool result (${formatKib(MAX_RESULT_DIAGNOSTICS_BYTES)} at most): ${shortened} shortened and ${leftOut} left out, of ${diagnostics.length}.`,
  });

  return kept;
};

/**
 * `result` with the parts it controls besides its text and images held to their caps, each cut part noted; `result`
 * itself when every part fits.
 */
export const boundToolResult = (
  result: ToolExecutionResult,
  call: BoundedCall,
): ToolExecutionResult => {
  let bounded = result;

  const detailsCap =
    call.tool === "codemode" ? MAX_CODEMODE_DETAILS_BYTES : MAX_RESULT_DETAILS_BYTES;

  const detailsSize = storedBytes(result.details);

  if (detailsSize > detailsCap) {
    bounded = {
      ...bounded,
      details: {
        omitted: `Details of ${formatBytes(detailsSize)} were left out: one ${call.tool} result holds at most ${formatKib(detailsCap)} of them.`,
      },
    };
  }

  // A model-issued call's structured output is never stored: only programs read it.
  const structuredSize = call.nested ? storedBytes(result.structuredOutput) : 0;

  const added: ToolDiagnostic[] = [];

  if (structuredSize > MAX_NESTED_STRUCTURED_OUTPUT_BYTES) {
    const { structuredOutput: _left, ...rest } = bounded;

    // An error result needs no structured output, so the Harness's schema check lets this one through.
    bounded = { ...rest, isError: true };
    added.push({
      severity: "error",
      code: "structured_output_too_large",
      message: `${call.tool} returned structured output of ${formatBytes(structuredSize)}, over the ${formatKib(MAX_NESTED_STRUCTURED_OUTPUT_BYTES)} one nested call's result holds, so it was left out. Ask for less at once.`,
    });
  }

  const reported = result.diagnostics ?? [];
  const diagnostics = boundDiagnostics(reported, added);

  return diagnostics === reported ? bounded : { ...bounded, diagnostics };
};

/** Every tool result held to `boundToolResult`'s caps before it is stored: a call's own, and a nested one's. */
export const ResultBounds = defineExtension({
  name: "result-bounds",
  hooks: [
    hook(ToolTask, {
      afterTool: (call, result) => {
        const bounded = boundToolResult(result, {
          tool: call.name,
          nested: call.parent !== undefined,
        });

        return bounded === result ? undefined : bounded;
      },
    }),
  ],
});
