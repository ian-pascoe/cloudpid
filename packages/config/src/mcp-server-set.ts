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
  isMcpFullEntry,
  MCP_ADJUSTMENT_KEYS,
  type McpServerEntry,
  type McpServerValue,
  type McpAdjustmentStep,
  type McpLayerRead,
  type McpNamedHint,
  MCP_ADJUSTMENT_OVER,
  applyMcpAdjustmentSteps,
  mcpAdjustmentSteps,
  mcpEntryHints,
  mcpTwinClash,
  mcpShadowedTwins,
  readMcpLayer,
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

/** A note on a server that stands as it is (`McpEntryHint`), and where its entry is. */
export type McpHint = McpNamedHint & { readonly source: McpSource };

export type McpServerSet = {
  readonly servers: ReadonlyArray<McpResolvedServer>;
  readonly problems: ReadonlyArray<McpProblem>;
  /** What is no problem but worth saying about the servers in the set: an ignored `oauth` field. */
  readonly hints: ReadonlyArray<McpHint>;
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

const GLOBAL: McpSource = { kind: "global" };
const ENVIRONMENT: McpSource = { kind: "environment" };

/**
 * An owner's layer (Global's document or an Environment's Overrides) as the Settings read it (`readMcpLayer`, which both
 * share): what does not stand is a problem of `source`.
 */
const readOwnerLayer = (
  document: Schema.Json,
  source: McpSource,
  problems: Array<McpProblem>,
): McpLayerRead => {
  const read = readMcpLayer(
    mcpServersOf(document),
    source.kind === "global" ? "global" : "environment",
  );

  for (const { name, keys, text } of read.problems) {
    problems.push({
      source,
      name,
      message: keys.length === 0 ? text : `${Arr.join(keys, ".")}: ${text}`,
    });
  }

  return read;
};

/** The keys of an adjustment, or of a Repo's. */
const adjustmentKeys = (value: McpServerValue): ReadonlyArray<string> =>
  Arr.filter(MCP_ADJUSTMENT_KEYS, (key) => value[key] !== undefined);

/**
 * The steps of a Repo's adjustment `adjustment` over the entry `value` (which only switches off, `readMcpRepoFile`):
 * switched off, hidden, and the `hidden` tools of the adjustment ahead of the entry's own, where the first pattern
 * wins, so it can hide more and never less.
 */
const switchOffSteps = (
  value: McpServerValue,
  adjustment: McpServerValue,
): ReadonlyArray<McpAdjustmentStep> => {
  const steps: Array<McpAdjustmentStep> = [];
  const hidden = adjustment.toolExposure;

  if (adjustment.enabled !== undefined) {
    steps.push({ key: "enabled", set: (entry) => void (entry.enabled = false) });
  }

  if (adjustment.exposure !== undefined) {
    steps.push({ key: "exposure", set: (entry) => void (entry.exposure = "hidden") });
  }

  if (hidden !== undefined) {
    const own = value.toolExposure ?? {};

    steps.push({
      key: "toolExposure",
      set: (entry) =>
        void (entry.toolExposure = {
          ...hidden,
          ...Record.filter(own, (_, key) => !Predicate.hasProperty(hidden, key)),
        }),
    });
  }

  return steps;
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

  // The owner's entries: Global's, and the Environment's over them. The Environment has the last word, so a name of Global's
  // that is the twin of one of its own is left out (the Settings leave it out too, `mcpShadowedTwins`).
  const shadowedTwins = mcpShadowedTwins(
    Arr.map(globalLayer.entries, ({ name }) => name),
    Arr.map(environmentLayer.entries, ({ name }) => name),
  );

  for (const { global: name, text } of shadowedTwins) {
    problems.push({ source: GLOBAL, name, message: text });
  }

  const working: Array<Working> = Arr.filterMap(globalLayer.entries, ({ name, value }) =>
    Arr.some(shadowedTwins, ({ global }) => global === name)
      ? Result.failVoid
      : Result.succeed<Working>({
          name,
          source: GLOBAL,
          value,
          replacesGlobal: false,
          shadowed: [],
        }),
  );

  const indexOf = (name: string): number =>
    Arr.findFirstIndex(working, (held) => held.name === name).pipe(Option.getOrElse(() => -1));

  const twinIndexOf = (name: string): number =>
    Arr.findFirstIndex(
      working,
      (held) => normalizeMcpName(held.name) === normalizeMcpName(name),
    ).pipe(Option.getOrElse(() => -1));

  for (const { name, value } of environmentLayer.entries) {
    const same = indexOf(name);

    if (same < 0) {
      working.push({ name, source: ENVIRONMENT, value, replacesGlobal: false, shadowed: [] });
    } else {
      working[same] = { name, source: ENVIRONMENT, value, replacesGlobal: true, shadowed: [] };
    }
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
      const applied = applyMcpAdjustmentSteps(held.value, switchOffSteps(held.value, value));

      for (const key of applied.refused) {
        problems.push({ source, name, message: `${key}: ${MCP_ADJUSTMENT_OVER}` });
      }

      working[index] = { ...held, value: applied.value };
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
            : mcpTwinClash(twin.name),
        reset: Arr.map(keys, (key) => `mcp.servers.${name}.${key}`),
      });
    } else {
      const applied = applyMcpAdjustmentSteps(held.value, mcpAdjustmentSteps(value));

      for (const key of applied.refused) {
        problems.push({
          source: ENVIRONMENT,
          name,
          message: `${key}: ${MCP_ADJUSTMENT_OVER}`,
          reset: [`mcp.servers.${name}.${key}`],
        });
      }

      working[index] = { ...held, value: applied.value };
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

  const hints = Arr.flatMap(working, (held) =>
    Arr.map(mcpEntryHints(held.value), (hint): McpHint => ({
      ...hint,
      source: held.source,
      name: held.name,
    })),
  );

  return { servers, problems, orphans, hints };
};
