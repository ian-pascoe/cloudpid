// @effect-diagnostics missingPipeableSignature:off -- builders and checks of plain values, not combinators.

// Importing pi's `mcpServers` JSON (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section):
// the pasted text read into one line per entry, each with its problems before anything is saved; a name the Scope already
// has asks Replace or Skip, and a top-level `autoEnableCodemode` is ignored with a hint.

import {
  isJsonObject,
  MCP_LIMITS,
  type McpCredentialLiteral,
  normalizeMcpName,
} from "@cloudpid/config";
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

/** The import: the text pasted, and what the owner chose for each name the Scope has. */
export interface McpImportDraft {
  readonly kind: "import";
  readonly text: string;
  readonly choices: Readonly<Record<string, McpConflictChoice>>;
}

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

/** Something the import ignores, and the section of the Settings page that says more, if one does. */
export interface McpImportHint {
  readonly text: string;
  readonly link: "tools" | null;
}

/** What the pasted text holds. */
export interface McpImportPreview {
  /** Why the text is not pi's `mcpServers` JSON, or null. */
  readonly problem: string | null;
  readonly entries: ReadonlyArray<McpImportEntry>;
  /** What is ignored: `autoEnableCodemode`, and any other top-level key. */
  readonly hints: ReadonlyArray<McpImportHint>;
}

/** Where pi's `autoEnableCodemode` goes in cloudpid. */
export const AUTO_ENABLE_CODEMODE_HINT =
  "autoEnableCodemode is ignored: cloudpid has no such setting. Whether the model is offered codemode is the Tools section's (the offered tools).";

const NOT_MCP_SERVERS =
  'Paste pi\'s mcpServers JSON: {"mcpServers": {"name": {"url": "https://…"}}}';

/** The entries read so far, the names they took, and how many servers the Scope would then have. */
type Read = {
  readonly entries: ReadonlyArray<McpImportEntry>;
  readonly taken: ReadonlyArray<string>;
  readonly count: number;
};

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
  const servers = isJsonObject(document) ? document["mcpServers"] : undefined;

  if (!isJsonObject(document) || !isJsonObject(servers)) return empty(NOT_MCP_SERVERS);

  const held = rules.atGlobal ? rules.names.global : rules.names.own;

  const none: Read = { entries: [], taken: [], count: held.length };

  const read = Arr.reduce(
    Record.toEntries(servers),
    none,
    ({ entries, taken, count }, [name, entry]): Read => {
      const conflict = Arr.contains(held, name);
      const replacesGlobal = !rules.atGlobal && !conflict && Arr.contains(rules.names.global, name);

      const checked = isJsonObject(entry)
        ? checkMcpEntry({
            name,
            entry,
            rules: { ...rules, editing: conflict ? name : null },
            references,
          })
        : { entry: null, problems: ["is not an object"], warnings: [], hints: [] };

      const clash = Option.match(
        Arr.findFirst(taken, (earlier) => normalizeMcpName(earlier) === normalizeMcpName(name)),
        {
          onNone: () => [],
          onSome: (earlier) => [`clashes with "${earlier}", also in this JSON`],
        },
      );

      const fits = checked.problems.length === 0 && clash.length === 0 && !conflict;
      const over = fits && count >= MCP_LIMITS.servers;

      return {
        entries: [
          ...entries,
          {
            name,
            entry,
            conflict,
            replacesGlobal,
            problems: [
              ...checked.problems,
              ...clash,
              ...(over ? [`is over the ${MCP_LIMITS.servers} servers a Scope may have`] : []),
            ],
            warnings: checked.warnings,
            hints: checked.hints,
          },
        ],
        taken: [...taken, name],
        count: fits ? count + 1 : count,
      };
    },
  );

  const others = Arr.filterMap(Record.toEntries(document), ([key]) =>
    key === "mcpServers" || key === "autoEnableCodemode" ? Result.failVoid : Result.succeed(key),
  );

  return {
    problem: null,
    entries: read.entries,
    hints: [
      ...(Predicate.hasProperty(document, "autoEnableCodemode")
        ? [{ text: AUTO_ENABLE_CODEMODE_HINT, link: "tools" as const }]
        : []),
      ...(others.length === 0
        ? []
        : [{ text: `Other top-level keys are ignored: ${Arr.join(others, ", ")}.`, link: null }]),
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
