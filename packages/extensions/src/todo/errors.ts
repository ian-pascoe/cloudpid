// @effect-diagnostics missingPipeableSignature:off -- a tagged error class.
import * as Schema from "effect/Schema";

/** A `todo` call failed; its message is what the model sees. */
export class TodoError extends Schema.TaggedError<TodoError, { readonly brand: unique symbol }>()(
  "TodoError",
  { message: Schema.String },
) {}
