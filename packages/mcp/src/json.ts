// JSON values as the host and the core read them: the JSON object's Schema and type, and a guard for one, so every
// reader tells one from an array and from `null` the same way. SDK-free, so `@cloudpid/mcp/types` exports them.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";

/** A JSON object: string keys to JSON values, as rows, server answers and definitions cross the edge. */
export const JsonObject = Schema.Record(Schema.String, Schema.Json);

export type JsonObject = typeof JsonObject.Type;

/** Whether `value` is a JSON object, never an array or `null`. */
export const isJsonObject = (value: Schema.Json | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

const decodeJsonList = Schema.decodeUnknownOption(Schema.Array(Schema.Json));

/** `value` as a list of JSON, or an empty list when it is none (an absent key, or any other value). */
export const jsonListOf = (value: Schema.Json | undefined): ReadonlyArray<Schema.Json> =>
  Option.getOrElse(decodeJsonList(value), () => []);

/** `fields` without the keys whose value is `undefined`, so a record built from them has no key for what is absent. */
export const present = <A extends object>(fields: A) =>
  // SAFETY: only the keys whose value is not `undefined` are kept, which is what `Exclude<A[K], undefined>` says.
  Record.filter(fields as Readonly<Record<string, unknown>>, Predicate.isNotUndefined) as {
    [K in keyof A]?: Exclude<A[K], undefined>;
  };
