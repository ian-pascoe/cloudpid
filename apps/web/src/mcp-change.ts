// An agent's change to an MCP server, as the Agent changes section and the transcript's card show it
// (`docs/architecture/mcp-configuration.md` → Records and revert, In the UI): the field `mcp.servers.<name>` is a whole entry
// (a line diff of its JSON in pi's key order), and `.enabled`, `.exposure` and `.toolExposure` are one key (on/off, the
// exposure, one `pattern → exposure` line per key). Pure, so both read one rule; the field is read by `parseMcpField`.
// @effect-diagnostics missingPipeableSignature:off
import { MCP_KEY_LABELS, type McpAdjustmentKey, parseMcpField } from "@cloudpid/config";
import type { AgentChange } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";

/** `MCP server linear`, with `· on/off`, `· exposure` or `· tool exposure` for a key. */
export const mcpFieldText = (field: string): string | null => {
  const found = parseMcpField(field);

  if (found === null) return null;

  return found.key === null
    ? `MCP server ${found.name}`
    : `MCP server ${found.name} · ${MCP_KEY_LABELS[found.key]}`;
};

/**
 * A key's value of an Agent change, as shown: on or off, the exposure, or one line per `toolExposure` key. A key a record
 * holds as null is one its entry did not write, which reads as its default.
 */
const keyValueText = (key: McpAdjustmentKey, value: Schema.Json | null): string => {
  if (value === null) {
    switch (key) {
      case "enabled":
        return "on (default)";
      case "exposure":
        return "codemode (default)";
      case "toolExposure":
        return "no keys";
    }
  }

  switch (key) {
    case "enabled":
      return Predicate.isBoolean(value) ? (value ? "on" : "off") : JSON.stringify(value);
    case "exposure":
      return Predicate.isString(value) ? value : JSON.stringify(value);
    case "toolExposure": {
      if (!Predicate.isObject(value)) return JSON.stringify(value);

      const lines = Arr.map(
        Record.toEntries(value),
        ([tool, exposure]) =>
          `${tool} → ${Predicate.isString(exposure) ? exposure : JSON.stringify(exposure)}`,
      );

      return lines.length === 0 ? "no keys" : Arr.join(lines, "\n");
    }
  }
};

/** A value of an Agent change to MCP field `field`, or null when the field is no MCP server's (the caller shows it). */
export const mcpValueText = (field: string, value: Schema.Json | null): string | null => {
  const found = parseMcpField(field);

  if (found === null) return null;

  if (found.key !== null) return keyValueText(found.key, value);

  return value === null ? "not set" : JSON.stringify(value, null, 2);
};

/** The two texts of a whole entry's change, for a line diff: pretty JSON in the order written, none as empty. */
export const mcpEntryTexts = (
  field: string,
  before: Schema.Json | null,
  after: Schema.Json | null,
): { readonly before: string; readonly after: string } | null =>
  parseMcpField(field)?.key === null
    ? {
        before: before === null ? "" : JSON.stringify(before, null, 2),
        after: after === null ? "" : JSON.stringify(after, null, 2),
      }
    : null;

/**
 * What an Agent change says of a value that was inherited (at an Environment): its own words for a server's entry
 * (`Global's entry (inherited)`) and for one of its keys (the layer it comes from is Global's entry or a Repo's file), the plain
 * note for any other setting; null for a value that is not.
 */
export const inheritedNote = (field: string, inherited: boolean | undefined): string | null => {
  if (inherited !== true) return null;

  const found = parseMcpField(field);

  if (found === null) return "Inherited from Global";

  return found.key === null ? "Global's entry (inherited)" : "Inherited (Global's or a Repo's)";
};

/** `label`, with the note that its value was inherited when it was. */
export const inheritedLabel = (
  label: string,
  field: string,
  inherited: boolean | undefined,
): string => {
  const note = inheritedNote(field, inherited);

  return note === null ? label : `${label} · ${note}`;
};

/** The notes of a change whose values were inherited, one line each: `Before: …`, `After: …`. */
export const inheritedLines = (
  change: Pick<AgentChange, "field" | "beforeInherited" | "afterInherited">,
): ReadonlyArray<string> =>
  Arr.getSomes([
    Option.map(
      Option.fromNullishOr(inheritedNote(change.field, change.beforeInherited)),
      (note) => `Before: ${note}`,
    ),
    Option.map(
      Option.fromNullishOr(inheritedNote(change.field, change.afterInherited)),
      (note) => `After: ${note}`,
    ),
  ]);

/**
 * The agent's latest change to MCP server `name` that the owner has neither reverted nor dismissed (the lists leave out
 * the dismissed), from `changes` as the lists give them (newest first or not): what a row's _Changed by the agent_ mark
 * links to. The owner's own reverts are not marks.
 */
export const latestAgentChange = (
  changes: ReadonlyArray<AgentChange>,
  name: string,
): AgentChange | null =>
  Option.getOrNull(
    Arr.head(
      Arr.sort(
        Arr.filter(
          changes,
          (change) =>
            change.actor === "agent" &&
            change.revertedBy === null &&
            parseMcpField(change.field)?.name === name,
        ),
        Order.mapInput(Order.flip(Order.Number), (change: AgentChange) => change.id),
      ),
    ),
  );
