// An agent's change to an MCP server, as the Agent changes section and the transcript's card show it
// (`docs/architecture/mcp-configuration.md` → Records and revert, In the UI): the field `mcp.servers.<name>` is a whole entry
// (a line diff of its JSON in pi's key order), and `.enabled`, `.exposure` and `.toolExposure` are one key (on/off, the
// exposure, one `pattern → exposure` line per key). Pure, so both read one rule.
// @effect-diagnostics missingPipeableSignature:off
import type { AgentChange } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";

/** The key of a server an Agent change is of: the whole entry, or one of the keys an adjustment may hold. */
export type McpChangeKey = "entry" | "enabled" | "exposure" | "toolExposure";

const KEY_WORDS: Readonly<Record<Exclude<McpChangeKey, "entry">, string>> = {
  enabled: "on/off",
  exposure: "exposure",
  toolExposure: "tool exposure",
};

const isKey = (key: string): key is Exclude<McpChangeKey, "entry"> =>
  key === "enabled" || key === "exposure" || key === "toolExposure";

/** The server and key an Agent change's `field` names, or null for a field that is no MCP server's. */
export const mcpChangeField = (
  field: string,
): { readonly name: string; readonly key: McpChangeKey } | null => {
  const [root, servers, name, key, ...rest] = field.split(".");

  if (root !== "mcp" || servers !== "servers" || name === undefined || name === "") return null;

  if (rest.length > 0) return null;

  if (key === undefined) return { name, key: "entry" };

  return isKey(key) ? { name, key } : null;
};

/** `MCP server linear`, with `· on/off`, `· exposure` or `· tool exposure` for a key. */
export const mcpFieldText = (field: string): string | null => {
  const found = mcpChangeField(field);

  if (found === null) return null;

  return found.key === "entry"
    ? `MCP server ${found.name}`
    : `MCP server ${found.name} · ${KEY_WORDS[found.key]}`;
};

/** A key's value of an Agent change, as shown: on or off, the exposure, or one line per `toolExposure` key. */
const keyValueText = (key: Exclude<McpChangeKey, "entry">, value: Schema.Json | null): string => {
  if (value === null) return "not set";

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
  const found = mcpChangeField(field);

  if (found === null) return null;

  return found.key === "entry"
    ? value === null
      ? "not set"
      : JSON.stringify(value, null, 2)
    : keyValueText(found.key, value);
};

/** The two texts of a whole entry's change, for a line diff: pretty JSON in the order written, none as empty. */
export const mcpEntryTexts = (
  field: string,
  before: Schema.Json | null,
  after: Schema.Json | null,
): { readonly before: string; readonly after: string } | null =>
  mcpChangeField(field)?.key === "entry"
    ? {
        before: before === null ? "" : JSON.stringify(before, null, 2),
        after: after === null ? "" : JSON.stringify(after, null, 2),
      }
    : null;

/**
 * What an Agent change says of a value that was inherited (at an Environment, from Global): its own words for a server's
 * entry (`Global's entry (inherited)`), the plain note for any other setting; null for a value that is not.
 */
export const inheritedNote = (field: string, inherited: boolean | undefined): string | null => {
  if (inherited !== true) return null;

  return mcpChangeField(field)?.key === "entry"
    ? "Global's entry (inherited)"
    : "Inherited from Global";
};

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
            mcpChangeField(change.field)?.name === name,
        ),
        Order.mapInput(Order.flip(Order.Number), (change: AgentChange) => change.id),
      ),
    ),
  );
