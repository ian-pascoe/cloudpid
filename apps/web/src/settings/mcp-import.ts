// @effect-diagnostics missingPipeableSignature:off -- builders and checks of plain values, not combinators.

// Importing pi's `mcpServers` JSON (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section):
// the pasted text read into one line per entry, each with its problems before anything is saved; a name the Scope already
// has asks Replace or Skip, and a top-level `autoEnableCodemode` is ignored with a hint.

import { MCP_LIMITS, type McpCredentialLiteral, normalizeMcpName } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { checkMcpEntry, type McpNameRules } from "./mcp-form.ts";
import type { McpReferenceNames } from "./mcp-model.ts";

/** What the owner chose for a name the Scope has already. */
export type McpConflictChoice = "replace" | "skip";

/** One entry of the pasted JSON. */
export interface McpImportEntry {
  readonly name: string;
  readonly entry: Schema.Json;
  /** The Scope has a server of this name already: Replace or Skip. */
  readonly conflict: boolean;
  /** At an Environment, Global has a server of this name, which this entry would replace there. */
  readonly replacesGlobal: boolean;
  /** Why it cannot be saved. */
  readonly problems: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<McpCredentialLiteral>;
  readonly hints: ReadonlyArray<string>;
}

/** What the pasted text holds. */
export interface McpImportPreview {
  /** Why the text is not pi's `mcpServers` JSON, or null. */
  readonly problem: string | null;
  readonly entries: ReadonlyArray<McpImportEntry>;
  /** What is ignored: `autoEnableCodemode`, and any other top-level key. */
  readonly hints: ReadonlyArray<string>;
}

const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

/** Where pi's `autoEnableCodemode` goes in cloudpid. */
export const AUTO_ENABLE_CODEMODE_HINT =
  "autoEnableCodemode is ignored: cloudpid has no such setting. Whether the model is offered codemode is the Tools section's (the offered tools).";

const NOT_MCP_SERVERS =
  'Paste pi\'s mcpServers JSON: {"mcpServers": {"name": {"url": "https://…"}}}';

/**
 * The entries of `text`, pi's `mcpServers` JSON, checked for the Scope `rules` describe: each by the rules of its name, the
 * schema, the bounds (a 51st server is a problem) and, against `references`, the `${NAME}`s it reads.
 */
export const previewMcpImport = (
  text: string,
  rules: Omit<McpNameRules, "editing">,
  references: McpReferenceNames | null,
): McpImportPreview => {
  const empty = (problem: string | null): McpImportPreview => ({ problem, entries: [], hints: [] });

  if (text.trim() === "") return empty(null);

  const parsed = Result.try({
    try: (): Schema.Json => JSON.parse(text),
    catch: (error) => (error instanceof Error ? error.message : String(error)),
  });

  if (Result.isFailure(parsed)) return empty(`Not JSON: ${parsed.failure}`);

  const document = parsed.success;
  const servers = isObject(document) ? document["mcpServers"] : undefined;

  if (!isObject(document) || !isObject(servers)) return empty(NOT_MCP_SERVERS);

  const held = rules.atGlobal ? rules.names.global : rules.names.own;
  const taken: Array<string> = [];
  let count = held.length;

  const entries = Arr.map(Record.toEntries(servers), ([name, entry]): McpImportEntry => {
    const conflict = Arr.contains(held, name);
    const replacesGlobal = !rules.atGlobal && !conflict && Arr.contains(rules.names.global, name);

    const checked = isObject(entry)
      ? checkMcpEntry({
          name,
          entry,
          rules: { ...rules, editing: conflict ? name : null },
          references,
        })
      : {
          entry: null,
          problems: ["is not an object"],
          warnings: [],
          hints: [],
        };

    const twin = Arr.findFirst(
      taken,
      (earlier) => normalizeMcpName(earlier) === normalizeMcpName(name),
    );

    const clash = Option.match(twin, {
      onNone: () => [],
      onSome: (earlier) => [`clashes with "${earlier}", also in this JSON`],
    });

    const over =
      checked.problems.length === 0 &&
      clash.length === 0 &&
      !conflict &&
      count >= MCP_LIMITS.servers
        ? [`is over the ${MCP_LIMITS.servers} servers a Scope may have`]
        : [];

    taken.push(name);

    if (checked.problems.length === 0 && clash.length === 0 && !conflict) count += 1;

    return {
      name,
      entry,
      conflict,
      replacesGlobal,
      problems: [...checked.problems, ...clash, ...over],
      warnings: checked.warnings,
      hints: checked.hints,
    };
  });

  const others = Arr.filterMap(Record.toEntries(document), ([key]) =>
    key === "mcpServers" || key === "autoEnableCodemode" ? Result.failVoid : Result.succeed(key),
  );

  return {
    problem: null,
    entries,
    hints: [
      ...(Predicate.hasProperty(document, "autoEnableCodemode") ? [AUTO_ENABLE_CODEMODE_HINT] : []),
      ...(others.length === 0
        ? []
        : [`Other top-level keys are ignored: ${Arr.join(others, ", ")}.`]),
    ],
  };
};

/** Whether `entry` is saved by the import, given the owner's choices (a conflict is skipped unless Replace is chosen). */
const saved = (
  entry: McpImportEntry,
  choices: Readonly<Record<string, McpConflictChoice>>,
): boolean => entry.problems.length === 0 && (!entry.conflict || choices[entry.name] === "replace");

/** The servers the import writes: each valid entry, and each conflicting one the owner chose to Replace. */
export const mcpImportWrites = (
  preview: McpImportPreview,
  choices: Readonly<Record<string, McpConflictChoice>>,
): ReadonlyArray<{ readonly name: string; readonly entry: Schema.Json }> =>
  Arr.filterMap(preview.entries, (entry) =>
    saved(entry, choices)
      ? Result.succeed({ name: entry.name, entry: entry.entry })
      : Result.failVoid,
  );
