// @effect-diagnostics preferEffectArray:off -- plain functions over native arrays.

import { TOOL_PATTERN } from "@cloudpid/config";

/** The offered tools as the Tools section's text box shows them: one name or pattern per line. */
export const offeredToText = (offered: ReadonlyArray<string>): string => offered.join("\n");

/** The offered tools a text box holds: one name or pattern per line, blank lines and spaces dropped, repeats once. */
export const offeredFromText = (text: string): string[] => [
  ...new Set(
    text
      .split(/[\n,]/)
      .map((line) => line.trim())
      .filter((line) => line !== ""),
  ),
];

/** The entries of `offered` that are not a snake_case tool name or pattern, which the settings refuse. */
export const badOfferedEntries = (offered: ReadonlyArray<string>): string[] =>
  offered.filter((entry) => !TOOL_PATTERN.test(entry));
