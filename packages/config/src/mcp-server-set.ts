// The MCP server set of an Environment (`docs/architecture/mcp-configuration.md` → Scopes, adjustments and the set): the
// servers its Sessions reach, resolved purely from Global's document, the Environment's Overrides and each Repo's
// `.pi/mcp.json`, with the problems found on the way. The Registry keeps the result and hands it to the Environment's
// `McpHost`; `./mcp-connection.ts` keys it.
//
// Order (MCP server configuration, D4): the owner's entries first, an Environment's full entry over Global's; a Repo's full
// entries only add servers; then adjustments, a Repo's first and the Environment's last, so the Environment has the
// last word. A Repo's entry under an owner's name (or its case or `-`/`_` twin) is shadowed, which is no problem; two
// Repos defining one name is, and the first Repo wins. A Repo's adjustments only switch off.
// @effect-diagnostics missingPipeableSignature:off -- resolvers of plain values, not combinators.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import {
  decodeMcpServerValue,
  isMcpFullEntry,
  MCP_ADJUSTMENT_KEYS,
  MCP_LIMITS,
  MCP_NAME,
  type McpServerEntry,
  type McpServerValue,
  mcpServersOf,
  normalizeMcpName,
  normalizeMcpServer,
  readMcpRepoFile,
} from "./mcp-servers.ts";
import { sameJson } from "./patch.ts";

/** Where an MCP server's definition, or a problem, comes from: Global, the Environment, or a Repo's file. */
export type McpSource =
  | { readonly kind: "global" }
  | { readonly kind: "environment" }
  | {
      readonly kind: "repo";
      /** The Repo's directory name in the Environment (`/workspace/<directory>`). */
      readonly directory: string;
      /** The Repo's `owner/repo`, which keys its servers' MCP sign-ins. */
      readonly slug: string;
      /** The file's path in the Repo: `.pi/mcp.json`. */
      readonly path: string;
    };

/** A Repo's `.pi/mcp.json` as the Registry last read it, in the Environment's Repo order. */
export type McpRepoLayer = {
  readonly directory: string;
  readonly slug: string;
  readonly path: string;
  /** The file's text. */
  readonly text: string;
};

/** A Repo entry that an owner's entry of the same name (or its twin) hides: an info mark, never a problem. */
export type McpShadowed = {
  readonly source: Extract<McpSource, { readonly kind: "repo" }>;
  /** The name as the Repo spells it. */
  readonly name: string;
  /** Whether the normalized entries differ: "differs from your entry". */
  readonly differs: boolean;
};

/** An MCP server of the set. */
export type McpResolvedServer = {
  /** The name as its entry spells it. */
  readonly name: string;
  readonly source: McpSource;
  /** The entry in force, with every default and every adjustment applied, `${NAME}` unresolved. */
  readonly server: McpServerEntry;
  /** An Environment's own entry that replaced Global's of the same name. */
  readonly replacesGlobal: boolean;
  /** The Repo entries this one hides. */
  readonly shadowed: ReadonlyArray<McpShadowed>;
  /** Whether `${NAME}` may name a Secret: the owner's entries do, a Repo's read Variables only (ADR-0029). */
  readonly resolvesSecrets: boolean;
};

/** Something wrong with an entry, an adjustment or a Repo's file, and where it is. */
export type McpProblem = {
  readonly source: McpSource;
  /** The entry's name; null for a Repo's file as a whole. */
  readonly name: string | null;
  readonly message: string;
  /** For an orphaned Environment adjustment, the Override fields whose Reset removes it. */
  readonly reset?: ReadonlyArray<string> | undefined;
};

/** An adjustment with no server to adjust. */
export type McpOrphan = {
  readonly source: McpSource;
  readonly name: string;
  /** The keys it holds. */
  readonly keys: ReadonlyArray<string>;
};

export type McpServerSet = {
  readonly servers: ReadonlyArray<McpResolvedServer>;
  readonly problems: ReadonlyArray<McpProblem>;
  readonly orphans: ReadonlyArray<McpOrphan>;
};

type RepoSource = Extract<McpSource, { readonly kind: "repo" }>;

/** A server being resolved: its entry as written, which later adjustments change. */
type Working = {
  readonly name: string;
  readonly source: McpSource;
  readonly value: McpServerValue;
  readonly replacesGlobal: boolean;
  readonly shadowed: ReadonlyArray<McpShadowed>;
};

type Layer = {
  readonly entries: ReadonlyArray<{ readonly name: string; readonly value: McpServerValue }>;
  readonly adjustments: ReadonlyArray<{ readonly name: string; readonly value: McpServerValue }>;
};

const GLOBAL: McpSource = { kind: "global" };
const ENVIRONMENT: McpSource = { kind: "environment" };

const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

/**
 * The entries and adjustments of an owner's layer (Global's document or an Environment's Overrides) that stand, each
 * entry read as the Settings read it. What a stale document holds that the Settings would refuse is skipped with a
 * problem: an entry that does not decode, a name that is not one or is the twin of an earlier one, an entry over the 50
 * servers, an adjustment at Global.
 */
const readOwnerLayer = (
  document: Schema.Json,
  source: McpSource,
  problems: Array<McpProblem>,
): Layer => {
  const servers = mcpServersOf(document);
  const entries: Array<Layer["entries"][number]> = [];
  const adjustments: Array<Layer["adjustments"][number]> = [];
  const seen = new Map<string, string>();

  if (servers === undefined || !isJsonObject(servers)) return { entries, adjustments };

  for (const [name, written] of Record.toEntries(servers)) {
    const skip = (message: string) => problems.push({ source, name, message });
    const twin = seen.get(normalizeMcpName(name));

    if (name.length > MCP_LIMITS.name || !MCP_NAME.test(name)) {
      skip("is skipped: a name is letters, digits, - and _, at most 64 characters");

      continue;
    }

    if (twin !== undefined) {
      skip(`is skipped: it clashes with "${twin}", a name that differs only in case or in - and _`);

      continue;
    }

    seen.set(normalizeMcpName(name), name);

    const decoded = decodeMcpServerValue(written);

    if (Result.isFailure(decoded)) {
      skip(
        `is skipped: ${Arr.join(
          Arr.map(decoded.failure, ({ line }) => line),
          "; ",
        )}`,
      );
    } else if (isMcpFullEntry(decoded.success)) {
      if (entries.length >= MCP_LIMITS.servers) {
        skip(`is skipped: a Scope has at most ${MCP_LIMITS.servers} MCP servers`);
      } else {
        entries.push({ name, value: decoded.success });
      }
    } else if (source.kind === "global") {
      skip("is skipped: Global holds no MCP server adjustment, it has no lower layer to adjust");
    } else {
      adjustments.push({ name, value: decoded.success });
    }
  }

  return { entries, adjustments };
};

/** The keys of an adjustment, or of a Repo's. */
const adjustmentKeys = (value: McpServerValue): ReadonlyArray<string> =>
  Arr.filter(MCP_ADJUSTMENT_KEYS, (key) => value[key] !== undefined);

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/** The entry `value` with the keys of `adjustment` over it: `{ ...base, ...value }`. */
const withAdjustment = (value: McpServerValue, adjustment: McpServerValue): McpServerValue => {
  const adjusted: Writable<McpServerValue> = { ...value };

  if (adjustment.enabled !== undefined) adjusted.enabled = adjustment.enabled;

  if (adjustment.exposure !== undefined) adjusted.exposure = adjustment.exposure;

  if (adjustment.toolExposure !== undefined) adjusted.toolExposure = adjustment.toolExposure;

  return adjusted;
};

/**
 * The entry `value` as a Repo's adjustment (which only switches off, `readMcpRepoFile`) leaves it: switched off, hidden,
 * and with the `hidden` tools of the adjustment ahead of its own, where the first pattern wins, so it can hide more and
 * never less.
 */
const withSwitchOff = (value: McpServerValue, adjustment: McpServerValue): McpServerValue => {
  const adjusted: Writable<McpServerValue> = { ...value };
  const hidden = adjustment.toolExposure;

  if (adjustment.enabled !== undefined) adjusted.enabled = false;

  if (adjustment.exposure !== undefined) adjusted.exposure = "hidden";

  if (hidden !== undefined) {
    adjusted.toolExposure = {
      ...hidden,
      ...Record.filter(value.toolExposure ?? {}, (_, key) => !Predicate.hasProperty(hidden, key)),
    };
  }

  return adjusted;
};

const normalized = (value: McpServerValue): Option.Option<McpServerEntry> =>
  Option.fromUndefinedOr(normalizeMcpServer(value));

/** Whether two entries as written are the same server in the same state, once normalized. */
const sameEntry = (left: McpServerValue, right: McpServerValue): boolean =>
  sameJson(Option.getOrNull(normalized(left)), Option.getOrNull(normalized(right)));

/**
 * The MCP server set of an Environment: Global's servers (`global`, the Global document as saved), then the
 * Environment's (`overrides`, its Overrides), then each Repo's file (`repos`, in the Environment's Repo order), each read
 * as its own rules say, with what was skipped or left over as `problems`. It is pure: it reads no Secret, and a Repo's
 * entry naming one is the Registry's to skip when it asks for the values (`resolvesSecrets`).
 */
export const resolveMcpServerSet = (
  global: Schema.Json,
  overrides: Schema.Json,
  repos: ReadonlyArray<McpRepoLayer>,
): McpServerSet => {
  const problems: Array<McpProblem> = [];
  const orphans: Array<McpOrphan> = [];
  const globalLayer = readOwnerLayer(global, GLOBAL, problems);
  const environmentLayer = readOwnerLayer(overrides, ENVIRONMENT, problems);

  // The owner's entries: Global's, and the Environment's over them. The set is a list of `Working` that a name finds.
  const working: Array<Working> = Arr.map(globalLayer.entries, ({ name, value }): Working => ({
    name,
    source: GLOBAL,
    value,
    replacesGlobal: false,
    shadowed: [],
  }));

  const indexOf = (name: string): number =>
    Arr.findFirstIndex(working, (held) => held.name === name).pipe(Option.getOrElse(() => -1));

  const twinIndexOf = (name: string): number =>
    Arr.findFirstIndex(
      working,
      (held) => normalizeMcpName(held.name) === normalizeMcpName(name),
    ).pipe(Option.getOrElse(() => -1));

  for (const { name, value } of environmentLayer.entries) {
    const same = indexOf(name);
    const twin = twinIndexOf(name);
    const held = working[twin];

    if (twin < 0 || held === undefined) {
      working.push({ name, source: ENVIRONMENT, value, replacesGlobal: false, shadowed: [] });

      continue;
    }

    if (same < 0) {
      problems.push({
        source: GLOBAL,
        name: held.name,
        message: `is skipped here: it clashes with this Environment's "${name}", a name that differs only in case or in - and _`,
      });
    }

    working[twin] = { name, source: ENVIRONMENT, value, replacesGlobal: same >= 0, shadowed: [] };
  }

  // A Repo's entries only add servers: under an owner's name they are shadowed, under an earlier Repo's they are a problem.
  const ownerCount = working.length;

  const repoAdjustments: Array<{
    readonly source: RepoSource;
    readonly name: string;
    readonly value: McpServerValue;
  }> = [];

  for (const layer of repos) {
    const source: RepoSource = {
      kind: "repo",
      directory: layer.directory,
      slug: layer.slug,
      path: layer.path,
    };

    const file = readMcpRepoFile(layer.text, layer.directory);

    for (const problem of file.problems) problems.push({ source, ...problem });

    for (const { name, value } of file.entries) {
      if (!isMcpFullEntry(value)) {
        repoAdjustments.push({ source, name, value });

        continue;
      }

      const twin = twinIndexOf(name);
      const held = working[twin];

      if (held === undefined) {
        working.push({ name, source, value, replacesGlobal: false, shadowed: [] });
      } else if (twin < ownerCount) {
        working[twin] = {
          ...held,
          shadowed: [...held.shadowed, { source, name, differs: !sameEntry(held.value, value) }],
        };
      } else {
        problems.push({
          source,
          name,
          message: `is skipped: "${held.name}" is defined by an earlier Repo's file (the first Repo wins)`,
        });
      }
    }
  }

  // Adjustments by exact name: a Repo's first, which only switch off, and the Environment's last.
  for (const { source, name, value } of repoAdjustments) {
    const index = indexOf(name);
    const held = working[index];

    if (held === undefined) {
      orphans.push({ source, name, keys: adjustmentKeys(value) });
      problems.push({
        source,
        name,
        message: "adjusts a server that is not in this Environment's set",
      });
    } else {
      working[index] = { ...held, value: withSwitchOff(held.value, value) };
    }
  }

  for (const { name, value } of environmentLayer.adjustments) {
    const index = indexOf(name);
    const held = working[index];
    const keys = adjustmentKeys(value);

    if (held === undefined) {
      const twin = working[twinIndexOf(name)];

      orphans.push({ source: ENVIRONMENT, name, keys });
      problems.push({
        source: ENVIRONMENT,
        name,
        message:
          twin === undefined
            ? "adjusts a server that no layer defines any more: reset it"
            : `adjusts a server that no layer defines any more: reset it ("${twin.name}" differs from it in case or in - and _, and a name must match exactly)`,
        reset: Arr.map(keys, (key) => `mcp.servers.${name}.${key}`),
      });
    } else {
      working[index] = { ...held, value: withAdjustment(held.value, value) };
    }
  }

  const servers = Arr.filterMap(working, (held) =>
    Option.match(normalized(held.value), {
      onNone: () => Result.failVoid,
      onSome: (server) =>
        Result.succeed<McpResolvedServer>({
          name: held.name,
          source: held.source,
          server,
          replacesGlobal: held.replacesGlobal,
          shadowed: held.shadowed,
          resolvesSecrets: held.source.kind !== "repo",
        }),
    }),
  );

  return { servers, problems, orphans };
};
