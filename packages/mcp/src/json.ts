// JSON values as the host and the core read them: a guard for a JSON object, so every reader tells one from an array
// and from `null` the same way. SDK-free, so `@cloudpid/mcp/types` exports it.
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";

/** A JSON object: string keys to JSON values. */
export type JsonObject = { readonly [key: string]: Schema.Json };

/** Whether `value` is a JSON object, never an array or `null`. */
export const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);
