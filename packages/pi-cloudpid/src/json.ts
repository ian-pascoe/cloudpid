// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off -- native array methods over plain values (the bundle carries no Effect runtime); native object methods over plain values; plain functions over values, called directly.
/**
 * The endpoint's answers as JSON values, read field by field. The SDK hands `structuredContent` over as `unknown`;
 * {@link toJson} is the one place it is checked, and everything after it reads typed values.
 */
import * as Predicate from "effect/Predicate";

export type Json = null | boolean | number | string | ReadonlyArray<Json> | JsonObject;

export interface JsonObject {
  readonly [key: string]: Json;
}

/** Whether `value` is JSON all the way down. */
export const isJson = (value: unknown): value is Json =>
  value === null ||
  Predicate.isString(value) ||
  Predicate.isNumber(value) ||
  Predicate.isBoolean(value) ||
  (Array.isArray(value) && value.every(isJson)) ||
  (Predicate.isObject(value) && Object.values(value).every(isJson));

/** Whether `value` is a JSON object (an array is not). */
const isJsonObject = (value: Json | undefined): value is JsonObject =>
  value !== undefined && value !== null && Predicate.isObject(value);

/** `value` as a JSON object, when it is one. */
export const toObject = (value: Json | undefined): JsonObject | undefined =>
  isJsonObject(value) ? value : undefined;

/** `fields[key]` when it is a string. */
export const stringField = (fields: JsonObject, key: string): string | undefined => {
  const value = fields[key];

  return Predicate.isString(value) ? value : undefined;
};

/** `fields[key]` when it is an integer. */
export const integerField = (fields: JsonObject, key: string): number | undefined => {
  const value = fields[key];

  return Predicate.isNumber(value) && Number.isInteger(value) ? value : undefined;
};

/** `fields[key]` when it is an object. */
export const objectField = (fields: JsonObject, key: string): JsonObject | undefined =>
  toObject(fields[key]);

/** The objects of `fields[key]`, when it is an array (anything else in it is skipped). */
export const objectsField = (fields: JsonObject, key: string): ReadonlyArray<JsonObject> => {
  const value = fields[key];

  const found: Array<JsonObject> = [];

  if (Array.isArray(value)) {
    for (const item of value) {
      const object = toObject(item);

      if (object !== undefined) found.push(object);
    }
  }

  return found;
};

/** The strings of `fields[key]`, when it is an array. */
export const stringsField = (fields: JsonObject, key: string): ReadonlyArray<string> => {
  const value = fields[key];

  return Array.isArray(value) ? value.filter(Predicate.isString) : [];
};
