// The Call diff of `write`, and of the `edit` and `write` calls a `codemode` script makes (`docs/spec.md` → Diffs and
// review). A Call diff is what a result's `details` record of a change: a unified patch with four lines of context, as
// `edit` records, and flags where there is none to record:
//
// - `created`: the file did not exist.
// - `binary`: the old file has a NUL in its first 8,000 bytes, or could not be read.
// - `tooLarge`: the two texts together pass 1 MiB, the patch passes 512 KiB, or lining the texts up took more than 1 s.
//
// The result is one SQLite row (2 MB), so a patch is bounded before it is stored; the write itself is never held back by
// it. These are plain functions over text (`writeDetails`, `capturedDiffs`) and over a file system (`oldFile`).
// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off -- plain functions over text and native arrays.
import type { Context, JsonValue } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import * as Diff from "diff";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** The most the old and the new text of a call may weigh together (UTF-8 bytes) for a patch to be made. */
export const MAX_DIFF_INPUT_BYTES = 1024 * 1024;

/** The longest patch (UTF-8 bytes) a result records. */
export const MAX_PATCH_BYTES = 512 * 1024;

/** How long lining two texts up may take, in ms: jsdiff's `timeout`. */
export const LINE_UP_BUDGET_MS = 1000;

/** The bytes at the start of a file searched for a NUL, which marks it binary (git's rule). */
export const BINARY_SCAN_BYTES = 8000;

/**
 * The patches the nested calls of one `codemode` result record, together (UTF-8 bytes). The result is one row, with room
 * for the text of the script's output and its images (`images/results.ts`), so a script that changes many files cannot
 * fill it: the calls past this are `tooLarge`.
 */
export const MAX_CODEMODE_DIFF_BYTES = 256 * 1024;

/** What a result's `details` record of a change; the fields that are absent are false. */
export type CallDiffDetails = {
  patch?: string;
  created?: true;
  tooLarge?: true;
  binary?: true;
};

const encoder = new TextEncoder();

export const byteLength = (text: string): number => encoder.encode(text).length;

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
export const writeDetails = (path: string, old: OldFile, content: string): CallDiffDetails => {
  if (old.kind === "binary" || old.kind === "unreadable") return { binary: true };

  if (old.kind === "tooLarge") return { tooLarge: true };

  const created = old.kind === "missing" ? ({ created: true } as const) : {};
  const before = old.kind === "text" ? old.text : "";

  if (byteLength(before) + byteLength(content) > MAX_DIFF_INPUT_BYTES) {
    return { ...created, tooLarge: true };
  }

  // `undefined` when the budget ran out.
  const patch = Diff.createTwoFilesPatch(path, path, before, content, undefined, undefined, {
    context: 4,
    headerOptions: Diff.FILE_HEADERS_ONLY,
    timeout: LINE_UP_BUDGET_MS,
  });

  if (patch === undefined || byteLength(patch) > MAX_PATCH_BYTES) {
    return { ...created, tooLarge: true };
  }

  return { ...created, patch };
};

/**
 * What `env` holds at `path` before a write of `bytes` bytes. A file that the two together would pass the cap with is not
 * read. A path the file system cannot answer for, or a file it cannot read, is `unreadable`; one it does not have is
 * `missing`.
 */
export const oldFile = async (
  env: Pick<ExecutionEnv, "fileInfo" | "readBinaryFile">,
  path: string,
  bytes: number,
  context: Context,
): Promise<OldFile> => {
  const info = await env.fileInfo(path, context);

  if (!info.ok)
    return info.error.code === "not_found" ? { kind: "missing" } : { kind: "unreadable" };

  if (info.value.size + bytes > MAX_DIFF_INPUT_BYTES) return { kind: "tooLarge" };

  const read = await env.readBinaryFile(path, context);

  if (!read.ok) return { kind: "unreadable" };

  if (read.value.subarray(0, BINARY_SCAN_BYTES).includes(0)) return { kind: "binary" };

  return { kind: "text", text: new TextDecoder().decode(read.value) };
};

const decodeRecorded = Schema.decodeUnknownOption(
  Schema.Struct({
    patch: Schema.optional(Schema.String),
    created: Schema.optional(Schema.Boolean),
    tooLarge: Schema.optional(Schema.Boolean),
    binary: Schema.optional(Schema.Boolean),
  }),
);

/** The Call diff fields in a nested call's `details`; none for details that carry none. */
export const callDiffOf = (details: JsonValue | undefined): CallDiffDetails | undefined =>
  Option.getOrUndefined(
    Option.flatMap(decodeRecorded(details), (recorded) => {
      const found: CallDiffDetails = {};

      if (recorded.patch !== undefined) found.patch = recorded.patch;

      if (recorded.created === true) found.created = true;

      if (recorded.tooLarge === true) found.tooLarge = true;

      if (recorded.binary === true) found.binary = true;

      return found.patch === undefined && found.tooLarge === undefined && found.binary === undefined
        ? Option.none()
        : Option.some(found);
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
 * in the script (the `id` of its row): the patch fields of each call that finished, from `detailsOf` its number. A
 * patch past 512 KiB, or past the budget the result's patches share, is recorded as `tooLarge`.
 */
export const capturedDiffs = (
  details: JsonValue | undefined,
  detailsOf: (id: number) => Promise<JsonValue | undefined>,
): Promise<Record<string, CallDiffDetails>> =>
  Option.match(decodeListed(details), {
    onNone: () => Promise.resolve({}),
    onSome: async ({ calls }) => {
      const diffs: Record<string, CallDiffDetails> = {};
      let spent = 0;

      for (const call of calls) {
        if (!DIFFING_TOOLS.has(call.name) || call.status !== "ok") continue;

        const found = callDiffOf(await detailsOf(call.id));

        if (found === undefined) continue;

        const size = found.patch === undefined ? 0 : byteLength(found.patch);

        if (
          found.patch !== undefined &&
          (size > MAX_PATCH_BYTES || spent + size > MAX_CODEMODE_DIFF_BYTES)
        ) {
          const { patch: _left, ...rest } = found;

          diffs[String(call.id)] = { ...rest, tooLarge: true };
        } else {
          spent += size;
          diffs[String(call.id)] = found;
        }
      }

      return diffs;
    },
  });
