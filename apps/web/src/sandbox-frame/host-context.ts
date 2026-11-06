// docs/architecture/visuals.md → The frame; docs/architecture/mcp-apps.md → The bridge (hostContext). What a sandboxed frame
// is told of its host that App Views and Visuals share: the style variables (cloudpid's tokens as the page resolves them, and
// its constants; the table is `TOKENS` and `CONSTANTS` in `packages/protocol/src/style-variables.ts`) and the difference
// between two host contexts, which `host-context-changed` carries. Pure: the page's values are handed in.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off -- small native tables of CSS variables.
import { CONSTANTS, TOKENS } from "@cloudpid/protocol";
import type { McpUiHostContext, McpUiStyles } from "@modelcontextprotocol/ext-apps";

/**
 * The style variables of the host: cloudpid's tokens as the page resolves them (`read` gives a custom property's value, or
 * an empty string), and its constants. Unmapped ones are omitted.
 */
export const hostStyleVariables = (read: (property: string) => string): McpUiStyles => {
  const variables: Partial<Record<string, string>> = {};

  for (const [key, property] of TOKENS) {
    const value = read(property).trim();

    if (value !== "") variables[key] = value;
  }

  for (const [key, value] of CONSTANTS) variables[key] = value;

  // SAFETY: the table's keys are the spec's style variable names, and the spec types the record with every key, though a host
  // sends the ones it has (the generated schema is partial).
  return variables as McpUiStyles;
};

/**
 * What of `next` differs from `before`, by top-level key, for `host-context-changed` (which carries only what changed);
 * undefined when nothing does. Values are compared as the JSON they are sent as.
 */
export const changedContext = (
  before: McpUiHostContext,
  next: McpUiHostContext,
): McpUiHostContext | undefined => {
  const changed: McpUiHostContext = {};

  for (const key of Object.keys(next)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(next[key])) changed[key] = next[key];
  }

  return Object.keys(changed).length === 0 ? undefined : changed;
};
