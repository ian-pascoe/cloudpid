// The `settings_mcp` tools that change one key of a server (`docs/architecture/mcp-configuration.md` → The agent's changes →
// The tools, Scopes and layers, Approval, Records and revert, Results; `docs/architecture/agent-changes.md` → MCP server
// changes): `settings_mcp_enable`, `settings_mcp_disable`, `settings_mcp_exposure_set` and `settings_mcp_tool_exposure_set`,
// and `settings_reset` of an adjustment's key (`resetField`, which `./approval-tools.ts` calls).
//
// Each is one change of `mcp.servers.<name>.enabled|exposure|toolExposure` through `changeSettings` (`SettingsChanges`), recorded
// in `agent_changes` with the key's value as stored (null where the key is not written: the default) and, at an Environment,
// whether the key is inherited (an adjustment of Global's or a Repo's server, not written) or written. The layer is the
// Registry's to resolve (`settings-changes.ts`): at `*` the key inside Global's entry; at an Environment the key inside its own
// entry for its own server, else an adjustment, an Override even when equal to Global's.
//
// A change that would make a switched-off server or a hidden tool reachable in any Environment (`mcpChangeCheck`: the pure
// resolvers before and after, then `checkMcpWidening`) waits for the owner's Approval; one that narrows is made at once, the
// Registry checking again as it writes (`./settings-mcp-commit.ts`). After a change is applied the Session pushes the new set
// to the host of each Environment it reached (`pushMcpSet`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferSchemaOverJson:off
import {
  isMcpToolName,
  MCP_EXPOSURES,
  MCP_KEY_LABELS,
  type McpAdjustmentKey,
  type McpExposure,
  matchesToolPattern,
  mcpKeyField,
  mcpToolNames,
  mcpToolPrefix,
  overrideInherited,
  parseMcpField,
  resolveExposure,
  settingsFieldValue,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { AgentChange, McpFieldChange, SettingsMcpServer } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { MAX_CHANGE_REASON } from "./environment.ts";
import { ChangeOutput, outputSchema } from "./outputs.ts";
import { McpChangeOutput } from "./settings-mcp-outputs.ts";
import { readInventory } from "./settings-mcp-access.ts";
import {
  environmentWords,
  locate,
  type Located,
  type McpCall,
  McpCommit,
  NOTHING,
  type Prepared,
  refuse,
  toolNamesOf,
} from "./settings-mcp-commit.ts";
import { settingsChangeOutput } from "./settings-outputs.ts";
import {
  GLOBAL_SETTINGS_SCOPE,
  isGlobalView,
  SettingsAccessError,
  type SettingsFieldChange,
  SettingsScope,
  type SettingsView,
} from "./settings.ts";

export const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, for the user to read in the Settings' Agent changes, such as 'the server is not used by this project'",
});

export const ServerName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The server's name as settings_mcp_list shows it",
});

const ExposureValue = Schema.Literals(MCP_EXPOSURES).annotate({
  description:
    "codemode (the tools are called from a script, the default), deferred (found with tool_search), direct (offered to the model by name) or hidden (unreachable)",
});

/** Whether the key of this server is written in an entry (Global's at `*`, the Environment's own), not an adjustment. */
const inEntry = (scope: string, server: SettingsMcpServer): boolean =>
  scope === GLOBAL_SETTINGS_SCOPE || server.server.source.kind === "environment";

/**
 * The change that writes `value` at `key` of `server`, against what is stored now (`expected`: the value, and at an Environment
 * whether it is inherited). A value that is the default is not written in an entry, which drops the key instead.
 */
const keyChange = (input: {
  readonly view: SettingsView;
  readonly scope: string;
  readonly server: SettingsMcpServer;
  readonly key: McpAdjustmentKey;
  readonly value: Schema.Json;
  readonly isDefault: boolean;
}): SettingsFieldChange => {
  const field = mcpKeyField(input.server.server.name, input.key);
  const stored = settingsFieldValue(input.view.settings, field);

  const expected = isGlobalView(input.view)
    ? { value: stored }
    : { value: stored, inherited: overrideInherited(input.view.overrides, field) };

  return inEntry(input.scope, input.server) && input.isDefault
    ? { field, value: null, reset: true, expected }
    : { field, value: input.value, expected };
};

const asCheck = (change: SettingsFieldChange): McpFieldChange =>
  change.reset === true
    ? { field: change.field, value: null, reset: true }
    : { field: change.field, value: change.value };

type Entry = SettingsMcpServer["server"]["server"];

/** A key's value in force, as a result says it. */
const keyWords = (key: McpAdjustmentKey, entry: Entry): string => {
  switch (key) {
    case "enabled":
      return entry.enabled ? "on" : "off";
    case "exposure":
      return entry.exposure;
    case "toolExposure":
      return Record.isEmptyRecord(entry.toolExposure)
        ? "no keys"
        : Arr.join(
            Arr.map(Record.toEntries(entry.toolExposure), ([tool, how]) => `${tool} → ${how}`),
            ", ",
          );
  }
};

/** The `toolExposure` keys in order: the first pattern that matches wins. */
type ToolKeys = ReadonlyArray<readonly [string, McpExposure]>;

/**
 * `keys` with `tool` given `exposure` (null removes it): an existing key keeps its place unless `before` moves it, and a new
 * pattern goes last or ahead of `before`; an exact name beats every pattern, so it ignores `before`. Or why it cannot be.
 */
export const nextToolKeys = (
  keys: ToolKeys,
  tool: string,
  exposure: McpExposure | null,
  before: string | undefined,
): { readonly keys: ToolKeys } | { readonly problem: string } => {
  const has = (key: string) => Arr.some(keys, ([each]) => each === key);

  if (exposure === null) {
    return { keys: Arr.filter(keys, ([each]) => each !== tool) };
  }

  const ahead = tool.includes("*") ? before : undefined;

  if (ahead === undefined) {
    return has(tool)
      ? { keys: Arr.map(keys, ([each, was]) => [each, each === tool ? exposure : was] as const) }
      : { keys: [...keys, [tool, exposure] as const] };
  }

  if (ahead === tool) return { problem: `before names ${JSON.stringify(tool)} itself` };

  if (!has(ahead)) {
    return {
      problem: `before ${JSON.stringify(ahead)} is no key of toolExposure${
        keys.length === 0
          ? " (it has none)"
          : `: its keys are ${Arr.join(
              Arr.map(keys, ([each]) => JSON.stringify(each)),
              ", ",
            )}`
      }`,
    };
  }

  const rest = Arr.filter(keys, ([each]) => each !== tool);
  const at = rest.findIndex(([each]) => each === ahead);

  return { keys: [...rest.slice(0, at), [tool, exposure] as const, ...rest.slice(at)] };
};

const sameKeys = (left: ToolKeys, right: ToolKeys): boolean =>
  left.length === right.length &&
  Arr.every(left, ([key, how], index) => right[index]?.[0] === key && right[index]?.[1] === how);

/** Whether `decided` is the decision of the key `tool`. */
const decidedBy = (decided: ReturnType<typeof resolveExposure>, tool: string): boolean =>
  (decided.reason.kind === "tool" || decided.reason.kind === "pattern") &&
  decided.reason.key === tool;

/** What the result tells of the tools a `toolExposure` key decides, from the tools the host's inventory holds. */
const toolExposureWords = (input: {
  readonly server: string;
  readonly tool: string;
  readonly exposure: McpExposure | null;
  readonly before: ToolKeys;
  readonly after: ToolKeys;
  readonly serverExposure: McpExposure;
  readonly tools: ReadonlyArray<string> | null;
  readonly offered: ReadonlyArray<string>;
}): ReadonlyArray<string> => {
  const { tool, exposure, tools } = input;

  if (tools === null) {
    return [
      `Its tools are not checked: the server has not been discovered here, so it is not known which tools ${JSON.stringify(tool)} decides. settings_mcp_get lists them once it is.`,
    ];
  }

  const names = mcpToolNames(input.server, tools);

  const decisions = (keys: ToolKeys) =>
    Arr.map(tools, (name) => ({
      name,
      decided: resolveExposure({
        server: { exposure: input.serverExposure, toolExposure: Record.fromEntries(keys) },
        tool: name,
        modelName: names.get(name) ?? name,
        offered: input.offered,
      }),
    }));

  const offered = offeredNote(input.offered, input.server);

  if (exposure === null) {
    const decided = Arr.filter(decisions(input.before), (each) => decidedBy(each.decided, tool));

    return [
      decided.length === 0
        ? `The key decided none of the ${tools.length} known tools, so removing it changes none of them.`
        : `The key decided ${Arr.join(
            Arr.map(decided, (each) => each.name),
            ", ",
          )}, which now follow the next key that matches, or the server's exposure (${input.serverExposure}).`,
      ...offered,
    ];
  }

  const after = decisions(input.after);
  const decides = Arr.filter(after, (each) => decidedBy(each.decided, tool));

  const matching = Arr.filter(tools, (name) =>
    tool.includes("*") ? matchesToolPattern(tool, name) : tool === name,
  );

  if (matching.length === 0) {
    return [
      `The key is kept, but it matches none of the ${tools.length} tools the server has now${
        exposure === "hidden"
          ? ", so it hides nothing yet (a tool that appears under that name will be hidden)"
          : ""
      }.`,
      ...offered,
    ];
  }

  const lines = [
    `It decides ${
      decides.length === 0
        ? "none of the tools it matches"
        : Arr.join(
            Arr.map(decides, (each) => `${each.name} (${exposure})`),
            ", ",
          )
    }.`,
  ];

  const shadowed = Arr.filter(
    after,
    (each) => Arr.contains(matching, each.name) && !decidedBy(each.decided, tool),
  );

  const first = Arr.head(shadowed);

  if (Option.isSome(first)) {
    const reason = first.value.decided.reason;
    const key = reason.kind === "tool" || reason.kind === "pattern" ? reason.key : null;

    lines.push(
      `It is shadowed for ${Arr.join(
        Arr.map(shadowed, (each) => each.name),
        ", ",
      )}${
        key === null ? "" : `, which ${JSON.stringify(key)} decides first`
      }: the first key that matches wins, and an exact name beats a pattern.${
        key === null || !tool.includes("*")
          ? ""
          : ` To make this key win, call again with before: ${JSON.stringify(key)}, or give the exact tool name.`
      }`,
    );
  }

  return [...lines, ...offered];
};

/** The `tools.offered` patterns that lift one of `server`'s tools to direct, whatever the server's own exposure says. */
const offeredFor = (offered: ReadonlyArray<string>, server: string): ReadonlyArray<string> =>
  Arr.filter(
    offered,
    (pattern) =>
      pattern.startsWith(mcpToolPrefix(server)) ||
      (pattern.includes("*") && matchesToolPattern(pattern, `${mcpToolPrefix(server)}tool`)),
  );

/** The result's note on those patterns, or nothing when there are none. */
const offeredNote = (offered: ReadonlyArray<string>, server: string): ReadonlyArray<string> => {
  const lifting = offeredFor(offered, server);

  return lifting.length === 0
    ? []
    : [
        `tools.offered has ${Arr.join(lifting, ", ")}, which lifts a matching tool to direct whatever its exposure here is, never a hidden one.`,
      ];
};

/** The inherited state a change recorded, as a result says it. */
const inheritedWords = (change: AgentChange | undefined, side: "before" | "after"): string => {
  if (change === undefined) return "";

  const inherited = side === "before" ? change.beforeInherited : change.afterInherited;

  if (inherited === undefined) return "";

  return inherited ? " (inherited)" : " (set here)";
};

/** The result of a call that found the field as it was asked to be: nothing is saved, recorded or pushed. */
export const unchanged = (view: SettingsView, field: string, text: string) => ({
  output: [{ type: "text" as const, text }],
  structuredOutput: settingsChangeOutput({
    view,
    changes: [],
    unchanged: [field],
    approval: null,
  }),
  details: { scope: view.scope, unchanged: [field], agentChanges: [] },
});

/**
 * The tools that change one key of a server, over the shared ending of the changing tools (`McpCommit`): the Registry's reads
 * and check, the hosts' inventories and pushes, the Approvals, and the Settings' change machinery.
 */
export const McpChanges = Effect.gen(function* () {
  const engine = yield* McpCommit;
  const { access, settings } = engine;

  const where = (view: SettingsView): string =>
    isGlobalView(view)
      ? "at Global"
      : `for Environment ${JSON.stringify(view.name)} (${view.scope})`;

  /**
   * One change of `key` of the server at `scope`, against the Registry's check: asked when it widens, otherwise recorded and
   * pushed at once, and worded (a lead, what the key was and is, where it reaches and when).
   */
  const change = (input: {
    readonly tool: string;
    readonly api: McpCall;
    readonly scope: string;
    readonly located: Located;
    readonly key: McpAdjustmentKey;
    readonly view: SettingsView;
    readonly field: SettingsFieldChange;
    readonly reason: string;
    /** The card's change: `switch on`, `exposure`, `tool exposure`, `reset`. */
    readonly card: string;
    readonly lead: string;
    readonly texts?: ReadonlyArray<string>;
    readonly extra?: ReadonlyArray<string>;
    /** Wait for the server's status afterwards (the server was switched on). */
    readonly status?: boolean;
  }): Effect.Effect<Prepared<ReturnType<typeof unchanged>>, SettingsAccessError> =>
    Effect.gen(function* () {
      const name = input.located.server.server.name;

      const check = yield* access.check({
        scope: input.scope,
        name,
        changes: [asCheck(input.field)],
      });

      const notes = yield* engine.reachNotes({
        scope: input.scope,
        name,
        check,
        view: input.located.view,
      });

      const was = input.located.server;

      return {
        kind: "commit",
        input: {
          tool: input.tool,
          api: input.api,
          scope: input.scope,
          view: input.view,
          name,
          field: input.field,
          check,
          reason: input.reason,
          texts: input.texts ?? [],
          always: false,
          rerun: false,
          card: {
            change: `MCP server ${JSON.stringify(name)}: ${input.card}`,
            before: settingsFieldValue(input.view.settings, input.field.field),
            notes,
          },
          was,
          wording: (now, recorded) => [
            input.lead,
            `- MCP server ${name} · ${MCP_KEY_LABELS[input.key]}: it was ${keyWords(input.key, was.server.server)}${inheritedWords(recorded, "before")}, and is ${
              now === undefined ? "unknown" : keyWords(input.key, now.server.server)
            }${inheritedWords(recorded, "after")} now.`,
          ],
          extra: input.extra ?? [],
          alreadySo: `Nothing changed: ${input.field.field} has that value already.`,
          status: input.status ?? false,
          declined: `${input.card} of MCP server ${name} ${where(input.view)}`,
        },
      };
    });

  /** The call a key's tool makes: its preparation, and what a rerun resumes from. */
  const call = <D>(input: {
    readonly tool: string;
    readonly api: McpCall;
    readonly scope: string;
    readonly name: string;
    readonly key: McpAdjustmentKey;
    readonly reason: string;
    readonly texts?: ReadonlyArray<string>;
    readonly status: boolean;
    readonly prepare: (rerun: boolean) => Effect.Effect<Prepared<D>, SettingsAccessError>;
  }) =>
    Effect.gen(function* () {
      const rerun = yield* engine.rerun(input.api);

      return yield* engine.run({
        rerun,
        prepare: input.prepare(rerun),
        resume: engine.resumeOf({
          tool: input.tool,
          api: input.api,
          scope: input.scope,
          name: input.name,
          field: mcpKeyField(input.name, input.key),
          reason: input.reason,
          texts: input.texts ?? [],
          status: input.status,
        }),
      });
    });

  const disable = (input: {
    readonly scope: string;
    readonly name: string;
    readonly reason: string;
    readonly api: McpCall;
  }) =>
    Effect.gen(function* () {
      yield* engine.plain(input.reason, []);

      return yield* call({
        tool: "settings_mcp_disable",
        api: input.api,
        scope: input.scope,
        name: input.name,
        key: "enabled",
        reason: input.reason,
        status: false,
        prepare: () =>
          Effect.gen(function* () {
            const located = yield* locate(access, input.scope, input.name);
            const view = yield* settings.get(input.scope);

            if (!located.server.server.server.enabled) {
              return {
                kind: "done",
                result: unchanged(
                  view,
                  mcpKeyField(input.name, "enabled"),
                  `MCP server ${input.name} is switched off ${where(view)} already: nothing was changed or recorded.`,
                ),
              } as const;
            }

            return yield* change({
              tool: "settings_mcp_disable",
              api: input.api,
              scope: input.scope,
              located,
              key: "enabled",
              view,
              field: keyChange({
                view,
                scope: input.scope,
                server: located.server,
                key: "enabled",
                value: false,
                isDefault: false,
              }),
              reason: input.reason,
              card: "switch off",
              lead: `Switched off MCP server ${input.name} ${where(view)}. Its connection is closed and its tools are no longer registered; its inventory is kept, and the user switches it on again.`,
            });
          }),
      });
    });

  const enable = (input: {
    readonly scope: string;
    readonly name: string;
    readonly reason: string;
    readonly api: McpCall;
  }) =>
    Effect.gen(function* () {
      yield* engine.plain(input.reason, []);

      return yield* call({
        tool: "settings_mcp_enable",
        api: input.api,
        scope: input.scope,
        name: input.name,
        key: "enabled",
        reason: input.reason,
        status: true,
        prepare: (rerun) =>
          Effect.gen(function* () {
            const located = yield* locate(access, input.scope, input.name);
            const view = yield* settings.get(input.scope);

            if (located.server.server.server.enabled && !rerun) {
              return {
                kind: "done",
                result: unchanged(
                  view,
                  mcpKeyField(input.name, "enabled"),
                  `MCP server ${input.name} is switched on ${where(view)} already: nothing was changed or recorded.`,
                ),
              } as const;
            }

            return yield* change({
              tool: "settings_mcp_enable",
              api: input.api,
              scope: input.scope,
              located,
              key: "enabled",
              view,
              field: keyChange({
                view,
                scope: input.scope,
                server: located.server,
                key: "enabled",
                value: true,
                isDefault: true,
              }),
              reason: input.reason,
              card: "switch on",
              lead: `Switched on MCP server ${input.name} ${where(view)}. It connects at the next demand, and its tools are registered once discovered.`,
              status: true,
            });
          }),
      });
    });

  const exposureSet = (input: {
    readonly scope: string;
    readonly name: string;
    readonly exposure: McpExposure;
    readonly reason: string;
    readonly api: McpCall;
  }) =>
    Effect.gen(function* () {
      yield* engine.plain(input.reason, []);

      return yield* call({
        tool: "settings_mcp_exposure_set",
        api: input.api,
        scope: input.scope,
        name: input.name,
        key: "exposure",
        reason: input.reason,
        status: false,
        prepare: (rerun) =>
          Effect.gen(function* () {
            const located = yield* locate(access, input.scope, input.name);
            const view = yield* settings.get(input.scope);
            const entry = located.server.server.server;

            if (entry.exposure === input.exposure && !rerun) {
              return {
                kind: "done",
                result: unchanged(
                  view,
                  mcpKeyField(input.name, "exposure"),
                  `MCP server ${input.name} has the exposure ${input.exposure} ${where(view)} already: nothing was changed or recorded.`,
                ),
              } as const;
            }

            return yield* change({
              tool: "settings_mcp_exposure_set",
              api: input.api,
              scope: input.scope,
              located,
              key: "exposure",
              view,
              field: keyChange({
                view,
                scope: input.scope,
                server: located.server,
                key: "exposure",
                value: input.exposure,
                isDefault: input.exposure === "codemode",
              }),
              reason: input.reason,
              card: "exposure",
              lead: `Set the exposure of MCP server ${input.name} to ${input.exposure} ${where(view)}. A tool named in the server's toolExposure keeps its own exposure.`,
              extra: offeredNote(located.view.offered, input.name),
            });
          }),
      });
    });

  const toolExposureSet = (input: {
    readonly scope: string;
    readonly name: string;
    readonly tool: string;
    readonly exposure: McpExposure | null;
    readonly before: string | undefined;
    readonly reason: string;
    readonly api: McpCall;
  }) =>
    Effect.gen(function* () {
      yield* engine.plain(input.reason, [
        input.tool,
        ...(input.before === undefined ? [] : [input.before]),
      ]);

      return yield* call({
        tool: "settings_mcp_tool_exposure_set",
        api: input.api,
        scope: input.scope,
        name: input.name,
        key: "toolExposure",
        reason: input.reason,
        texts: [input.tool],
        status: false,
        prepare: (rerun) =>
          Effect.gen(function* () {
            const located = yield* locate(access, input.scope, input.name);
            const view = yield* settings.get(input.scope);
            const entry = located.server.server.server;
            const server = located.server.server.name;

            const inventory = yield* readInventory(access, {
              view: located.view,
              names: [server],
              parts: ["tools"],
            });

            const tools = toolNamesOf(inventory, server);
            let tool = input.tool;

            if (isMcpToolName(tool)) {
              if (tools === null) {
                return yield* refuse(
                  `${NOTHING}${JSON.stringify(tool)} is a model-facing name, which is mapped back through the server's discovered tools, and ${
                    input.scope === GLOBAL_SETTINGS_SCOPE
                      ? "Global has no host to ask: give the tool's own name as the server calls it, or a pattern with *"
                      : "this server's tools are not discovered here yet: give the tool's own name as the server calls it, or a pattern with *"
                  }.`,
                );
              }

              const names = mcpToolNames(server, tools);
              const own = Arr.findFirst(tools, (each) => names.get(each) === tool);

              if (Option.isNone(own)) {
                return yield* refuse(
                  `${NOTHING}${JSON.stringify(tool)} is the model-facing name of none of ${server}'s ${tools.length} discovered tools. settings_mcp_get lists them with their names.`,
                );
              }

              tool = own.value;
            }

            const before: ToolKeys = Record.toEntries(entry.toolExposure);
            const next = nextToolKeys(before, tool, input.exposure, input.before);

            if ("problem" in next) return yield* refuse(`${NOTHING}${next.problem}.`);

            const field = mcpKeyField(input.name, "toolExposure");

            if (sameKeys(before, next.keys) && !rerun) {
              return {
                kind: "done",
                result: unchanged(
                  view,
                  field,
                  input.exposure === null
                    ? `MCP server ${input.name} has no toolExposure key ${JSON.stringify(tool)} ${where(view)}: nothing was changed or recorded.`
                    : `MCP server ${input.name} has the toolExposure key ${JSON.stringify(tool)} → ${input.exposure} ${where(view)} already, in that place: nothing was changed or recorded.`,
                ),
              } as const;
            }

            const written = Record.fromEntries(next.keys);

            return yield* change({
              tool: "settings_mcp_tool_exposure_set",
              api: input.api,
              scope: input.scope,
              located,
              key: "toolExposure",
              view,
              field: keyChange({
                view,
                scope: input.scope,
                server: located.server,
                key: "toolExposure",
                value: written,
                isDefault: next.keys.length === 0,
              }),
              reason: input.reason,
              card: "tool exposure",
              texts: [tool],
              lead:
                input.exposure === null
                  ? `Removed the toolExposure key ${JSON.stringify(tool)} of MCP server ${input.name} ${where(view)}.`
                  : `Set the toolExposure key ${JSON.stringify(tool)} of MCP server ${input.name} to ${input.exposure} ${where(view)}.`,
              extra: toolExposureWords({
                server,
                tool,
                exposure: input.exposure,
                before,
                after: next.keys,
                serverExposure: entry.exposure,
                tools,
                offered: located.view.offered,
              }),
            });
          }),
      });
    });

  /**
   * `settings_reset` of `field`, one of an MCP server's `enabled`, `exposure` and `toolExposure` or the entry itself
   * (`mcp.servers.<name>[.key]`): only at an Environment and only an adjustment's key, as an Override of Global's or a Repo's
   * server is removed. The entry, anything at `*` and a key of the Environment's own entry are refused, naming the tool for each.
   * A reset that falls back to a switched-off server or a hidden tool waits for the owner's Approval.
   */
  const resetField = (input: {
    readonly scope: string;
    readonly field: string;
    readonly reason: string;
    readonly api: McpCall;
  }) =>
    Effect.gen(function* () {
      const parsed = parseMcpField(input.field);

      if (parsed === null || parsed.key === null) {
        return yield* refuse(
          `Nothing was asked or saved: settings_reset does not take a whole MCP server (${input.field}). settings_mcp_remove removes an Environment's own server (at Global, Global's).`,
        );
      }

      if (input.scope === GLOBAL_SETTINGS_SCOPE) {
        return yield* refuse(
          `Nothing was asked or saved: settings_reset takes no MCP field at "*" (${input.field}): Global holds the servers' own entries, with no lower layer to fall back to. Use settings_mcp_enable, settings_mcp_disable and the exposure tools to change a key.`,
        );
      }

      const { key, name } = parsed;

      yield* engine.plain(input.reason, []);

      return yield* call({
        tool: "settings_reset",
        api: input.api,
        scope: input.scope,
        name,
        key,
        reason: input.reason,
        status: false,
        prepare: (rerun) =>
          Effect.gen(function* () {
            const view = yield* settings.get(input.scope);

            if (isGlobalView(view)) return yield* refuse("An Environment's id is needed.");

            const found = yield* access.view({ scope: input.scope, name });
            const server = Arr.head(found.servers);

            // A key inside the Environment's own full entry is no adjustment: the entry is the server's, with no lower layer.
            if (Option.isSome(server) && server.value.server.source.kind === "environment") {
              return yield* refuse(
                `Nothing was asked or saved: ${input.field} is a key of ${view.name}'s own entry for ${name}, not an adjustment, so there is nothing to reset it to. Use settings_mcp_enable, settings_mcp_disable or the exposure tools to change it.`,
              );
            }

            if (overrideInherited(view.overrides, input.field) && !rerun) {
              return {
                kind: "done",
                result: unchanged(
                  view,
                  input.field,
                  `${environmentWords({ id: view.scope, name: view.name })} holds no adjustment of ${name}'s ${key}: it inherits already, so nothing was asked, changed or recorded.`,
                ),
              } as const;
            }

            const field: SettingsFieldChange = {
              field: input.field,
              value: null,
              reset: true,
              expected: {
                value: settingsFieldValue(view.settings, input.field),
                inherited: false,
              },
            };

            const check = yield* access.check({
              scope: input.scope,
              name,
              changes: [asCheck(field)],
            });

            const notes = yield* engine.reachNotes({
              scope: input.scope,
              name,
              check,
              view: found,
            });

            return {
              kind: "commit",
              input: {
                tool: "settings_reset",
                api: input.api,
                scope: input.scope,
                view,
                name,
                field,
                check,
                reason: input.reason,
                texts: [],
                always: false,
                rerun: false,
                card: {
                  change: `MCP server ${JSON.stringify(name)}: reset ${MCP_KEY_LABELS[key]}`,
                  before: settingsFieldValue(view.settings, input.field),
                  notes,
                },
                was: Option.getOrUndefined(server),
                wording: (now, recorded) => [
                  `Reset the ${MCP_KEY_LABELS[key]} of MCP server ${name} ${where(view)}: its adjustment is removed, so the key follows the server's own layer again.`,
                  Option.isSome(server)
                    ? `- MCP server ${name} · ${MCP_KEY_LABELS[key]}: it was ${keyWords(key, server.value.server.server)}${inheritedWords(recorded, "before")}, and is ${
                        now === undefined ? "unknown" : keyWords(key, now.server.server)
                      }${inheritedWords(recorded, "after")} now.`
                    : `- The adjustment of ${name} had no server to adjust: it is gone.`,
                ],
                extra: [],
                alreadySo: `${input.field} inherits already: nothing changed.`,
                status: false,
                declined: `reset ${MCP_KEY_LABELS[key]} of MCP server ${name} ${where(view)}`,
              },
            } as const;
          }),
      });
    });

  return { disable, enable, exposureSet, toolExposureSet, resetField, engine };
});

const CHANGE_NOTE =
  "The change is recorded with your reason, and the user can see and revert it on the Settings page. A change that would make something reachable that is not (switch a server on, take it or a tool out of hidden, loosen or remove a hidden toolExposure key, put another key ahead of one) waits for the user's Approval: the call waits for their answer on a card in the Session, with no deadline, and a decline changes nothing; one that narrows (switching off, hiding, moves among codemode, deferred and direct) is made at once. A name is the server in force in that Scope's set. At scope \"*\" the key is changed in Global's entry, which reaches every Environment but those whose own entry or adjustment overrides it (the result names them); at an Environment's id the change is that Environment's own, an Override even when it equals Global's (settings_reset removes it). The new set is handed to the MCP hosts the change reaches.";

/** The four tools that change one key, over `McpChanges`. */
export const McpChangeTools = Effect.gen(function* () {
  const changes = yield* McpChanges;

  const disable = yield* defineEffectTool({
    name: "settings_mcp_disable",
    description: `Switch an MCP server off at one Scope: its connection and streams are closed and its tools are no longer reachable (its inventory is kept). ${CHANGE_NOTE} Switching a server on again waits for the user's Approval. A Repo's .pi/mcp.json is edited as a file, in a pull request, and is no Agent change; its servers run without Approval but get no Secrets (copy one with settings_mcp_add and from_repo to give it some).`,
    parameters: Schema.Struct({ scope: SettingsScope, name: ServerName, reason: Reason }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    // A rerun after an eviction would record the change again, against the value it set.
    replay: "unsafe",
    execute: ({ scope, name, reason }, api) => changes.disable({ scope, name, reason, api }),
  });

  const enable = yield* defineEffectTool({
    name: "settings_mcp_enable",
    description: `Switch an MCP server on at one Scope. Switching a server on waits for the user's Approval (a card in the Session; the call waits for their answer with no deadline; a decline changes nothing, and the result carries their reason). Once made, the result says the server's status (connected with how many tools, needs sign-in, failed with the error, or still connecting), waiting up to 10 s, only when the change reaches this Session's Environment; a stdio server is discovered only in this Workspace's Container while it runs, so its status says "not discovered" until its first call starts the Container, and no other Environment's server is checked. ${CHANGE_NOTE}`,
    parameters: Schema.Struct({ scope: SettingsScope, name: ServerName, reason: Reason }),
    structuredOutputSchema: outputSchema(McpChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ scope, name, reason }, api) => changes.enable({ scope, name, reason, api }),
  });

  const exposureSet = yield* defineEffectTool({
    name: "settings_mcp_exposure_set",
    description: `Set how an MCP server's tools reach the model, at one Scope: codemode (called from a script; the default), deferred (found with tool_search), direct (offered by name) or hidden (unreachable). A tool the server's toolExposure names keeps its own exposure. ${CHANGE_NOTE} Taking a server out of hidden waits for the user's Approval.`,
    parameters: Schema.Struct({
      scope: SettingsScope,
      name: ServerName,
      exposure: ExposureValue,
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ scope, name, exposure, reason }, api) =>
      changes.exposureSet({ scope, name, exposure, reason, api }),
  });

  const toolExposureSet = yield* defineEffectTool({
    name: "settings_mcp_tool_exposure_set",
    description: `Set, move or remove one key of an MCP server's toolExposure at one Scope. tool is the server's own tool name (as settings_mcp_get lists it), a pattern with * , or a model-facing mcp__<server>__<tool> name, which is mapped back through the server's discovered tools. exposure is codemode, deferred, direct or hidden; null removes the key. The first key that matches a tool wins and an exact name beats a pattern: a new pattern goes last, an existing key keeps its place, and before names an existing pattern key to put this one ahead of (an exact name ignores it). The result says which known tools the key decides and which it is shadowed for, with the fix; a key that matches no tool is kept with a warning, and for a server not discovered here its tools are not checked. ${CHANGE_NOTE} Hiding is made at once; removing or loosening a hidden key, or putting another key ahead of one, waits for the user's Approval.`,
    parameters: Schema.Struct({
      scope: SettingsScope,
      name: ServerName,
      tool: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "The tool's own name, a pattern with *, or its mcp__<server>__<tool> name",
      }),
      exposure: Schema.NullOr(ExposureValue).annotate({
        description: "The exposure of the tool, or null to remove the key",
      }),
      before: Schema.optionalKey(Schema.String).annotate({
        description: "An existing pattern key to put this key ahead of",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ scope, name, tool, exposure, before, reason }, api) =>
      changes.toolExposureSet({ scope, name, tool, exposure, before, reason, api }),
  });

  return [disable, enable, exposureSet, toolExposureSet] as const;
});
