import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A subagent tool call failed; its message is what the model sees. */
export class SubagentError extends Schema.TaggedError<
  SubagentError,
  { readonly brand: unique symbol }
>()("SubagentError", { message: Schema.String }) {}

export const fail = (message: string) => Effect.fail(SubagentError.make({ message }));
