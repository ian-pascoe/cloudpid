// The Call diff of `write`, and of the `edit` and `write` calls a `codemode` script makes (`docs/architecture/diffs-and-review.md`).
// A Call diff is what a result's `details` record of a change (`RecordedDiff`, `@cloudpid/protocol/call-diff`): a
// unified patch with four lines of context, as `edit` records, and flags where there is none to record:
//
// - `created`: the file did not exist.
// - `binary`: the old file has a NUL in its first 8,000 bytes, or could not be read.
// - `tooLarge`: the two texts together pass 1 MiB, the patch passes 512 KiB, or lining the texts up took too long.
//
// The result is one SQLite row (8 MiB, workerd#7493), so a patch is bounded before it is stored; the write itself is
// never held back by it. These are plain functions over text (`writeDetails`, `capturedDiffs`) and over a file system
// (`oldFile`).
//
// Lining the texts up has two bounds. jsdiff's `timeout` reads `Date.now()`, which does not advance while synchronous
// code runs in workerd (the Session DO), so it cannot stop a long line-up there: `maxEditLength`, a bound on the lines
// that differ, does not depend on a clock. The line-up costs about the square of it, so the bound is what keeps the
// worst case (every line of a large file differs) near a second at most. The timeout stays as a second guard.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off -- plain functions over text and native arrays.
import type { Context, JsonValue } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { decodeRecordedDiff, type RecordedDiff } from "@cloudpid/protocol/call-diff";
import * as Diff from "diff";
import { byteLength, storedBytes } from "./stored-bytes.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";

/** The most the old and the new text of a call may weigh together (UTF-8 bytes) for a patch to be made. */
export const MAX_DIFF_INPUT_BYTES = 1024 * 1024;

/**
 * The longest patch a result records, as it is stored: JSON-escaped (a quote or backslash takes two bytes, a control
 * character six), in UTF-8 bytes.
 */
export const MAX_PATCH_BYTES = 512 * 1024;

/** How long lining two texts up may take, in ms: jsdiff's `timeout`, which only a runtime whose clock advances honours. */
export const LINE_UP_BUDGET_MS = 1000;

/**
 * The most lines added and removed together that a line-up looks for in a change in the middle of a file: jsdiff's
 * `maxEditLength`, which needs no clock. The work grows with its square: about 0.13 s of Node's time at this bound for a
 * file whose every line differs, against 0.5 s at 2,000. A change at the end of a file (a new file, an append, a
 * truncation) costs only its length, so it is not held to it.
 */
export const MAX_EDIT_LENGTH = 1000;

/** The bytes at the start of a file searched for a NUL, which marks it binary (git's rule). */
export const BINARY_SCAN_BYTES = 8000;

/**
 * The diffs the nested calls of one `codemode` result record, together, each counted whole as stored (its key, path and
 * patch; see `MAX_PATCH_BYTES`). The result is one row, with room for the text of the script's output, its images
 * (`images/results.ts`) and its call list (`result-bounds.ts`), so a script that changes many files cannot fill it: a
 * call whose patch is past this is `tooLarge`, and once not even that fits, the calls after have none.
 */
export const MAX_CODEMODE_DIFF_BYTES = 256 * 1024;

/** What a `write` finds at its path. */
export type OldFile =
  | { readonly kind: "missing" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "tooLarge" };

/**
 * The Call diff of writing `content` over `old`, at `path`. The patch is `edit`'s: both headers name `path`, four lines
 * of context. A write that leaves the file as it was has a patch of its headers alone.
 */
export const writeDetails = (path: string, old: OldFile, content: string): RecordedDiff => {
  if (old.kind === "binary" || old.kind === "unreadable") return { path, binary: true };

  if (old.kind === "tooLarge") return { path, tooLarge: true };

  const created = old.kind === "missing" ? ({ created: true } as const) : {};
  const before = old.kind === "text" ? old.text : "";

  if (byteLength(before) + byteLength(content) > MAX_DIFF_INPUT_BYTES) {
    return { path, ...created, tooLarge: true };
  }

  // The patch of a new file holds all of its text, and more: if that alone passes the cap, there is no use building it.
  if (old.kind === "missing" && storedBytes(content) > MAX_PATCH_BYTES) {
    return { path, ...created, tooLarge: true };
  }

  // A new file, an append and a truncation have one run of lines that differ at the end, which the line-up passes in
  // linear time however long it is (30,000 lines in about 40 ms); it is a change in the middle of a file that costs the
  // square of its length. So the first are not held to the bound on lines that differ.
  const atEnd = content.startsWith(before) || before.startsWith(content);

  // `undefined` when a bound was passed.
  const options = {
    context: 4,
    headerOptions: Diff.FILE_HEADERS_ONLY,
    timeout: LINE_UP_BUDGET_MS,
  };

  const patch = Diff.createTwoFilesPatch(
    path,
    path,
    before,
    content,
    undefined,
    undefined,
    atEnd ? options : { ...options, maxEditLength: MAX_EDIT_LENGTH },
  );

  if (patch === undefined || storedBytes(patch) > MAX_PATCH_BYTES) {
    return { path, ...created, tooLarge: true };
  }

  return { path, ...created, patch };
};

/**
 * What `env` holds at `path` before a write of `bytes` bytes. A file that the two together would pass the cap with is not
 * read, and a symbolic link is judged by what it points to. A path the file system cannot answer for, or a file it cannot
 * read, is `unreadable`; one it does not have is `missing`.
 */
export const oldFile = async (
  env: Pick<ExecutionEnv, "fileInfo" | "readBinaryFile" | "canonicalPath">,
  path: string,
  bytes: number,
  context: Context,
): Promise<OldFile> => {
  let info = await env.fileInfo(path, context);

  if (info.ok && info.value.kind === "symlink") {
    // The size is the link's own; the file read is its target's.
    const target = await env.canonicalPath(path, context);

    if (!target.ok) {
      return target.error.code === "not_found" ? { kind: "missing" } : { kind: "unreadable" };
    }

    info = await env.fileInfo(target.value, context);
  }

  if (!info.ok) {
    return info.error.code === "not_found" ? { kind: "missing" } : { kind: "unreadable" };
  }

  if (info.value.kind !== "file") return { kind: "unreadable" };

  if (info.value.size + bytes > MAX_DIFF_INPUT_BYTES) return { kind: "tooLarge" };

  const read = await env.readBinaryFile(path, context);

  if (!read.ok) return { kind: "unreadable" };

  // The file may have grown since it was measured.
  if (read.value.byteLength + bytes > MAX_DIFF_INPUT_BYTES) return { kind: "tooLarge" };

  if (read.value.subarray(0, BINARY_SCAN_BYTES).includes(0)) return { kind: "binary" };

  return { kind: "text", text: new TextDecoder().decode(read.value) };
};

/** The path a patch names in its `+++` header; undefined for a patch that has none. */
const patchPath = (patch: string): string | undefined => {
  const header = patch.split("\n").find((line) => line.startsWith("+++ "));

  return header === undefined ? undefined : header.slice(4);
};

/**
 * The Call diff in a nested call's `details`, with the path it was made at: a `write` records it, an `edit`'s patch names
 * it. None for details that carry no diff.
 */
export const recordedDiffOf = (details: JsonValue | undefined): RecordedDiff | undefined =>
  Option.getOrUndefined(
    Option.flatMap(decodeRecordedDiff(details), (recorded) => {
      if (recorded.patch === undefined && recorded.tooLarge !== true && recorded.binary !== true) {
        return Option.none();
      }

      const path =
        recorded.path ?? (recorded.patch === undefined ? undefined : patchPath(recorded.patch));

      const found: Types.Mutable<RecordedDiff> = {};

      if (path !== undefined) found.path = path;

      if (recorded.patch !== undefined) found.patch = recorded.patch;

      if (recorded.created === true) found.created = true;

      if (recorded.tooLarge === true) found.tooLarge = true;

      if (recorded.binary === true) found.binary = true;

      return Option.some(found);
    }),
  );

/** The calls a `codemode` result lists, as far as capturing their diffs needs them. */
const Listed = Schema.Struct({
  calls: Schema.Array(
    Schema.Struct({ id: Schema.Finite, name: Schema.String, status: Schema.String }),
  ),
});

const decodeListed = Schema.decodeUnknownOption(Listed);

/** The tools whose calls have a Call diff. */
const DIFFING_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/**
 * The Call diffs of the `edit` and `write` calls a `codemode` result lists in its `details`, keyed by the call's number
 * in the script (the `id` of its row): the diff of each call that finished, from `detailsOf` its number. A patch past
 * 512 KiB, or past the budget the result's diffs share, is recorded as `tooLarge`; past the budget even so, the call and
 * those after it have none.
 */
export const capturedDiffs = (
  details: JsonValue | undefined,
  detailsOf: (id: number) => Promise<JsonValue | undefined>,
): Promise<Record<string, RecordedDiff>> =>
  Option.match(decodeListed(details), {
    onNone: () => Promise.resolve({}),
    onSome: async ({ calls }) => {
      const diffs: Record<string, RecordedDiff> = {};
      // The braces of the record; each entry adds its key, its diff, and a separator.
      let spent = 2;

      for (const call of calls) {
        if (!DIFFING_TOOLS.has(call.name) || call.status !== "ok") continue;

        const found = recordedDiffOf(await detailsOf(call.id));

        if (found === undefined) continue;

        const key = String(call.id);
        // Its key, quoted, a colon, the diff, and a comma.
        const entryBytes = (diff: RecordedDiff) => storedBytes(key) + 2 + storedBytes(diff);
        const fits = (diff: RecordedDiff) => spent + entryBytes(diff) <= MAX_CODEMODE_DIFF_BYTES;
        const { patch, ...rest } = found;

        // A patch too long on its own, or past the budget, is dropped and the call marked `tooLarge`; a call whose
        // record does not fit even so has none, as the calls after it.
        const diff =
          patch === undefined || (storedBytes(patch) <= MAX_PATCH_BYTES && fits(found))
            ? found
            : { ...rest, tooLarge: true };

        if (!fits(diff)) break;

        spent += entryBytes(diff);
        diffs[key] = diff;
      }

      return diffs;
    },
  });
