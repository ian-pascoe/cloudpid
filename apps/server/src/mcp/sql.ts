// Small conversions between the host's rows and SQLite's values, shared by its stores.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** `value` as a column value: `null` where absent. */
export const nullable = <A>(value: A | undefined): A | null => value ?? null;

/** A column value as an optional field: absent where `null`. */
export const optional = <A>(value: A | null): A | undefined => value ?? undefined;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A stored JSON text, or absent when there is none or it no longer parses. */
export const jsonColumn = (text: string | undefined): Schema.Json | undefined =>
  text === undefined ? undefined : Option.getOrUndefined(decodeJson(text));
