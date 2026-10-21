// @effect-diagnostics missingPipeableSignature:off -- plain string functions.
import * as Arr from "effect/Array";

const escape = (text: string): string => text.replace(/[.+^${}()|[\]\\?]/g, "\\$&");

/** Whether tool `name` matches `pattern`, where `*` matches any run of characters. */
export const matchesPattern = (pattern: string, name: string): boolean =>
  new RegExp(`^${Arr.join(Arr.map(pattern.split("*"), escape), ".*")}$`).test(name);
