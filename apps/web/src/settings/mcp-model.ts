// @effect-diagnostics missingPipeableSignature:off -- builders of plain values, not combinators.

// The MCP servers section's rows (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section): what
// the page shows of the servers at a Scope, resolved from the two documents the Registry hands the page, as the Registry
// resolves the set (`resolveMcpServerSet`, which reads every layer as the Settings read it). Pure: the section's
// components, tests and writes all read this one view.
//
// A Repo's `.pi/mcp.json` comes in as `repoFiles`, each as the Registry last looked at it (`mcpRepoFiles`): the page reads
// no GitHub. The files whose copy is held are the Repo layers of the set, as the Registry makes them (`mcpRepoLayersOf`),
// so a Repo's servers are rows, read-only, and what is wrong with a file as a whole is on its file row.

import {
  isJsonObject,
  isMcpFullEntry,
  MCP_ADJUSTMENT_KEYS,
  type McpProblem,
  type McpProblemSource,
  type McpRepoLayer,
  type McpNamedEntry,
  type McpServerEntry,
  type McpSettingsProblem,
  type McpShadowed,
  type McpSource,
  matchesToolPattern,
  mcpServersOf,
  readMcpProblemSource,
  readMcpRepoFile,
  resolveMcpServerSet,
} from "@cloudpid/config";
import {
  mcpStateIsProblem,
  type McpRepoFileView,
  type McpServersView,
  type McpServerView,
  type OverridingEnvironment,
  readMcpRepoFileState,
  readMcpServerState,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

/** The keys an Environment's adjustment of a Global server holds. */
export type McpAdjustmentKey = (typeof MCP_ADJUSTMENT_KEYS)[number];

/** A `${NAME}` an entry reads, and where. */
export interface McpReference {
  readonly name: string;
  /** `env.KEY`, `headers.Key`, or `oauth.clientSecret`. */
  readonly where: string;
}

/** What a row is at its Scope: which marks and controls it has. */
export type McpRowKind =
  /** At Global: Global's own server. */
  | "global"
  /** At an Environment: a server it follows as it is, Global's or a Repo's (`isRepoRow`). */
  | "inherited"
  /** At an Environment: such a server with an adjustment of this Environment's. */
  | "adjusted"
  /** At an Environment: its own server, defined nowhere else. */
  | "own"
  /** At an Environment: its own server, replacing Global's of the same name. */
  | "replaces";

/** One server of the list. */
export interface McpRow {
  readonly name: string;
  readonly source: McpSource;
  /** The entry in force, with every default and adjustment applied. */
  readonly server: McpServerEntry;
  readonly kind: McpRowKind;
  readonly shadowed: ReadonlyArray<McpShadowed>;
  /**
   * The entry as written where it is defined (Global's, or the Environment's own); `${NAME}` kept. For a Repo's server,
   * the entry of its file as a copy keeps it: `cwd` made absolute, `allow` read as `ask`.
   */
  readonly written: Schema.JsonObject;
  /** The adjustment keys the Environment holds over Global's server; empty for any other row. */
  readonly adjusted: ReadonlyArray<McpAdjustmentKey>;
  /** At Global, the Environments that override it, by its entry or any adjustment key. */
  readonly overriddenIn: ReadonlyArray<OverridingEnvironment>;
  /** Its problems, each naming the source (`mcpProblemText`). */
  readonly problems: ReadonlyArray<McpProblemLine>;
  readonly hints: ReadonlyArray<string>;
  readonly references: ReadonlyArray<McpReference>;
}

/** A problem with no row to show it on: an entry that was left out, or an adjustment with no server. */
export interface McpProblemLine {
  readonly name: string | null;
  /** Where it is: "Global", "this environment", or the Repo. */
  readonly source: string;
  readonly message: string;
  /** For an orphaned adjustment, the Override fields whose Reset removes it. */
  readonly reset: ReadonlyArray<string>;
}

/** A problem as a row or the Problems list words it: where it is, then what is wrong. */
export const mcpProblemText = (line: McpProblemLine): string => `${line.source}: ${line.message}`;

/** Whether the row is a server defined at the Scope itself (Global's own at Global, an Environment's own entry). */
export const isOwnRow = (row: McpRow): boolean =>
  row.kind === "global" || row.kind === "own" || row.kind === "replaces";

/** Whether the row is a server the Environment follows, Global's or a Repo's, as it is or adjusted. */
export const isFollowedRow = (row: McpRow): boolean =>
  row.kind === "inherited" || row.kind === "adjusted";

/** Whether the row is a server of a Repo's `.pi/mcp.json`: read-only, adjusted or copied, never edited here. */
export const isRepoRow = (row: McpRow): boolean => row.source.kind === "repo";

/** The Repo's directory name of a Repo's server's row, or null for any other. */
export const repoDirectoryOf = (row: McpRow): string | null =>
  row.source.kind === "repo" ? row.source.directory : null;

/** A warning of the section. */
export type McpWarning = {
  readonly kind: "codemode-not-offered";
  /** The enabled servers with `codemode` Exposure. */
  readonly servers: ReadonlyArray<string>;
};

/** A Repo's file as the section lists it above the servers: what the Registry last saw, and what is wrong with it. */
export interface McpFileRow {
  readonly file: McpRepoFileView;
  /** Problems with the file as a whole: from the Registry's look at it (unreadable, too large) and from reading its text. */
  readonly problems: ReadonlyArray<McpProblemLine>;
}

/** What the page shows at a Scope. */
export interface McpScopeView {
  /** At an Environment, each Repo's file in the Environment's Repo order; none at Global, or until they are known. */
  readonly files: ReadonlyArray<McpFileRow>;
  readonly rows: ReadonlyArray<McpRow>;
  readonly problems: ReadonlyArray<McpProblemLine>;
  readonly warnings: ReadonlyArray<McpWarning>;
  /** What each layer holds, for the name rules of an Add. */
  readonly names: McpNames;
}

/** The names a name may not be, at the Scope: what each layer holds. */
export interface McpNames {
  /** Global's servers, by name. */
  readonly global: ReadonlyArray<string>;
  /** The Environment's own full entries; empty at Global. */
  readonly own: ReadonlyArray<string>;
  /** The names the Environment adjusts; empty at Global. */
  readonly adjusted: ReadonlyArray<string>;
}

/** What the page reads of the settings at a Scope. */
export interface McpScopeInput {
  readonly scope: string;
  /** Global's saved overrides document, as the Registry applies it. */
  readonly global: Schema.Json;
  /** Why some of Global's saved overrides are ignored, or undefined. */
  readonly globalProblem: string | undefined;
  /** The part of `globalProblem` that lies in a server's entry, structured; undefined from a Registry that does not say. */
  readonly globalMcpProblems?: ReadonlyArray<McpSettingsProblem> | undefined;
  /** The Environment's Overrides; null at Global. */
  readonly overrides: Schema.Json | null;
  readonly overridesProblem: string | undefined;
  /** The part of `overridesProblem` that lies in a server's entry, structured; undefined from a Registry that does not say. */
  readonly overridesMcpProblems?: ReadonlyArray<McpSettingsProblem> | undefined;
  /** `tools.offered` in force at the Scope. */
  readonly offered: ReadonlyArray<string>;
  /** At Global, the Environments that override each field. */
  readonly overriddenIn: Readonly<Record<string, ReadonlyArray<OverridingEnvironment>>>;
  /** Each Repo's file as the Registry last looked at it; none until they are known, and at Global. */
  readonly repoFiles?: ReadonlyArray<McpRepoFileView> | undefined;
}

/**
 * The Repo layers of the set that `files` make: each whose copy is held, a good read or the last one an unreadable Repo
 * keeps, and that is on GitHub (it has a slug). The Registry makes its set from the same rule (`mcpRepoLayers`), so the
 * page and the host see the same servers.
 */
export const mcpRepoLayersOf = (
  files: ReadonlyArray<McpRepoFileView>,
): ReadonlyArray<McpRepoLayer> =>
  Arr.filterMap(files, (file) => {
    const state = readMcpRepoFileState(file.state);

    return (state === "read" || state === "unreadable") &&
      file.text !== undefined &&
      file.slug !== undefined
      ? Result.succeed<McpRepoLayer>({
          directory: file.repo,
          slug: file.slug,
          path: file.path,
          text: file.text,
        })
      : Result.failVoid;
  });

/** Where `source` is, as a problem names it. */
export const mcpSourceName = (source: McpSource): string => {
  switch (source.kind) {
    case "global":
      return "Global";
    case "environment":
      return "this environment";
    case "repo":
      return `Repo ${source.directory} (${source.path})`;
  }
};

/** A Repo's file path in its Repo. */
const MCP_REPO_PATH = ".pi/mcp.json";

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Each `${NAME}` the values of `entry` (`env`, `headers`, and `oauth`'s two secrets) read, once per place. */
export const mcpReferencesOf = (entry: {
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly oauth?: { readonly clientSecret?: string; readonly privateKey?: string } | undefined;
}): ReadonlyArray<McpReference> => {
  const places: ReadonlyArray<readonly [string, string]> = [
    ...Arr.map(Record.toEntries(entry.env ?? {}), ([key, text]) => [`env.${key}`, text] as const),
    ...Arr.map(
      Record.toEntries(entry.headers ?? {}),
      ([key, text]) => [`headers.${key}`, text] as const,
    ),
    ...Arr.flatMap(["clientSecret", "privateKey"] as const, (key) => {
      const text = entry.oauth?.[key];

      return text === undefined ? [] : [[`oauth.${key}`, text] as const];
    }),
  ];

  return Arr.flatMap(places, ([where, text]) =>
    Arr.map(
      Arr.dedupe(Arr.map([...text.matchAll(REFERENCE)], ([, name]) => name ?? "")),
      (name): McpReference => ({ name, where }),
    ),
  );
};

/** The Secrets and Variables a `${NAME}` may name at the Scope, by name only: the page never has a value. */
export interface McpReferenceNames {
  readonly secrets: ReadonlyArray<string>;
  readonly variables: ReadonlyArray<string>;
}

/** What a `${NAME}` is at the Scope: a Secret (looked up first), a Variable, or missing. */
export const mcpReferenceKind = (
  name: string,
  names: McpReferenceNames,
): "secret" | "variable" | "missing" =>
  Arr.contains(names.secrets, name)
    ? "secret"
    : Arr.contains(names.variables, name)
      ? "variable"
      : "missing";

/** The references of `references` that name neither a Secret nor a Variable of the Scope. */
export const mcpMissingReferences = (
  references: ReadonlyArray<McpReference>,
  names: McpReferenceNames,
): ReadonlyArray<McpReference> =>
  Arr.filter(references, ({ name }) => mcpReferenceKind(name, names) === "missing");

/** The sentence that says an entry reads a `${NAME}` that this environment lacks. */
export const mcpMissingReferenceProblem = (reference: McpReference): string =>
  `${reference.where} reads \${${reference.name}}, which this environment has neither as a Secret nor as a Variable`;

/** The problems of row `row`: each of its references that `names` does not have, naming where the entry is. */
export const mcpMissingReferenceProblems = (
  row: McpRow,
  names: McpReferenceNames,
): ReadonlyArray<McpProblemLine> =>
  Arr.map(mcpMissingReferences(row.references, names), (reference) => ({
    name: row.name,
    source: mcpSourceName(row.source),
    message: mcpMissingReferenceProblem(reference),
    reset: [],
  }));

/**
 * The problems of a Repo's server `row` that read a `${NAME}` the Environment's Variables lack: a Repo's server gets no
 * Secrets (ADR-0029), so a name that is only a Secret is said so, with the way out; one that is nothing is missing.
 */
export const mcpRepoReferenceProblems = (
  row: McpRow,
  names: McpReferenceNames,
): ReadonlyArray<McpProblemLine> =>
  Arr.filterMap(row.references, (reference) => {
    if (Arr.contains(names.variables, reference.name)) return Result.failVoid;

    return Result.succeed<McpProblemLine>({
      name: row.name,
      source: mcpSourceName(row.source),
      message: Arr.contains(names.secrets, reference.name)
        ? `${reference.where} reads \${${reference.name}}, a Secret: a Repo's server gets no Secrets, so it is skipped. Copy it to this environment's Settings, or make it a Variable.`
        : `${reference.where} reads \${${reference.name}}, which this environment has no Variable for, so it is skipped`,
      reset: [],
    });
  });

const FORGOTTEN = "is not used and is forgotten by the next save: ";

const DROPPED_LINE = /^mcp\.servers\.([^.:\s]+)\.?([^:]*): (.*)$/;

/**
 * The lines about MCP servers in a Registry `problem` that comes with no `mcpProblems` (an older Registry): its text
 * ("These saved overrides no longer apply and are ignored:" and a line for each, `mcp.servers.<name>[.<keys>]: <text>`)
 * is all it says, so they are read from it, as problems of `source`.
 */
export const droppedMcpProblems = (
  problem: string | undefined,
  source: string,
): ReadonlyArray<McpProblemLine> =>
  Arr.filterMap((problem ?? "").split("\n"), (line) => {
    const found = DROPPED_LINE.exec(line);

    if (found === null) return Result.failVoid;

    const [, name = "", keys = "", text = ""] = found;

    return Result.succeed<McpProblemLine>({
      name,
      source,
      message: `${FORGOTTEN}${keys === "" ? "" : `${keys}: `}${text}`,
      reset: [],
    });
  });

const LAYER_NAMES: Readonly<Record<McpProblemSource, string>> = {
  global: "Global",
  environment: "this environment",
};

/**
 * The problems of entries a lenient read left out, as the Registry says them (`McpSettingsProblem`), each in its layer.
 * A problem in the document that was read is forgotten by that layer's next save; one in another known layer (a Global
 * server left out of an Environment's view, its twin name being the Environment's own) is that layer's, and says its own
 * words; one in a layer a later build adds is shown as that layer names itself, never as Global's.
 */
const savedProblemLines = (
  found: ReadonlyArray<McpSettingsProblem>,
  read: McpProblemSource,
): ReadonlyArray<McpProblemLine> =>
  Arr.map(found, (problem) => {
    const layer = readMcpProblemSource(problem.source);
    const where = Arr.join(problem.keys, ".");

    return {
      name: problem.name,
      source: layer === undefined ? problem.source : LAYER_NAMES[layer],
      message:
        layer === read
          ? `${FORGOTTEN}${where === "" ? "" : `${where}: `}${problem.message}`
          : problem.message,
      reset: problem.reset,
    };
  });

/** The `mcp.servers` of `document`, as written; none where it has none. */
export const mcpServersIn = (document: Schema.Json): Schema.JsonObject => {
  const servers = mcpServersOf(document);

  return isJsonObject(servers) ? servers : {};
};

const serverIn = (document: Schema.Json, name: string): Schema.Json | undefined =>
  mcpServersIn(document)[name];

const writtenEntry = (document: Schema.Json, name: string): Schema.JsonObject | undefined => {
  const written = serverIn(document, name);

  return isJsonObject(written) ? written : undefined;
};

/** The names of `document`'s full entries, or, with `adjustments`, of its adjustments. */
const namesIn = (document: Schema.Json, adjustments: boolean): ReadonlyArray<string> =>
  Arr.filterMap(Record.toEntries(mcpServersIn(document)), ([name, value]) =>
    isJsonObject(value) && isMcpFullEntry(value) !== adjustments
      ? Result.succeed(name)
      : Result.failVoid,
  );

const adjustmentKeysOf = (written: Schema.Json | undefined): ReadonlyArray<McpAdjustmentKey> =>
  isJsonObject(written)
    ? Arr.filter(MCP_ADJUSTMENT_KEYS, (key) => Predicate.hasProperty(written, key))
    : [];

/** The Environments of `overriddenIn` that override server `name`: by its entry or any one adjustment key, once each. */
const overridingEnvironments = (
  overriddenIn: McpScopeInput["overriddenIn"],
  name: string,
): ReadonlyArray<OverridingEnvironment> =>
  Arr.dedupeWith(
    Arr.flatMap(
      [
        `mcp.servers.${name}`,
        ...Arr.map(MCP_ADJUSTMENT_KEYS, (key) => `mcp.servers.${name}.${key}`),
      ],
      (field) => overriddenIn[field] ?? [],
    ),
    (left, right) => left.id === right.id,
  );

const byName = Order.mapInput(Order.String, (row: McpRow) => row.name.toLowerCase());

const problemLine = (problem: McpProblem): McpProblemLine => ({
  name: problem.name,
  source: mcpSourceName(problem.source),
  message: problem.message,
  reset: problem.reset ?? [],
});

/** Whether `offered` has a name or pattern that matches the `codemode` tool. */
const offersCodemode = (offered: ReadonlyArray<string>): boolean =>
  Arr.some(offered, (pattern) => matchesToolPattern(pattern, "codemode"));

/** The note on an owner's server that hides a Repo's entry of its name (or its twin): info, never a problem. */
const shadowedNote = (shadowed: McpShadowed): string =>
  `${mcpSourceName(shadowed.source)} has ${shadowed.name}, which this server hides${shadowed.differs ? " (it differs)" : ""}`;

/** The entry `name` of Repo `directory`'s file as a copy keeps it, as plain JSON; none gives `{}`. */
const repoEntryOf = (
  repoEntries: ReadonlyArray<{
    readonly directory: string;
    readonly entries: ReadonlyArray<McpNamedEntry>;
  }>,
  directory: string,
  name: string,
): Schema.JsonObject => {
  const found = Arr.findFirst(repoEntries, (held) => held.directory === directory).pipe(
    Option.flatMap(({ entries }) => Arr.findFirst(entries, (entry) => entry.name === name)),
  );

  // SAFETY: a decoded entry is plain JSON, which a copy writes out and the form reads back.
  return Option.isSome(found)
    ? (JSON.parse(JSON.stringify(found.value.value)) as Schema.JsonObject)
    : {};
};

/** The servers (and their problems) the page shows at the Scope, and the section's warnings. */
export const mcpScopeView = (input: McpScopeInput): McpScopeView => {
  const atGlobal = input.overrides === null;
  const overrides = input.overrides ?? {};
  const repoFiles = atGlobal ? [] : (input.repoFiles ?? []);
  const layers = mcpRepoLayersOf(repoFiles);
  const set = resolveMcpServerSet(input.global, overrides, layers);

  // The Repo entries as a copy keeps them, by Repo directory.
  const repoEntries = Arr.map(layers, (layer) => ({
    directory: layer.directory,
    entries: readMcpRepoFile(layer.text, layer.directory).entries,
  }));

  // The set names some of what the Registry's read left out too (a Global server shadowed by a twin name): once each.
  const lines: ReadonlyArray<McpProblemLine> = Arr.dedupeWith(
    [
      ...Arr.map(set.problems, problemLine),
      ...(input.globalMcpProblems === undefined
        ? droppedMcpProblems(input.globalProblem, "Global")
        : savedProblemLines(input.globalMcpProblems, "global")),
      ...(input.overridesMcpProblems === undefined
        ? droppedMcpProblems(input.overridesProblem, "this environment")
        : savedProblemLines(input.overridesMcpProblems, "environment")),
    ],
    (left, right) => left.name === right.name && mcpProblemText(left) === mcpProblemText(right),
  );

  const rows = Arr.map(set.servers, (resolved): McpRow => {
    const { name, source, server } = resolved;
    const own = source.kind === "environment";
    const document = own ? overrides : input.global;
    const adjusted = own || atGlobal ? [] : adjustmentKeysOf(serverIn(overrides, name));

    const written =
      source.kind === "repo"
        ? repoEntryOf(repoEntries, source.directory, name)
        : (writtenEntry(document, name) ?? {});

    return {
      name,
      source,
      server,
      kind: atGlobal
        ? "global"
        : own
          ? resolved.replacesGlobal
            ? "replaces"
            : "own"
          : adjusted.length > 0
            ? "adjusted"
            : "inherited",
      shadowed: resolved.shadowed,
      written,
      adjusted,
      overriddenIn: atGlobal ? overridingEnvironments(input.overriddenIn, name) : [],
      problems: Arr.filter(lines, (line) => line.name === name),
      hints: [
        ...Arr.map(
          Arr.filter(set.hints, (hint) => hint.name === name),
          (hint) => hint.message,
        ),
        ...Arr.map(resolved.shadowed, shadowedNote),
      ],
      references: mcpReferencesOf(
        server.type === "stdio"
          ? { env: server.env }
          : { headers: server.headers, oauth: server.oauth },
      ),
    };
  });

  const shown = new Set(Arr.map(rows, (row) => row.name));

  // A file's own problems are on its row, not under Problems.
  const ofFile = (line: McpProblemLine, directory: string): boolean =>
    line.name === null &&
    line.source === mcpSourceName({ kind: "repo", directory, slug: "", path: MCP_REPO_PATH });

  const files = Arr.map(repoFiles, (file): McpFileRow => {
    const source = mcpSourceName({ kind: "repo", directory: file.repo, slug: "", path: file.path });
    const state = readMcpRepoFileState(file.state);

    return {
      file,
      problems: [
        ...Arr.filter(lines, (line) => ofFile(line, file.repo)),
        ...(file.problem === undefined
          ? []
          : [{ name: null, source, message: file.problem, reset: [] }]),
        ...(state === "unknown"
          ? [
              {
                name: null,
                source,
                message: `is in a state this page does not know (${file.state})`,
                reset: [],
              },
            ]
          : []),
      ],
    };
  });

  const codemode = Arr.filterMap(rows, (row) =>
    row.server.enabled && row.server.exposure === "codemode"
      ? Result.succeed(row.name)
      : Result.failVoid,
  );

  return {
    files,
    rows: Arr.sort(rows, byName),
    problems: Arr.filter(
      lines,
      (line) =>
        (line.name === null || !shown.has(line.name)) &&
        !Arr.some(repoFiles, (file) => ofFile(line, file.repo)),
    ),
    warnings:
      codemode.length > 0 && !offersCodemode(input.offered)
        ? [{ kind: "codemode-not-offered", servers: codemode }]
        : [],
    names: {
      global: namesIn(input.global, false),
      own: namesIn(overrides, false),
      adjusted: namesIn(overrides, true),
    },
  };
};

/** A server's status chip: what the Registry's `mcpServers` says of its connection. */
export interface McpStatusChip {
  readonly label: string;
  /** Whether the owner should look at it: a failure, a sign-in, a refusal. */
  readonly problem: boolean;
}

/** The chip of server `view`: the words the transcript card uses (`Connected · 12 tools`, `Needs sign-in`, `Failed: …`). */
export const mcpStatusChip = (view: McpServerView): McpStatusChip => {
  const problem = mcpStateIsProblem(view.state);

  switch (readMcpServerState(view.state)) {
    case "connected":
      return {
        label: `Connected · ${view.counts.tools} ${view.counts.tools === 1 ? "tool" : "tools"}`,
        problem,
      };
    case "connecting":
      return { label: "Connecting", problem };
    case "sign_in":
      return { label: "Needs sign-in", problem };
    case "rejected":
      return { label: "Sign-in rejected", problem };
    case "unavailable":
      return { label: "Unavailable", problem };
    case "failed":
      return { label: view.error === undefined ? "Failed" : `Failed: ${view.error}`, problem };
    case "skipped":
      return { label: "Skipped", problem };
    case "disabled":
      return { label: "Off", problem };
    case "not_discovered":
      return { label: "Not checked", problem };
    case "unknown":
      return { label: "Unknown state", problem };
  }
};

/** What the page shows of the `mcpServers` answer: a chip per server by name, and a line when there is no list. */
export interface McpStatuses {
  readonly chips: Readonly<Record<string, McpStatusChip>>;
  /** Why there are no chips: the host did not answer. Null when it did, or there is no host to ask (Global). */
  readonly unavailable: string | null;
  /** The tools each server's host has discovered, by server name: suggestions for `toolExposure` keys. */
  readonly tools: Readonly<Record<string, ReadonlyArray<string>>>;
}

/** No status: at Global, which has no host, and before the answer. */
export const NO_MCP_STATUSES: McpStatuses = { chips: {}, unavailable: null, tools: {} };

/** The statuses `view` (an `mcpServers` answer) gives: chips for a list, a line for `Unavailable`, none for the rest. */
export const mcpStatuses = (view: McpServersView): McpStatuses =>
  Match.value(view).pipe(
    Match.tag("Servers", (list): McpStatuses => ({
      chips: Record.fromEntries(
        Arr.map(list.servers, (server) => [server.name, mcpStatusChip(server)] as const),
      ),
      unavailable: null,
      tools: Record.fromEntries(
        Arr.map(
          list.servers,
          (server) => [server.name, Arr.map(server.tools, ({ name }) => name)] as const,
        ),
      ),
    })),
    Match.tag("Unavailable", ({ message }): McpStatuses => ({
      ...NO_MCP_STATUSES,
      unavailable: message,
    })),
    Match.orElse(() => NO_MCP_STATUSES),
  );
