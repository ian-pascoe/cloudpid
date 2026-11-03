// @effect-diagnostics missingPipeableSignature:off -- builders of plain values, not combinators.

// The MCP servers section's rows (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers" section): what
// the page shows of the servers at a Scope, resolved from the two documents the Registry hands the page, as the Registry
// resolves the set (`resolveMcpServerSet`, which reads every layer as the Settings read it). Pure: the section's
// components, tests and writes all read this one view.
//
// As built: a Repo's `.pi/mcp.json` is not read here (#468): `repos` is the seam, an empty list until that ticket gives the
// page the Repo layers, and a row's `source` already names a Repo's.

import {
  isMcpFullEntry,
  MCP_ADJUSTMENT_KEYS,
  type McpProblem,
  type McpRepoLayer,
  type McpServerEntry,
  type McpShadowed,
  type McpSource,
  matchesToolPattern,
  mcpServersOf,
  resolveMcpServerSet,
} from "@cloudpid/config";
import {
  mcpStateIsProblem,
  type McpServersView,
  type McpServerView,
  type OverridingEnvironment,
  readMcpServerState,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
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
  /** At an Environment: Global's server, followed as it is. */
  | "inherited"
  /** At an Environment: Global's server with an adjustment of this Environment's. */
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
  /** The entry as written where it is defined (Global's, or the Environment's own); `${NAME}` kept. */
  readonly written: Schema.JsonObject;
  /** The adjustment keys the Environment holds over Global's server; empty for any other row. */
  readonly adjusted: ReadonlyArray<McpAdjustmentKey>;
  /** At Global, the Environments that override it, by its entry or any adjustment key. */
  readonly overriddenIn: ReadonlyArray<OverridingEnvironment>;
  /** Its problems, each naming the source. */
  readonly problems: ReadonlyArray<string>;
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

/** A warning of the section. */
export type McpWarning = {
  readonly kind: "codemode-not-offered";
  /** The enabled servers with `codemode` Exposure. */
  readonly servers: ReadonlyArray<string>;
};

/** What the page shows at a Scope. */
export interface McpScopeView {
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
  /** The Environment's Overrides; null at Global. */
  readonly overrides: Schema.Json | null;
  readonly overridesProblem: string | undefined;
  /** `tools.offered` in force at the Scope. */
  readonly offered: ReadonlyArray<string>;
  /** At Global, the Environments that override each field. */
  readonly overriddenIn: Readonly<Record<string, ReadonlyArray<OverridingEnvironment>>>;
  /** Each Repo's file as last read: the seam of the Repo rows (#468). */
  readonly repos?: ReadonlyArray<McpRepoLayer>;
}

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

/** The sentence that says a row reads a `${NAME}` that this environment lacks. */
export const mcpMissingReferenceProblem = (reference: McpReference): string =>
  `${reference.where} reads \${${reference.name}}, which this environment has neither as a Secret nor as a Variable`;

const DROPPED_LINE = /^mcp\.servers\.([^.:\s]+)\.?([^:]*): (.*)$/;

/**
 * The lines about MCP servers in a Registry `problem` ("These saved overrides no longer apply and are ignored:" and a line
 * for each, `mcp.servers.<name>[.<keys>]: <text>`), as problems of `source`.
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
      message: `is not used and is forgotten by the next save: ${keys === "" ? "" : `${keys}: `}${text}`,
      reset: [],
    });
  });

const isObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

/** The `mcp.servers` of `document`, as written; none where it has none. */
export const mcpServersIn = (document: Schema.Json): Schema.JsonObject => {
  const servers = mcpServersOf(document);

  return isObject(servers) ? servers : {};
};

const serverIn = (document: Schema.Json, name: string): Schema.Json | undefined =>
  mcpServersIn(document)[name];

const writtenEntry = (document: Schema.Json, name: string): Schema.JsonObject | undefined => {
  const written = serverIn(document, name);

  return isObject(written) ? written : undefined;
};

/** The names of `document`'s full entries, or, with `adjustments`, of its adjustments. */
const namesIn = (document: Schema.Json, adjustments: boolean): ReadonlyArray<string> =>
  Arr.filterMap(Record.toEntries(mcpServersIn(document)), ([name, value]) =>
    isObject(value) && isMcpFullEntry(value) !== adjustments
      ? Result.succeed(name)
      : Result.failVoid,
  );

const adjustmentKeysOf = (written: Schema.Json | undefined): ReadonlyArray<McpAdjustmentKey> =>
  isObject(written)
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

/** The servers (and their problems) the page shows at the Scope, and the section's warnings. */
export const mcpScopeView = (input: McpScopeInput): McpScopeView => {
  const atGlobal = input.overrides === null;
  const overrides = input.overrides ?? {};
  const set = resolveMcpServerSet(input.global, overrides, input.repos ?? []);

  const lines: ReadonlyArray<McpProblemLine> = [
    ...Arr.map(set.problems, problemLine),
    ...droppedMcpProblems(input.globalProblem, "Global"),
    ...droppedMcpProblems(input.overridesProblem, "this environment"),
  ];

  const rows = Arr.map(set.servers, (resolved): McpRow => {
    const { name, source, server } = resolved;
    const own = source.kind === "environment";
    const document = own ? overrides : input.global;
    const adjusted = own || atGlobal ? [] : adjustmentKeysOf(serverIn(overrides, name));

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
      written: writtenEntry(document, name) ?? {},
      adjusted,
      overriddenIn: atGlobal ? overridingEnvironments(input.overriddenIn, name) : [],
      problems: Arr.map(
        Arr.filter(lines, (line) => line.name === name),
        (line) => `${line.source}: ${line.message}`,
      ),
      hints: Arr.map(
        Arr.filter(set.hints, (hint) => hint.name === name),
        (hint) => hint.message,
      ),
      references: resolved.resolvesSecrets
        ? mcpReferencesOf(
            server.type === "stdio"
              ? { env: server.env }
              : { headers: server.headers, oauth: server.oauth },
          )
        : [],
    };
  });

  const shown = new Set(Arr.map(rows, (row) => row.name));

  const codemode = Arr.filterMap(rows, (row) =>
    row.server.enabled && row.server.exposure === "codemode"
      ? Result.succeed(row.name)
      : Result.failVoid,
  );

  return {
    rows: Arr.sort(rows, byName),
    problems: Arr.filter(lines, (line) => line.name === null || !shown.has(line.name)),
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
