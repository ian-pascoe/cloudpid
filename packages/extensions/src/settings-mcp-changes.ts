// The `settings_mcp` tools that change servers without the owner's Approval (`docs/architecture/mcp-configuration.md` → The
// agent's changes → The tools, Scopes and layers, Records and revert, Results; `docs/architecture/agent-changes.md` → MCP server
// changes): `settings_mcp_disable`, the narrowing `settings_mcp_exposure_set` and `settings_mcp_tool_exposure_set`, and
// `settings_reset` of an adjustment's key (`resetField`, which `./approval-tools.ts` calls).
//
// Each is one change of `mcp.servers.<name>.enabled|exposure|toolExposure` through `changeSettings` (`SettingsChanges`), recorded
// in `agent_changes` with the key's value as stored (null where the key is not written: the default) and, at an Environment,
// whether the key is inherited (an adjustment of Global's or a Repo's server, not written) or written. The layer is the
// Registry's to resolve (`settings-changes.ts`): at `*` the key inside Global's entry; at an Environment the key inside its own
// entry for its own server, else an adjustment, an Override even when equal to Global's.
//
// A change that would make a switched-off server or a hidden tool reachable in any Environment (`mcpChangeCheck`: the pure
// resolvers before and after, then `checkMcpWidening`) is refused here, asking nobody: such a change needs the owner's Approval,
// which is the next ticket's. `refuseWidening` is the one place that decision is made. After a change is applied the Session
// pushes the new set to the host of each Environment it reached (`pushMcpSet`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferSchemaOverJson:off -- builders over plain values.
import {
  isMcpToolName,
  MCP_EXPOSURES,
  type McpExposure,
  type McpWidening,
  matchesToolPattern,
  mcpToolNames,
  mcpToolPrefix,
  overrideInherited,
  resolveExposure,
  settingsFieldValue,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import type {
  AgentChange,
  SettingsMcpChangeCheck,
  SettingsMcpServer,
  SettingsMcpView,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { MAX_CHANGE_REASON } from "./environment.ts";
import { ChangeOutput, outputSchema } from "./outputs.ts";
import {
  type McpFieldChange,
  pushMcpSet,
  readInventory,
  SettingsMcpAccess,
  type SettingsMcpAccessService,
} from "./settings-mcp-access.ts";
import { settingsChangeOutput } from "./settings-outputs.ts";
import {
  GLOBAL_SETTINGS_SCOPE,
  isGlobalView,
  SettingsAccess,
  SettingsAccessError,
  SettingsChanges,
  type SettingsFieldChange,
  SettingsScope,
  type SettingsView,
} from "./settings.ts";

const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, for the user to read in the Settings' Agent changes, such as 'the server is not used by this project'",
});

const ServerName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The server's name as settings_mcp_list shows it",
});

const ExposureValue = Schema.Literals(MCP_EXPOSURES).annotate({
  description:
    "codemode (the tools are called from a script, the default), deferred (found with tool_search), direct (offered to the model by name) or hidden (unreachable)",
});

/** The keys of a server that are changed here: those an adjustment may hold. */
type Key = "enabled" | "exposure" | "toolExposure";

const KEYS: ReadonlyArray<Key> = ["enabled", "exposure", "toolExposure"];

const fieldOf = (name: string, key: Key): string => `mcp.servers.${name}.${key}`;

const refuse = (message: string) => SettingsAccessError.make({ message });

/** How every refusal begins. */
const NOTHING = "Nothing was changed: ";

const wideningWords = (widening: McpWidening): string => {
  switch (widening.kind) {
    case "switched_on":
      return "it switches the server on";
    case "exposure_unhidden":
      return "it takes the server out of hidden";
    case "key_removed":
      return `it removes the hidden toolExposure key ${JSON.stringify(widening.key)}`;
    case "key_loosened":
      return `it loosens the hidden toolExposure key ${JSON.stringify(widening.key)} to ${widening.exposure}`;
    case "key_ahead":
      return `it puts the toolExposure key ${JSON.stringify(widening.key)} ahead of ${
        widening.over === null
          ? "the server's own hidden exposure"
          : `the hidden key ${JSON.stringify(widening.over)}`
      }`;
  }
};

const environmentWords = (environment: { readonly id: string; readonly name: string }): string =>
  `Environment ${JSON.stringify(environment.name)} (${environment.id})`;

const listed = (environments: ReadonlyArray<{ readonly id: string; readonly name: string }>) =>
  Arr.join(Arr.map(environments, environmentWords), ", ");

/**
 * The one place these tools decide about widening: a change that makes a switched-off server or a hidden tool reachable in
 * some Environment is refused, asking nobody, since it needs the owner's Approval and these tools do not ask for it yet.
 */
export const refuseWidening = (
  check: SettingsMcpChangeCheck,
  what: string,
): Effect.Effect<void, SettingsAccessError> => {
  const widened = Arr.filter(check.environments, (each) => each.widening.length > 0);

  if (widened.length === 0) return Effect.void;

  const why = Arr.join(
    Arr.map(
      widened,
      (each) =>
        `In ${environmentWords(each.environment)}: ${Arr.join(Arr.map(each.widening, wideningWords), "; ")}.`,
    ),
    " ",
  );

  return refuse(
    `${NOTHING}${what} would make something reachable that is switched off or hidden, which needs the user's Approval, and these tools cannot ask for it yet. ${why} Only changes that narrow what is reachable are made here: switching a server off, hiding it or a tool, and moves among codemode, deferred and direct. Ask the user to make this change on the Settings page.`,
  );
};

/** The server as `scope`'s set has it. */
type Located = { readonly view: SettingsMcpView; readonly server: SettingsMcpServer };

const namesWords = (view: SettingsMcpView): string =>
  view.names.length === 0 ? " It has none." : ` Its servers: ${Arr.join(view.names, ", ")}.`;

/**
 * The server `name` in force in `scope`'s set, or why there is none to change (`docs/architecture/mcp-configuration.md` →
 * Scopes and layers): a name only Environments define, an orphaned adjustment, or no such server.
 */
const locate = (access: SettingsMcpAccessService, scope: string, name: string) =>
  Effect.gen(function* () {
    const view = yield* access.view({ scope, name });
    const found = Arr.head(view.servers);

    if (Option.isSome(found)) return { view, server: found.value } satisfies Located;

    if (scope === GLOBAL_SETTINGS_SCOPE) {
      const elsewhere = view.definedIn ?? [];

      return yield* refuse(
        elsewhere.length > 0
          ? `${NOTHING}${JSON.stringify(name)} is not one of Global's servers: it is defined in ${listed(elsewhere)} (an Environment's own entry or a Repo's .pi/mcp.json), so there is nothing to change at "*". Give the id of one of them as scope to change it there, or copy it.`
          : `${NOTHING}No MCP server ${JSON.stringify(name)} in Global's entries.${namesWords(view)}`,
      );
    }

    const orphan = Arr.findFirst(view.orphans, (each) => each.name === name);

    if (Option.isSome(orphan)) {
      const fields = Arr.join(
        Arr.map(orphan.value.keys, (key) => `mcp.servers.${name}.${key}`),
        ", ",
      );

      return yield* refuse(
        `${NOTHING}${JSON.stringify(name)} is no server in ${view.name}'s set: it holds an adjustment (${Arr.join(orphan.value.keys, ", ")}) of a server that no layer below defines any more. Remove it with settings_reset of ${fields}.`,
      );
    }

    return yield* refuse(
      `${NOTHING}No MCP server ${JSON.stringify(name)} in ${view.name}'s set.${namesWords(view)}`,
    );
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
  readonly key: Key;
  readonly value: Schema.Json;
  readonly isDefault: boolean;
}): SettingsFieldChange => {
  const field = fieldOf(input.server.server.name, input.key);
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
const keyWords = (key: Key, entry: Entry): string => {
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

const KEY_LABELS: Readonly<Record<Key, string>> = {
  enabled: "on/off",
  exposure: "exposure",
  toolExposure: "tool exposure",
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

/** The tools of a server the host's inventory holds, by the server's own names; null where none was read. */
const toolNamesOf = (
  inventory: Effect.Success<ReturnType<typeof readInventory>>,
  server: string,
): ReadonlyArray<string> | null => {
  const row = inventory.byName.get(server);

  if (row === undefined) return null;

  return Arr.filterMap(row.tools ?? [], (tool) =>
    Predicate.hasProperty(tool, "name") && Predicate.isString(tool.name)
      ? Result.succeed(tool.name)
      : Result.failVoid,
  );
};

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

  const lifted = Arr.filter(
    input.offered,
    (pattern) =>
      pattern.startsWith(mcpToolPrefix(input.server)) ||
      (pattern.includes("*") && matchesToolPattern(pattern, `${mcpToolPrefix(input.server)}tool`)),
  );

  const offeredNote =
    lifted.length === 0
      ? []
      : [
          `tools.offered has ${Arr.join(lifted, ", ")}, which lifts a matching tool to direct whatever its Exposure here is, never a hidden one.`,
        ];

  if (exposure === null) {
    const decided = Arr.filter(decisions(input.before), (each) => decidedBy(each.decided, tool));

    return [
      decided.length === 0
        ? `The key decided none of the ${tools.length} known tools, so removing it changes none of them.`
        : `The key decided ${Arr.join(
            Arr.map(decided, (each) => each.name),
            ", ",
          )}, which now follow the next key that matches, or the server's exposure (${input.serverExposure}).`,
      ...offeredNote,
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
      ...offeredNote,
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

  return [...lines, ...offeredNote];
};

/** The inherited state a change recorded, as a result says it. */
const inheritedWords = (change: AgentChange | undefined, side: "before" | "after"): string => {
  if (change === undefined) return "";

  const inherited = side === "before" ? change.beforeInherited : change.afterInherited;

  if (inherited === undefined) return "";

  return inherited ? " (inherited)" : " (set here)";
};

/**
 * The changing tools over the Session's `SettingsMcpAccess` (the Registry's reads and check, the hosts' inventories and
 * pushes) and the Settings' change machinery (`SettingsChanges`).
 */
export const McpChanges = Effect.gen(function* () {
  const access = yield* SettingsMcpAccess;
  const settings = yield* SettingsAccess;
  const { apply } = yield* SettingsChanges;

  const where = (view: SettingsView): string =>
    isGlobalView(view)
      ? "at Global"
      : `for Environment ${JSON.stringify(view.name)} (${view.scope})`;

  /** The result of a call that found the key as it was asked to be: nothing is saved, recorded or pushed. */
  const unchanged = (view: SettingsView, field: string, text: string) => ({
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
   * The words after a change was applied: what changed (the key in force before and now), which Environments it reaches and
   * whether this Session is one of them, the push of the new set to each of their hosts, and when it applies.
   */
  const afterApplied = (input: {
    readonly scope: string;
    readonly name: string;
    readonly key: Key;
    readonly was: SettingsMcpServer;
    readonly check: SettingsMcpChangeCheck;
    readonly changes: ReadonlyArray<AgentChange>;
    readonly lead: string;
    readonly extra: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const reached = Arr.map(
        Arr.filter(input.check.environments, (each) => each.reached),
        (each) => each.environment,
      );

      const missed = Arr.map(
        Arr.filter(input.check.environments, (each) => !each.reached),
        (each) => each.environment,
      );

      const unsent: Array<string> = [];

      for (const environment of reached) {
        const made = yield* pushMcpSet(access, environment.id);

        if (made === "failed") unsent.push(environment.name);
      }

      const now = yield* access.view({ scope: input.scope, name: input.name }).pipe(
        Effect.map((view) => Option.getOrUndefined(Arr.head(view.servers))),
        Effect.orElseSucceed(() => undefined),
      );

      const own = yield* access.own.pipe(Effect.orElseSucceed(() => null));
      const reachesOwn = own !== null && Arr.some(reached, (each) => each.id === own);
      const change = Arr.head(input.changes);

      const after = now === undefined ? "unknown" : keyWords(input.key, now.server.server);

      const reach =
        input.scope === GLOBAL_SETTINGS_SCOPE
          ? `It reaches ${reached.length === 0 ? "no Environment" : listed(reached)}${
              missed.length === 0
                ? ""
                : `; not ${listed(missed)}, where an entry or an adjustment of its own overrides it`
            }.`
          : `It reaches ${listed(reached)}.`;

      return Arr.join(
        [
          input.lead,
          `- MCP server ${input.name} · ${KEY_LABELS[input.key]}: it was ${keyWords(input.key, input.was.server.server)}${inheritedWords(Option.getOrUndefined(change), "before")}, and is ${after}${inheritedWords(Option.getOrUndefined(change), "after")} now.`,
          reach,
          reachesOwn
            ? "This Session's Environment is one of them: the server's tools follow from this Session's next request once discovered (the mcp_servers section of the system prompt stays as it is for this Context Window, and a notice says so); other Sessions get it at their next request."
            : "This Session's Environment is not one of them, so the change does not reach this Session; the Sessions of the Environments it reaches get it at their next request.",
          unsent.length === 0
            ? reached.length === 0
              ? "No MCP host was sent anything."
              : "The new set was handed to the MCP host of each Environment it reaches (one that never had a server and has none is not woken)."
            : `The new set could not be handed to the MCP host of ${Arr.join(unsent, ", ")} now: it takes it at its next pull.`,
          ...input.extra,
          "The change is recorded with your reason; the user can see and revert it on the Settings page.",
        ],
        "\n",
      );
    });

  /** One change of `key` against the Registry's check (a widening is refused first), recorded, pushed and worded. */
  const change = (input: {
    readonly tool: string;
    readonly scope: string;
    readonly located: Located;
    readonly key: Key;
    readonly view: SettingsView;
    readonly field: SettingsFieldChange;
    readonly reason: string;
    readonly conversation: number;
    readonly lead: string;
    readonly texts?: ReadonlyArray<string>;
    readonly extra?: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const name = input.located.server.server.name;

      const check = yield* access.check({
        scope: input.scope,
        name,
        changes: [asCheck(input.field)],
      });

      yield* refuseWidening(check, `this change to ${JSON.stringify(name)}`);

      return yield* apply({
        tool: input.tool,
        view: input.view,
        fields: [input.field],
        reason: input.reason,
        conversation: input.conversation,
        texts: input.texts ?? [],
        unchanged: `Nothing changed: ${input.field.field} has that value already.`,
        changed: ({ changes }) =>
          afterApplied({
            scope: input.scope,
            name,
            key: input.key,
            was: input.located.server,
            check,
            changes,
            lead: input.lead,
            extra: input.extra ?? [],
          }),
      });
    });

  const disable = (input: {
    readonly scope: string;
    readonly name: string;
    readonly reason: string;
    readonly conversation: number;
  }) =>
    Effect.gen(function* () {
      const located = yield* locate(access, input.scope, input.name);
      const view = yield* settings.get(input.scope);

      if (!located.server.server.server.enabled) {
        return unchanged(
          view,
          fieldOf(input.name, "enabled"),
          `MCP server ${input.name} is switched off ${where(view)} already: nothing was changed or recorded.`,
        );
      }

      return yield* change({
        tool: "settings_mcp_disable",
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
        conversation: input.conversation,
        lead: `Switched off MCP server ${input.name} ${where(view)}. Its connection is closed and its tools are no longer registered; its inventory is kept, and the user switches it on again.`,
      });
    });

  const exposureSet = (input: {
    readonly scope: string;
    readonly name: string;
    readonly exposure: McpExposure;
    readonly reason: string;
    readonly conversation: number;
  }) =>
    Effect.gen(function* () {
      const located = yield* locate(access, input.scope, input.name);
      const view = yield* settings.get(input.scope);
      const entry = located.server.server.server;

      if (entry.exposure === input.exposure) {
        return unchanged(
          view,
          fieldOf(input.name, "exposure"),
          `MCP server ${input.name} has the exposure ${input.exposure} ${where(view)} already: nothing was changed or recorded.`,
        );
      }

      const lifting = Arr.filter(
        located.view.offered,
        (pattern) =>
          pattern.startsWith(mcpToolPrefix(input.name)) ||
          (pattern.includes("*") &&
            matchesToolPattern(pattern, `${mcpToolPrefix(input.name)}tool`)),
      );

      return yield* change({
        tool: "settings_mcp_exposure_set",
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
        conversation: input.conversation,
        lead: `Set the exposure of MCP server ${input.name} to ${input.exposure} ${where(view)}. A tool named in the server's toolExposure keeps its own exposure.`,
        extra:
          lifting.length === 0
            ? []
            : [
                `tools.offered has ${Arr.join(lifting, ", ")}, which lifts a matching tool to direct whatever this exposure is, never a hidden one.`,
              ],
      });
    });

  const toolExposureSet = (input: {
    readonly scope: string;
    readonly name: string;
    readonly tool: string;
    readonly exposure: McpExposure | null;
    readonly before: string | undefined;
    readonly reason: string;
    readonly conversation: number;
  }) =>
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

      const field = fieldOf(input.name, "toolExposure");

      if (sameKeys(before, next.keys)) {
        return unchanged(
          view,
          field,
          input.exposure === null
            ? `MCP server ${input.name} has no toolExposure key ${JSON.stringify(tool)} ${where(view)}: nothing was changed or recorded.`
            : `MCP server ${input.name} has the toolExposure key ${JSON.stringify(tool)} → ${input.exposure} ${where(view)} already, in that place: nothing was changed or recorded.`,
        );
      }

      const written = Record.fromEntries(next.keys);

      return yield* change({
        tool: "settings_mcp_tool_exposure_set",
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
        conversation: input.conversation,
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
    });

  /**
   * `settings_reset` of `field`, one of an MCP server's `enabled`, `exposure` and `toolExposure` or the entry itself
   * (`mcp.servers.<name>[.key]`): only at an Environment and only an adjustment's key, as an Override of Global's or a Repo's
   * server is removed. The entry, anything at `*` and a key of the Environment's own entry are refused, naming the tool for each.
   */
  const resetField = (input: {
    readonly scope: string;
    readonly field: string;
    readonly reason: string;
    readonly conversation: number;
  }) =>
    Effect.gen(function* () {
      const [, , name = "", key] = input.field.split(".");
      const keyName = Arr.findFirst(KEYS, (each) => each === key);

      if (key === undefined || Option.isNone(keyName)) {
        return yield* refuse(
          `Nothing was asked or saved: settings_reset does not take a whole MCP server (${input.field}). settings_mcp_remove removes an Environment's own server, and asks the user first.`,
        );
      }

      if (input.scope === GLOBAL_SETTINGS_SCOPE) {
        return yield* refuse(
          `Nothing was asked or saved: settings_reset takes no MCP field at "*" (${input.field}): Global holds the servers' own entries, with no lower layer to fall back to. Use settings_mcp_enable, settings_mcp_disable and the exposure tools to change a key, settings_mcp_remove to remove a server.`,
        );
      }

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

      if (overrideInherited(view.overrides, input.field)) {
        return unchanged(
          view,
          input.field,
          `${environmentWords({ id: view.scope, name: view.name })} holds no adjustment of ${name}'s ${key}: it inherits already, so nothing was asked, changed or recorded.`,
        );
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

      const check = yield* access.check({ scope: input.scope, name, changes: [asCheck(field)] });

      yield* refuseWidening(check, `resetting ${key} of ${JSON.stringify(name)}`);

      return yield* apply({
        tool: "settings_reset",
        view,
        fields: [field],
        reason: input.reason,
        conversation: input.conversation,
        unchanged: `${input.field} inherits already: nothing changed.`,
        changed: ({ changes }) =>
          Effect.gen(function* () {
            const pushed = yield* pushMcpSet(access, input.scope);

            const now = yield* access.view({ scope: input.scope, name }).pipe(
              Effect.map((each) => Option.getOrUndefined(Arr.head(each.servers))),
              Effect.orElseSucceed(() => undefined),
            );

            return Arr.join(
              [
                `Reset the ${KEY_LABELS[keyName.value]} of MCP server ${name} ${where(view)}: its adjustment is removed, so the key follows the server's own layer again.`,
                Option.isSome(server)
                  ? `- MCP server ${name} · ${KEY_LABELS[keyName.value]}: it was ${keyWords(keyName.value, server.value.server.server)}${inheritedWords(changes[0], "before")}, and is ${now === undefined ? "unknown" : keyWords(keyName.value, now.server.server)}${inheritedWords(changes[0], "after")} now.`
                  : `- The adjustment of ${name} had no server to adjust: it is gone.`,
                pushed === "failed"
                  ? "The new set could not be handed to this Environment's MCP host now: it takes it at its next pull."
                  : "The new set was handed to this Environment's MCP host.",
                "The change is recorded with your reason; the user can see and revert it on the Settings page.",
              ],
              "\n",
            );
          }),
      });
    });

  return { disable, exposureSet, toolExposureSet, resetField };
});

const CHANGE_NOTE =
  "The change is recorded with your reason, and the user can see and revert it on the Settings page. Only changes that narrow what is reachable are made here: one that would switch a server on, take it or a tool out of hidden, or otherwise make something reachable that is not, needs the user's Approval and is refused. A name is the server in force in that Scope's set. At scope \"*\" the key is changed in Global's entry, which reaches every Environment but those whose own entry or adjustment overrides it (the result names them); at an Environment's id the change is that Environment's own, an Override even when it equals Global's (settings_reset removes it). The new set is handed to the MCP hosts the change reaches.";

/** The tools of the extension that change servers without the owner's Approval. */
export const SETTINGS_MCP_CHANGE_TOOLS = [
  "settings_mcp_disable",
  "settings_mcp_exposure_set",
  "settings_mcp_tool_exposure_set",
] as const;

/** The three tools, over `McpChanges`. */
export const McpChangeTools = Effect.gen(function* () {
  const changes = yield* McpChanges;

  const disable = yield* defineEffectTool({
    name: "settings_mcp_disable",
    description: `Switch an MCP server off at one Scope: its connection and streams are closed and its tools are no longer reachable (its inventory is kept). ${CHANGE_NOTE} Switching a server on again waits for the user's Approval.`,
    parameters: Schema.Struct({ scope: SettingsScope, name: ServerName, reason: Reason }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    // A rerun after an eviction would record the change again, against the value it set.
    replay: "unsafe",
    execute: ({ scope, name, reason }, api) =>
      changes.disable({ scope, name, reason, conversation: api.conversationId }),
  });

  const exposureSet = yield* defineEffectTool({
    name: "settings_mcp_exposure_set",
    description: `Set how an MCP server's tools reach the model, at one Scope: codemode (called from a script; the default), deferred (found with tool_search), direct (offered by name) or hidden (unreachable). A tool the server's toolExposure names keeps its own exposure. ${CHANGE_NOTE} Taking a server out of hidden is not made here.`,
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
      changes.exposureSet({ scope, name, exposure, reason, conversation: api.conversationId }),
  });

  const toolExposureSet = yield* defineEffectTool({
    name: "settings_mcp_tool_exposure_set",
    description: `Set, move or remove one key of an MCP server's toolExposure at one Scope. tool is the server's own tool name (as settings_mcp_get lists it), a pattern with * , or a model-facing mcp__<server>__<tool> name, which is mapped back through the server's discovered tools. exposure is codemode, deferred, direct or hidden; null removes the key. The first key that matches a tool wins and an exact name beats a pattern: a new pattern goes last, an existing key keeps its place, and before names an existing pattern key to put this one ahead of (an exact name ignores it). The result says which known tools the key decides and which it is shadowed for, with the fix; a key that matches no tool is kept with a warning, and for a server not discovered here its tools are not checked. ${CHANGE_NOTE} Hiding is made here; removing or loosening a hidden key, or putting another key ahead of one, is not.`,
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
      changes.toolExposureSet({
        scope,
        name,
        tool,
        exposure,
        before,
        reason,
        conversation: api.conversationId,
      }),
  });

  return [disable, exposureSet, toolExposureSet] as const;
});
