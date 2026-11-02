// Exposure of MCP tools (`docs/architecture/mcp-in-a-session.md` → Exposure) and the check that a change to it widens
// what is reachable (`docs/architecture/mcp-configuration.md` → Approval). Both are pure, over the entries in force
// that `resolveMcpServerSet` returns, so the Session, the Settings page, `settings_mcp_*` and the Registry's Approval
// read one answer.
// @effect-diagnostics missingPipeableSignature:off -- resolvers of plain values, not combinators.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import { matchesToolPattern } from "./tool-pattern.ts";
import type { McpResolvedServer } from "./mcp-server-set.ts";
import type { McpExposure, McpServerEntry } from "./mcp-servers.ts";

/** The keys of an MCP server entry that decide Exposure. */
export type McpExposureKeys = Pick<McpServerEntry, "exposure" | "toolExposure">;

/** What decided a tool's Exposure. */
export type McpExposureReason =
  /** The server's own `exposure`. */
  | { readonly kind: "server" }
  /** A `toolExposure` key that is the tool's own name. */
  | { readonly kind: "tool"; readonly key: string }
  /** The first `toolExposure` pattern that matches, no exact name having matched. */
  | { readonly kind: "pattern"; readonly key: string }
  /** A `tools.offered` entry that lifted `from` to `direct`. */
  | {
      readonly kind: "offered";
      readonly pattern: string;
      readonly from: Exclude<McpExposure, "direct" | "hidden">;
    };

export type McpExposureDecision = {
  readonly exposure: McpExposure;
  readonly reason: McpExposureReason;
};

/** A tool's `toolExposure` key: its own name, else the first pattern that matches it, in the order written. */
const decidingKey = (
  toolExposure: McpExposureKeys["toolExposure"],
  tool: string,
): Option.Option<readonly [McpExposureReason, McpExposure]> => {
  const keys = Record.keys(toolExposure);
  const exact = Arr.findFirst(keys, (key) => key === tool);

  if (Option.isSome(exact)) {
    return Option.some([{ kind: "tool", key: exact.value }, toolExposure[exact.value] ?? "hidden"]);
  }

  return Option.map(
    Arr.findFirst(keys, (key) => key.includes("*") && matchesToolPattern(key, tool)),
    (key) => [{ kind: "pattern", key }, toolExposure[key] ?? "hidden"] as const,
  );
};

/**
 * The Exposure of one tool: the server's `exposure`, then `toolExposure`, whose keys are the server's own tool names
 * (as pi's are, not cloudpid's snake_case spelling), an exact name beating a pattern and the first pattern that
 * matches winning; then a `tools.offered` entry that matches `modelName` (the tool's `mcp__<server>__<tool>`, in
 * cloudpid's spelling) lifts `codemode` or `deferred` to `direct`, and never `hidden`.
 */
export const resolveExposure = (input: {
  readonly server: McpExposureKeys;
  /** The tool's name as its server calls it. */
  readonly tool: string;
  /** The tool's model-facing name; with `offered`, it can lift the Exposure. */
  readonly modelName?: string | undefined;
  /** `tools.offered`: names and patterns in cloudpid's spelling. */
  readonly offered?: ReadonlyArray<string> | undefined;
}): McpExposureDecision => {
  const { server, tool, modelName, offered = [] } = input;
  const decided = decidingKey(server.toolExposure, tool);
  const exposure = Option.isSome(decided) ? decided.value[1] : server.exposure;
  const reason: McpExposureReason = Option.isSome(decided) ? decided.value[0] : { kind: "server" };

  if (exposure !== "codemode" && exposure !== "deferred") return { exposure, reason };

  const lifted =
    modelName === undefined
      ? Option.none()
      : Arr.findFirst(offered, (pattern) => matchesToolPattern(pattern, modelName));

  return Option.isSome(lifted)
    ? { exposure: "direct", reason: { kind: "offered", pattern: lifted.value, from: exposure } }
    : { exposure, reason };
};

/** A server as the widening check reads it: its entry in force and where that entry comes from. */
export type McpReach = Pick<McpResolvedServer, "source"> & {
  readonly server: Pick<McpServerEntry, "enabled" | "exposure" | "toolExposure">;
};

/** Why a change makes a switched-off server or a hidden tool reachable. */
export type McpWidening =
  /** A server switched on. */
  | { readonly kind: "switched_on" }
  /** The server's `exposure` left `hidden`. */
  | { readonly kind: "exposure_unhidden" }
  /** A `hidden` `toolExposure` key was removed. */
  | { readonly kind: "key_removed"; readonly key: string }
  /** A `hidden` `toolExposure` key was loosened to `exposure`. */
  | { readonly kind: "key_loosened"; readonly key: string; readonly exposure: McpExposure }
  /**
   * A non-`hidden` key now stands ahead of a `hidden` rule it could win over: `over` is the `hidden` key, or `null` for
   * the server's own `hidden` `exposure`. That covers a new key, a key moved ahead, and a `hidden` pattern moved behind
   * one (so that it matches fewer tools).
   */
  | { readonly kind: "key_ahead"; readonly key: string; readonly over: string | null };

/**
 * One rule that decides a tool's Exposure: an exact name (which beats every pattern), a pattern (the first that matches
 * wins, so `index` is its place among the patterns) or the server's own `exposure`, which matches every tool and is last.
 */
type Rule =
  | { readonly kind: "exact"; readonly key: string; readonly exposure: McpExposure }
  | {
      readonly kind: "pattern";
      readonly key: string;
      readonly exposure: McpExposure;
      readonly index: number;
    }
  | { readonly kind: "default"; readonly key: ""; readonly exposure: McpExposure };

/** The rules of an entry in order of precedence. */
const rulesOf = (server: McpReach["server"]): ReadonlyArray<Rule> => {
  const keys = Record.keys(server.toolExposure);
  const exposureOf = (key: string): McpExposure => server.toolExposure[key] ?? "hidden";

  return [
    ...Arr.map(
      Arr.filter(keys, (key) => !key.includes("*")),
      (key): Rule => ({ kind: "exact", key, exposure: exposureOf(key) }),
    ),
    ...Arr.map(
      Arr.filter(keys, (key) => key.includes("*")),
      (key, index): Rule => ({ kind: "pattern", key, exposure: exposureOf(key), index }),
    ),
    { kind: "default", key: "", exposure: server.exposure },
  ];
};

/** The rule of `rules` that is `rule`'s own key, whatever its Exposure. */
const findRule = (rules: ReadonlyArray<Rule>, rule: Rule): Rule | undefined =>
  Option.getOrUndefined(
    Arr.findFirst(rules, (other) => other.kind === rule.kind && other.key === rule.key),
  );

/** Whether `rule` stands ahead of `over`, with some tool both could decide. Patterns are taken to overlap. */
const couldWinOver = (rule: Rule, over: Rule): boolean => {
  if (rule.kind === "default" || over.kind === "exact") return false;

  if (rule.kind === "exact") {
    // An exact name is decided as `rule` says only where `over` matches that very name.
    return over.kind === "default" || matchesToolPattern(over.key, rule.key);
  }

  return over.kind === "default" || rule.index < over.index;
};

/** What switching nothing on and hiding everything looks like: where a server that had no entry started from. */
const NOTHING: McpReach["server"] = { enabled: false, exposure: "hidden", toolExposure: {} };

/**
 * What a change from `before` to `after` makes reachable that was not (`mcp-configuration.md` → Approval): for one
 * Environment's set, the entries in force of the server by name, before and after (`undefined` for none). The result
 * lists every reason, and is empty when the change does not widen.
 *
 * The Registry has no inventory, so tool-level cases are decided by key: a `hidden` key that goes, loosens, or is
 * overtaken by a non-`hidden` key that could win over it. An exact name is told from a pattern by matching, two
 * patterns are taken to overlap. Un-shadowing a Repo's entry (an owner's entry replaced by the Repo's) is not widening.
 */
export const checkMcpWidening = (
  before: McpReach | undefined,
  after: McpReach | undefined,
): ReadonlyArray<McpWidening> => {
  if (after === undefined) return [];

  if (before !== undefined && before.source.kind !== "repo" && after.source.kind === "repo") {
    return [];
  }

  const was = before?.server ?? NOTHING;
  const found: Array<McpWidening> = [];

  if (!was.enabled && after.server.enabled) found.push({ kind: "switched_on" });

  const rulesBefore = rulesOf(was);
  const rulesAfter = rulesOf(after.server);

  const loosened = new Set<string>();

  for (const rule of rulesBefore) {
    if (rule.exposure !== "hidden") continue;

    const now = findRule(rulesAfter, rule);

    if (rule.kind === "default") {
      if (now?.exposure !== "hidden") found.push({ kind: "exposure_unhidden" });
    } else if (now === undefined) {
      found.push({ kind: "key_removed", key: rule.key });
    } else if (now.exposure !== "hidden") {
      loosened.add(rule.key);
      found.push({ kind: "key_loosened", key: rule.key, exposure: now.exposure });
    }
  }

  for (const kept of rulesBefore) {
    const over = findRule(rulesAfter, kept);

    if (kept.exposure !== "hidden" || over?.exposure !== "hidden") continue;

    for (const rule of rulesAfter) {
      if (rule.exposure === "hidden" || loosened.has(rule.key) || !couldWinOver(rule, over)) {
        continue;
      }

      const earlier = findRule(rulesBefore, rule);

      const alreadyAhead =
        earlier !== undefined && earlier.exposure !== "hidden" && couldWinOver(earlier, kept);

      if (!alreadyAhead) {
        found.push({
          kind: "key_ahead",
          key: rule.key,
          over: kept.kind === "default" ? null : kept.key,
        });
      }
    }
  }

  return found;
};
