// JSON values as the host and the core read them: the JSON object's Schema and type, and a guard for one, so every
// reader tells one from an array and from `null` the same way. SDK-free, so `@cloudpid/mcp/types` exports them.
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** A JSON object: string keys to JSON values, as rows, server answers and definitions cross the edge. */
export const JsonObject = Schema.Record(Schema.String, Schema.Json);

export type JsonObject = typeof JsonObject.Type;

/** Whether `value` is a JSON object, never an array or `null`. */
export const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);
