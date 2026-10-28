// @effect-diagnostics missingPipeableSignature:off -- plain string functions.
// A child's ordinary tools (`docs/architecture/agent-capabilities.md` → Subagents): the `read` and `modify` presets or an exact list, always
// within the capability ceiling, the ordinary tools its caller has. The six coordinator tools are never ordinary: a
// child gets them by its delegation, not its selection.
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { matchesPattern } from "../patterns.ts";
import { ENVIRONMENT_TOOL_PREFIX } from "../environment.ts";
import { SKILL_SEARCH_TOOL } from "../skill-search-tool.ts";
import { SETTINGS_TOOL_PREFIX } from "../settings.ts";
import { PARENT_ONLY_SECRET_TOOLS } from "../secrets/extension.ts";
import type { Toolsets } from "./options.ts";

/** The coordinator tools, in the order a child is given them. */
export const COORDINATOR_TOOLS = [
  "subagent",
  "agent_message",
  "subagent_wait",
  "subagent_status",
  "subagent_cancel",
  "subagent_delete",
] as const;

const COORDINATOR: ReadonlySet<string> = new Set(COORDINATOR_TOOLS);

/**
 * Tools a child is never granted, whatever its selection. `context_rollover` hands off by ending the child's run, whose
 * answer is then the Rollover call rather than the turn's result, so a child keeps pi-durable's own compaction. A child
 * uses the Secrets its root holds but cannot ask for or forget them. `skill_search` is the root's with the
 * `environment_skill_*` tools it finds Skills for (ADR-0026).
 */
export const PARENT_ONLY_TOOLS = [
  "context_rollover",
  SKILL_SEARCH_TOOL,
  ...PARENT_ONLY_SECRET_TOOLS,
] as const;

/**
 * The prefixes of the families of tools a child is never granted: the `environment_*` and `settings_*` tools change the
 * harness itself (ADR-0019), which only the root conversation does, as only it asks for Secrets.
 */
export const PARENT_ONLY_TOOL_PREFIXES = [ENVIRONMENT_TOOL_PREFIX, SETTINGS_TOOL_PREFIX] as const;

const PARENT_ONLY: ReadonlySet<string> = new Set(PARENT_ONLY_TOOLS);

/** Whether tool `name` is the root conversation's only. */
export const isParentOnly = (name: string): boolean =>
  PARENT_ONLY.has(name) || Arr.some(PARENT_ONLY_TOOL_PREFIXES, (prefix) => name.startsWith(prefix));

/** What `subagent`'s `tools` asks for: a preset, or exact tool names. Omitted: the caller's own ordinary tools. */
export type ToolSelection = "none" | "read" | "modify" | ReadonlyArray<string>;

/** The ordinary tools a child is granted, and the configured patterns that matched nothing it may have. */
export type ResolvedTools = {
  readonly tools: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
};

/** `names` without the coordinator tools. */
export const ordinaryTools = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.filter(names, (name) => !COORDINATOR.has(name));

/**
 * The ordinary tools `selection` grants under `ceiling`, the caller's ordinary tools without the parent-only ones. The base toolset applies to every
 * selection, and the presets add theirs; a pattern that matches nothing within the ceiling is skipped with a warning.
 * Exact names stay strict: a coordinator tool, or a name outside the ceiling, fails the spawn.
 */
export const resolveTools = (
  selection: ToolSelection | undefined,
  ceiling: ReadonlyArray<string>,
  toolsets: Toolsets,
): Result.Result<ResolvedTools, string> => {
  const grantable = Arr.filter(ceiling, (name) => !isParentOnly(name));

  return resolveWithin(selection, grantable, toolsets);
};

const resolveWithin = (
  selection: ToolSelection | undefined,
  ceiling: ReadonlyArray<string>,
  toolsets: Toolsets,
): Result.Result<ResolvedTools, string> => {
  const requested: ReadonlyArray<string> =
    selection === undefined
      ? ceiling
      : selection === "none" || selection === "read" || selection === "modify"
        ? []
        : selection;

  const coordinator = Arr.filter(requested, (name) => COORDINATOR.has(name));

  if (coordinator.length > 0) {
    return Result.fail(
      `Coordinator tools are granted by delegation and must not appear in tools: ${Arr.join(coordinator, ", ")}`,
    );
  }

  const outside = Arr.filter(requested, (name) => !Arr.contains(ceiling, name));

  if (outside.length > 0) {
    return Result.fail(
      `${Arr.join(outside, ", ")} ${outside.length === 1 ? "is" : "are"} unknown or outside your capability ceiling. ${
        ceiling.length === 0
          ? "You have no ordinary tools to grant."
          : `Tools you may grant: ${Arr.join(ceiling, ", ")}.`
      }`,
    );
  }

  const keys: Array<keyof Toolsets> = ["baseToolset"];

  if (selection === "read" || selection === "modify") keys.push("readToolset");

  if (selection === "modify") keys.push("modifyToolset");

  const warnings: string[] = [];

  const configured = Arr.flatMap(keys, (key) =>
    Arr.flatMap(toolsets[key], (pattern) => {
      const found = Arr.filter(ceiling, (name) => matchesPattern(pattern, name));

      if (found.length === 0) {
        warnings.push(`${key} pattern ${JSON.stringify(pattern)} matched none of your tools`);
      }

      return found;
    }),
  );

  return Result.succeed({ tools: Arr.dedupe([...configured, ...requested]), warnings });
};

/** The coordinator tools an agent gets: every one when it may spawn, otherwise only `agent_message`. */
export const coordinatorToolsFor = (canSpawn: boolean): ReadonlyArray<string> =>
  canSpawn ? COORDINATOR_TOOLS : ["agent_message"];
