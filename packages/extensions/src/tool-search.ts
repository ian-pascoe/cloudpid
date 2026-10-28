// @effect-diagnostics missingPipeableSignature:off -- plain functions.
// The `tool_search` extension (`docs/architecture/agent-capabilities.md` → Tool discovery): pi-durable's `tool_search` tool, and
// the rule that decides which tools it has to search. A tool the settings do not offer is deferred: absent from the
// model's tool list until `tool_search` loads it (loaded tools stay offered on that branch), while code mode scripts and
// other tools call it any time. The rule is a wrap on every other tool, so a tool of a later extension is deferred
// without being named in the settings. Wraps are pure, as pi-durable requires: the extension is built from one offered
// set, and the Session installs a new one over it (`reloadToolSearch`) when the settings it reads change, which
// pi-durable applies to the next phase it starts, never to one that is under way.
import {
  defineExtension,
  type Extension,
  section,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import {
  createToolSearchTool,
  TOOL_SEARCH_TOOL_NAME,
} from "@earendil-works/pi-durable/tool-search";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import { matchesPattern } from "./patterns.ts";

export const extensionName = "tool-search";

/** What the extension reads of the settings. */
export type ToolSearchOptions = {
  /** Names or patterns (`*` matches any run of characters) of the tools offered to the model without a search. */
  readonly offered: ReadonlyArray<string>;
};

/** The options the extension is first built from; the Session provides them over its settings. */
export class ToolSearchSettings extends Context.Service<
  ToolSearchSettings,
  { readonly current: () => ToolSearchOptions }
>()("@cloudpid/extensions/tool-search/ToolSearchSettings") {}

/** Settings that always offer `offered`: for tests and hosts without settings. */
export const fixedToolSearchSettings = (offered: ReadonlyArray<string>) =>
  Context.make(ToolSearchSettings, { current: () => ({ offered }) });

/**
 * The tools no setting defers. `tool_search` is the way to every other deferred tool; `context_rollover` is what
 * Rollover needs offered (the compaction hook prepares one only where it is), and a conversation without it silently
 * falls back to pi-durable's own compaction.
 */
export const ALWAYS_OFFERED: ReadonlyArray<string> = [TOOL_SEARCH_TOOL_NAME, "context_rollover"];

/** The most deferred tools the prompt names on one line; past it, they are named a family to a line. */
export const LISTED_ON_ONE_LINE = 40;

/** A tool's family: its name up to its first `_` (`environment_` of `environment_get`), or the name itself. */
const familyOf = (name: string): string => {
  const cut = name.indexOf("_");

  return cut === -1 ? name : name.slice(0, cut + 1);
};

/**
 * `names` (sorted) a family to a line, each family of two or more as `- <prefix>*: <names>`, and the tools alone in
 * theirs on a last line, so many deferred tools are named in full without one long line.
 */
const byFamily = (names: ReadonlyArray<string>): string => {
  const families = Arr.groupBy(names, familyOf);
  const lines: string[] = [];
  const alone: string[] = [];

  for (const family of Arr.sort(Record.keys(families), Order.String)) {
    const members = families[family] ?? [];

    if (members.length > 1) lines.push(`- ${family}*: ${Arr.join(members, ", ")}`);
    else alone.push(...members);
  }

  if (alone.length > 0) lines.push(`- others: ${Arr.join(alone, ", ")}`);

  return Arr.join(lines, "\n");
};

/** Whether the options offer tool `name`. */
export const isOffered = (options: ToolSearchOptions, name: string): boolean =>
  Arr.contains(ALWAYS_OFFERED, name) ||
  Arr.some(options.offered, (pattern) => matchesPattern(pattern, name));

/** `tool` with its `deferred` flag set as `defer` says. */
const withDeferral = (tool: ToolRegistration, defer: boolean): ToolRegistration => {
  if (defer) return tool.deferred === true ? tool : { ...tool, deferred: true };

  if (tool.deferred === undefined) return tool;

  const { deferred: _deferred, ...offered } = tool;

  return offered;
};

/**
 * What the model is told about deferred tools: every tool the settings defer, loaded or not (so the text changes only
 * when the settings or the extensions do, not at each load; the result of `tool_search` says what it loaded), on one
 * line, or a family to a line when there are many. Nothing for an agent that has no `tool_search`, which could not
 * load any of them.
 */
const deferredTools = section("deferred_tools", (input) => {
  const { agent } = input;

  if (!Arr.some(agent.tools, (tool) => tool.name === TOOL_SEARCH_TOOL_NAME)) return undefined;

  const names = Arr.sort(
    Arr.dedupe(
      Arr.map(
        Arr.filter([...agent.tools, ...agent.deferred], (tool) => tool.deferred === true),
        (tool) => tool.name,
      ),
    ),
    Order.String,
  );

  if (names.length === 0) return undefined;

  const lead = `Tools the settings defer: each is offered once you load it with \`${TOOL_SEARCH_TOOL_NAME}\` (code mode scripts call them without loading):`;

  return names.length <= LISTED_ON_ONE_LINE
    ? `${lead} ${Arr.join(names, ", ")}.`
    : `${lead}\n${byFamily(names)}`;
});

/**
 * `tool_search`, and the deferral of the tools named `toolNames`, those of every other extension (a tool not named
 * here is offered as it is registered), for the offered tools in `options`.
 */
export const toolSearchExtension = (
  toolNames: ReadonlyArray<string>,
  options: ToolSearchOptions,
): Extension =>
  defineExtension({
    name: extensionName,
    tools: [createToolSearchTool()],
    sections: [deferredTools],
    wraps: Arr.map(
      Arr.filter(Arr.dedupe(toolNames), (name) => !Arr.contains(ALWAYS_OFFERED, name)),
      (name) => ({
        tool: name,
        wrap: (tool: ToolRegistration) => withDeferral(tool, !isOffered(options, name)),
      }),
    ),
  });

/** The extension for the settings' offered tools as they are now. */
export const ToolSearch = (
  toolNames: ReadonlyArray<string>,
): Effect.Effect<Extension, never, ToolSearchSettings> =>
  Effect.map(ToolSearchSettings, (settings) => toolSearchExtension(toolNames, settings.current()));

/**
 * The extension for new `options`, over the tools of the `installed` extensions: install it over the earlier one (the
 * Harness replaces an extension of the same name in place).
 */
export const reloadToolSearch = (
  installed: ReadonlyArray<Extension>,
  options: ToolSearchOptions,
): Extension =>
  toolSearchExtension(
    Arr.flatMap(installed, (extension): ReadonlyArray<string> =>
      Arr.map(extension.tools ?? [], (tool) => tool.name),
    ),
    options,
  );
