// What a tool result's `details` record of a change to a file (`docs/architecture/diffs-and-review.md` → Call diffs). The tools
// that write it (`write`, and `codemode` for the calls its script made: `@cloudpid/extensions/call-diff`) and the web
// app that reads it share this one shape.
// @effect-diagnostics missingPipeableSignature:off -- the decoder is called with a value, not piped.
import * as Schema from "effect/Schema";

/**
 * A change as a result records it: the unified patch (four lines of context), or the reason there is none, and whether
 * the call made the file. Fields that are absent are false.
 */
export const RecordedDiff = Schema.Struct({
  /** The path as the model gave it; a `write` records it, so a `codemode` script's calls name their file. */
  path: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Boolean),
  /** The old and new text together pass 1 MiB, the patch is too long, or lining the texts up took too long. */
  tooLarge: Schema.optional(Schema.Boolean),
  /** The old file is binary, or could not be read. */
  binary: Schema.optional(Schema.Boolean),
});

export type RecordedDiff = typeof RecordedDiff.Type;

/** Decodes a result's `details`, or one entry of a `codemode` result's `details.diffs`. */
export const decodeRecordedDiff = Schema.decodeUnknownOption(RecordedDiff);
