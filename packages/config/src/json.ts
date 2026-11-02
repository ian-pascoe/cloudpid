// What the settings modules share about JSON documents: telling an object from an array, and the size of a text.
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";

/** Whether `value` is a JSON object, not an array and not null. */
export const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

/** Whether `value` is a JSON array. */
export const isJsonArray = (value: Schema.Json | undefined): value is Schema.JsonArray =>
  Arr.isArray(value);

/** Encodes text as UTF-8. */
export const utf8Encoder = new TextEncoder();

/** How many bytes of UTF-8 `text` is. */
export const utf8Bytes = (text: string): number => utf8Encoder.encode(text).length;
