// What the Registry tells a Session of an MCP server set, for the agent's read-only `settings_mcp_list`, `settings_mcp_get`
// and `settings_mcp_reload` (`docs/architecture/mcp-configuration.md` → The agent's changes → The tools, Lists, and the
// _As built_ there). Pure over the store's rows and the sign-ins' records, so it is tested without a Durable Object.
//
// It reads and never writes (but for a reload, which only looks at the Repos' files as the scheduled looks do), asks the
// host nothing and resolves no `${NAME}`: each name an entry reads is marked `secret`, `variable` or `missing` by the
// names the Environment has, never by a value. Nothing it returns holds a hash, a value, a token, a URL of a sign-in or
// a Repo file's text (`SettingsMcpView`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over values, not combinators.
import {
  MCP_ADJUSTMENT_KEYS,
  matchesToolPattern,
  type McpHint,
  type McpOrphan,
  type McpProblem,
  type McpResolvedServer,
  type McpServerEntry,
  type McpServerValue,
  type McpSource,
  mcpServersOf,
  normalizeMcpName,
  readMcpLayer,
  readMcpRepoFile,
  resolveMcpServerSet,
  resolveOverridesLeniently,
  sortedJson,
} from "@cloudpid/config";
import {
  readMcpRepoFileState,
  type SettingsMcpEnvironment,
  type SettingsMcpKeyFrom,
  type SettingsMcpKeyOrigins,
  type SettingsMcpLayers,
  type SettingsMcpRead,
  type SettingsMcpReload,
  type SettingsMcpReloadOutcome,
  type SettingsMcpReloadRepo,
  type SettingsMcpRepo,
  type SettingsMcpServer,
  type SettingsMcpSignIn,
  type SettingsMcpView,
  type SettingsMcpWritten,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import type { Mutable } from "effect/Types";
import { environmentSettingsOf, readGlobal } from "./global.ts";
import type { McpSetStore } from "./mcp-registry.ts";
import { mcpDefinedIn } from "./mcp-change-check.ts";
import { mcpRepoFileViews, mcpRepoLayers } from "./mcp-repo-files.ts";
import { hostOf } from "./mcp-sign-in-flow.ts";
import { signInTargetOf, signInUseOf } from "./mcp-sign-in-registry.ts";
import type { McpSignIns } from "./mcp-sign-ins.ts";
import { mcpLayersOf, readSettings, savedGlobalSettings } from "./settings.ts";
import type { RegistryStore } from "./store.ts";

/** The store as the views read it: what the set reads, and the Environments' Secrets and Overrides. */
export type McpSettingsStore = McpSetStore &
  Pick<RegistryStore, "listSettingsOverrides" | "getEnvironmentSecrets" | "listEnvironmentSecrets">;

/** What the views read of the sign-ins: the one a key hash names. */
export type McpSettingsSignIns = Pick<McpSignIns, "get">;

type RepoSource = Extract<McpSource, { readonly kind: "repo" }>;

/** `Global`, the name the Scope `*` goes by. */
const GLOBAL_NAME = "Global";

/** The Scope of Global. */
const GLOBAL_SCOPE_ID = "*";

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The names an entry reads, with where in the entry each is read, by name. */
const referencesOf = (entry: McpServerEntry): ReadonlyArray<readonly [string, string]> => {
  const found: Array<readonly [string, string]> = [];

  const scan = (where: string, text: string | undefined) => {
    for (const match of (text ?? "").matchAll(REFERENCE)) {
      const [, name] = match;

      if (name !== undefined) found.push([name, where]);
    }
  };

  if (entry.type === "stdio") {
    for (const [key, text] of Record.toEntries(entry.env)) scan(`env.${key}`, text);
  } else {
    for (const [key, text] of Record.toEntries(entry.headers)) scan(`headers.${key}`, text);

    scan("oauth.clientSecret", entry.oauth?.clientSecret);
    scan("oauth.privateKey", entry.oauth?.privateKey);
  }

  return found;
};

/** The names a Scope has: its Secrets and its Variables in force. */
type Names = { readonly secrets: ReadonlySet<string>; readonly variables: ReadonlySet<string> };

const environmentNames = (store: McpSettingsStore, environment: string): Names => ({
  secrets: new Set(Arr.map(store.getEnvironmentSecrets(environment), ({ name }) => name)),
  variables: new Set(
    Record.keys(environmentSettingsOf(store, environment)?.settings.variables ?? {}),
  ),
});

const globalNames = (store: McpSettingsStore): Names => ({
  secrets: new Set(
    Arr.filterMap(store.listEnvironmentSecrets(), (record) =>
      record.environment === null ? Result.succeed(record.name) : Result.failVoid,
    ),
  ),
  variables: new Set(Record.keys(readGlobal(store).settings.variables)),
});

/** What `name` is, read by an entry that may (`secrets`) or may not read Secrets: a Secret wins over a Variable. */
const kindOf = (names: Names, name: string, secrets: boolean): SettingsMcpRead["kind"] => {
  if (secrets && names.secrets.has(name)) return "secret";

  return names.variables.has(name) ? "variable" : "missing";
};

/**
 * What each of `names` is where an agent's MCP entry at `environment` (`undefined`: Global, which has no Secrets or Variables
 * of its own to resolve against but each Environment's) reads it: a Secret, a Variable or missing, by name only. An MCP
 * server of the Settings reads Secrets, and a Secret wins over a Variable of the same name.
 */
export const mcpNameKinds = (
  store: McpSettingsStore,
  environment: string,
  names: ReadonlyArray<string>,
): ReadonlyArray<{ readonly name: string; readonly kind: SettingsMcpRead["kind"] }> => {
  const held = environmentNames(store, environment);

  return Arr.map(names, (name) => ({ name, kind: kindOf(held, name, true) }));
};

/** Each `${NAME}` the server's entry reads, by name, marked by what `names` has; at Global, with where it is missing. */
const readsOf = (
  resolved: McpResolvedServer,
  names: Names,
  missingIn: (name: string) => ReadonlyArray<SettingsMcpEnvironment> | undefined,
): ReadonlyArray<SettingsMcpRead> => {
  const grouped = Arr.groupBy(referencesOf(resolved.server), ([name]) => name);

  return Arr.sort(
    Arr.map(Record.toEntries(grouped), ([name, uses]): SettingsMcpRead => {
      const where = Arr.sort(Arr.dedupe(Arr.map(uses, ([, at]) => at)), Order.String);

      const kind = kindOf(names, name, resolved.resolvesSecrets);
      const missing = missingIn(name);

      return missing === undefined
        ? { name, kind, where }
        : { name, kind, where, missingIn: missing };
    }),
    Order.mapInput(Order.String, ({ name }: SettingsMcpRead) => name),
  );
};

/** The sign-in the server's entry uses, by the key the host's token asks are made under; null for none or no row. */
const signInOf = (
  resolved: McpResolvedServer,
  signIns: McpSettingsSignIns,
): SettingsMcpSignIn | null => {
  const used = signInUseOf(signInTargetOf(resolved));

  if (used === undefined) return null;

  const row = signIns.get(used.hash);

  return row === null
    ? null
    : {
        status: row.status,
        issuerHost: row.issuer === null ? null : hostOf(row.issuer),
        scopes: row.scope,
        clientKind: row.client?.kind ?? null,
      };
};

/** One layer's entries and adjustments, and the Repos' files, as written: what a server's keys come from. */
type Written = {
  readonly global: ReturnType<typeof readMcpLayer>;
  readonly environment: ReturnType<typeof readMcpLayer>;
  readonly repos: ReadonlyArray<{
    readonly source: RepoSource;
    readonly entries: ReadonlyArray<{ readonly name: string; readonly value: McpServerValue }>;
  }>;
};

const isFull = (value: McpServerValue): boolean =>
  value.command !== undefined || value.url !== undefined;

const writtenOf = (
  layers: {
    readonly global: Schema.Json;
    readonly overrides: Schema.Json;
    readonly repos: ReturnType<typeof mcpRepoLayers>;
  },
  global: boolean,
): Written => ({
  global: readMcpLayer(mcpServersOf(layers.global), "global"),
  environment: global
    ? readMcpLayer(undefined, "environment")
    : readMcpLayer(mcpServersOf(layers.overrides), "environment"),
  repos: Arr.map(layers.repos, (layer) => ({
    source: {
      kind: "repo" as const,
      directory: layer.directory,
      slug: layer.slug,
      path: layer.path,
    },
    entries: readMcpRepoFile(layer.text, layer.directory).entries,
  })),
});

const named = (
  entries: ReadonlyArray<{ readonly name: string; readonly value: McpServerValue }>,
  name: string,
) => Arr.findFirst(entries, (entry) => entry.name === name).pipe(Option.map(({ value }) => value));

/** The entry that defines `resolved`, as its layer wrote it. */
const definingEntry = (
  resolved: McpResolvedServer,
  written: Written,
): McpServerValue | undefined => {
  const { source } = resolved;

  if (source.kind === "global")
    return Option.getOrUndefined(named(written.global.entries, resolved.name));

  if (source.kind === "environment") {
    return Option.getOrUndefined(named(written.environment.entries, resolved.name));
  }

  return Option.getOrUndefined(
    Option.flatMap(
      Arr.findFirst(
        written.repos,
        ({ source: repo }) => source.kind === "repo" && repo.directory === source.directory,
      ),
      ({ entries }) => named(entries, resolved.name),
    ),
  );
};

/** Where each of the keys an adjustment may hold is written, for the server `resolved`. */
const originsOf = (resolved: McpResolvedServer, written: Written): SettingsMcpKeyOrigins => {
  const base = definingEntry(resolved, written);
  const adjusted = Option.getOrUndefined(named(written.environment.adjustments, resolved.name));

  const repoAdjusted = Arr.flatMap(written.repos, ({ entries }) =>
    Arr.filter(Option.toArray(named(entries, resolved.name)), (value) => !isFull(value)),
  );

  const from = (key: (typeof MCP_ADJUSTMENT_KEYS)[number]): SettingsMcpKeyFrom => {
    if (adjusted?.[key] !== undefined) return "environment_adjustment";

    if (Arr.some(repoAdjusted, (value) => value[key] !== undefined)) return "repo_adjustment";

    return base?.[key] === undefined ? "default" : resolved.source.kind;
  };

  return {
    enabled: from("enabled"),
    exposure: from("exposure"),
    toolExposure: from("toolExposure"),
  };
};

/** The Override fields `settings_reset` takes for `name`: the keys of the Environment's adjustment of it. */
const resetFieldsOf = (name: string, written: Written): ReadonlyArray<string> =>
  Option.match(named(written.environment.adjustments, name), {
    onNone: () => [],
    onSome: (value) =>
      Arr.map(
        Arr.filter(MCP_ADJUSTMENT_KEYS, (key) => value[key] !== undefined),
        (key) => `mcp.servers.${name}.${key}`,
      ),
  });

/** The Environments whose layer holds `name` as an entry or an adjustment, from their saved Overrides. */
const holdersOf = (store: McpSettingsStore, name: string) => {
  const overriding: Array<SettingsMcpEnvironment> = [];
  const adjusting: Array<SettingsMcpEnvironment> = [];

  for (const { id, name: label, overrides } of store.listSettingsOverrides()) {
    const layer = readMcpLayer(mcpServersOf(overrides), "environment");

    if (Option.isSome(named(layer.entries, name))) overriding.push({ id, name: label });

    if (Option.isSome(named(layer.adjustments, name))) adjusting.push({ id, name: label });
  }

  return { overriding, adjusting };
};

/** Whether `offered` has a name or pattern that matches the `codemode` tool. */
const offersCodemode = (offered: ReadonlyArray<string>): boolean =>
  Arr.some(offered, (pattern) => matchesToolPattern(pattern, "codemode"));

/** The words a problem's source goes by in a line. */
const sourceWords = (source: McpSource): string => {
  switch (source.kind) {
    case "repo":
      return `Repo ${source.directory} (${source.path})`;
    case "global":
      return "Global";
    case "environment":
      return "this Environment";
  }
};

/** A problem as a line: where, which server, what. Also what a reload compares problems by. */
export const mcpProblemLine = ({ source, name, message }: McpProblem): string =>
  `${sourceWords(source)}: ${name === null ? "the file" : name} ${message}`;

/** The layers of server `resolved` as written, shadowed Repo entries included. */
const layersOf = (resolved: McpResolvedServer, written: Written): SettingsMcpLayers => {
  const plain = (value: McpServerValue): Schema.Json => JSON.parse(JSON.stringify(value));

  const entryOrAdjustment = (value: McpServerValue): SettingsMcpWritten => ({
    kind: isFull(value) ? "entry" : "adjustment",
    value: plain(value),
  });

  const twin = normalizeMcpName(resolved.name);

  const globalEntry = Option.getOrUndefined(named(written.global.entries, resolved.name));

  const environmentValue =
    Option.getOrUndefined(named(written.environment.entries, resolved.name)) ??
    Option.getOrUndefined(named(written.environment.adjustments, resolved.name));

  return {
    global: globalEntry === undefined ? null : entryOrAdjustment(globalEntry),
    environment: environmentValue === undefined ? null : entryOrAdjustment(environmentValue),
    repos: Arr.flatMap(written.repos, ({ source, entries }) =>
      Arr.filterMap(entries, ({ name, value }) =>
        normalizeMcpName(name) === twin
          ? Result.succeed({
              ...entryOrAdjustment(value),
              source,
              name,
              shadowed: Arr.some(
                resolved.shadowed,
                (hidden) => hidden.source.directory === source.directory && hidden.name === name,
              ),
            })
          : Result.failVoid,
      ),
    ),
  };
};

/** The Repos' files as the view lists them: each as last looked at, without its text. */
const reposOf = (
  store: McpSettingsStore,
  environment: string,
  now: number,
): ReadonlyArray<SettingsMcpRepo> =>
  Arr.map(mcpRepoFileViews(store, environment, now) ?? [], ({ text: _text, ...view }) => view);

/**
 * The MCP servers of a Scope for the agent: `environment`'s whole set, or Global's own entries when absent (a Repo's files
 * and the adjustments have no place at Global). With `name`, only that server, with its layers as written. Null when no
 * Environment has the id. Never a value, a hash or a file's text.
 */
export const mcpSettingsView = (
  store: McpSettingsStore,
  signIns: McpSettingsSignIns,
  input: { readonly environment: string | undefined; readonly name?: string | undefined },
  now: number,
): SettingsMcpView | null => {
  const { environment } = input;
  const global = environment === undefined;
  const overrides = global ? {} : store.getSettingsOverrides(environment);

  if (overrides === null) return null;

  const layers = mcpLayersOf(store, overrides, global ? [] : mcpRepoLayers(store, environment));

  const set = resolveMcpServerSet(layers.global, layers.overrides, layers.repos);
  const written = writtenOf(layers, global);
  const names = global ? globalNames(store) : environmentNames(store, environment);

  // At Global, where each name an entry reads is neither a Secret nor a Variable: the Environments that would lack it.
  const lacking = global
    ? Arr.map(store.listEnvironments(), (each) => ({
        id: each.id,
        name: each.name,
        names: environmentNames(store, each.id),
      }))
    : [];

  const missingIn = (name: string): ReadonlyArray<SettingsMcpEnvironment> | undefined =>
    global
      ? Arr.map(
          Arr.filter(lacking, (each) => kindOf(each.names, name, true) === "missing"),
          ({ id, name: label }) => ({ id, name: label }),
        )
      : undefined;

  const asked = input.name === undefined ? undefined : input.name;

  const shown =
    asked === undefined ? set.servers : Arr.filter(set.servers, (each) => each.name === asked);

  const serverOf = (resolved: McpResolvedServer): SettingsMcpServer => {
    const view: SettingsMcpServer = {
      server: resolved,
      origins: originsOf(resolved, written),
      reads: readsOf(resolved, names, missingIn),
      resetFields: global ? [] : resetFieldsOf(resolved.name, written),
      signIn: signInOf(resolved, signIns),
      hints: Arr.filter(set.hints, (hint: McpHint) => hint.name === resolved.name),
      problems: Arr.filter(set.problems, (problem) => problem.name === resolved.name),
    };

    if (!global) return view;

    const { overriding, adjusting } = holdersOf(store, resolved.name);

    return { ...view, overriddenIn: overriding, adjustedIn: adjusting };
  };

  const offered = global
    ? readSettings(store).settings.tools.offered
    : resolveOverridesLeniently(savedGlobalSettings(store), overrides).settings.tools.offered;

  const codemode = Arr.filter(
    set.servers,
    (each) => each.server.enabled && each.server.exposure === "codemode",
  );

  const warnings =
    codemode.length > 0 && !offersCodemode(offered)
      ? [
          `${Arr.join(
            Arr.map(codemode, (each) => each.name),
            ", ",
          )} ${codemode.length === 1 ? "has" : "have"} codemode Exposure, but codemode is not offered at this Scope (tools.offered): ${codemode.length === 1 ? "its tools are" : "their tools are"} reached with tool_search, or settings_tool_offer offers codemode.`,
        ]
      : [];

  const found = asked === undefined ? undefined : Arr.head(shown);

  const view: Mutable<SettingsMcpView> = {
    scope: global ? GLOBAL_SCOPE_ID : environment,
    name: global ? GLOBAL_NAME : (store.getEnvironment(environment)?.name ?? environment),
    servers: Arr.map(shown, serverOf),
    names: asked === undefined ? [] : Arr.map(set.servers, (each) => each.name),
    layers: found === undefined || Option.isNone(found) ? null : layersOf(found.value, written),
    repos: global ? [] : reposOf(store, environment, now),
    orphans: set.orphans,
    problems: set.problems,
    offered,
    warnings,
  };

  // A name Global has no entry of may be defined in an Environment (its own entry, or a Repo's): which ones.
  if (global && asked !== undefined && shown.length === 0) {
    view.definedIn = mcpDefinedIn(store, asked);
  }

  return view;
};

/** What a reload compares before and after the look: the servers in force, the problems and the Repos' files. */
export type McpReloadSnapshot = {
  readonly servers: ReadonlyArray<McpResolvedServer>;
  readonly problems: ReadonlyArray<McpProblem>;
  readonly repos: ReadonlyArray<SettingsMcpRepo & { readonly text?: string | undefined }>;
  readonly name: string;
};

/** `environment`'s set as a reload sees it; null when no Environment has the id. */
export const mcpReloadSnapshot = (
  store: McpSettingsStore,
  environment: string,
  now: number,
): McpReloadSnapshot | null => {
  const overrides = store.getSettingsOverrides(environment);
  const files = mcpRepoFileViews(store, environment, now);

  if (overrides === null || files === null) return null;

  const layers = mcpLayersOf(store, overrides, mcpRepoLayers(store, environment));
  const set = resolveMcpServerSet(layers.global, layers.overrides, layers.repos);

  return {
    servers: set.servers,
    problems: set.problems,
    repos: files,
    name: store.getEnvironment(environment)?.name ?? environment,
  };
};

/** A server's entry in force and its source, as text that two equal entries share. */
const entryKey = ({ source, server }: McpResolvedServer): string =>
  JSON.stringify(sortedJson(JSON.parse(JSON.stringify({ source, server }))));

/**
 * What a reload made of one Repo's file, from the file's row before the look and after it. A row whose look time did not
 * move was not looked at again: `recent` (the 30 s throttle, shared with the scheduled looks).
 */
const outcomeOf = (
  before: McpReloadSnapshot["repos"][number],
  after: McpReloadSnapshot["repos"][number],
): SettingsMcpReloadOutcome => {
  if (before.lookedAt !== undefined && before.lookedAt === after.lookedAt) return "recent";

  switch (readMcpRepoFileState(after.state)) {
    case "not_github":
      return "not_github";
    case "absent":
      return "absent";
    case "oversize":
      return "invalid";
    case "unreadable":
      return "unreadable";
    case "read": {
      const parsed = after.text === undefined ? undefined : readMcpRepoFile(after.text, after.repo);

      if (parsed?.problems.some((problem) => problem.name === null) === true) return "invalid";

      return before.blob === after.blob ? "unchanged" : "changed";
    }

    case "never":
    case "unknown":
      return "unchanged";
  }
};

/** What a reload found, from the set and the files before and after it looked at the Repos. */
export const mcpReloadReport = (
  environment: string,
  before: McpReloadSnapshot,
  after: McpReloadSnapshot,
): SettingsMcpReload => {
  const had = new Map(Arr.map(before.servers, (each) => [each.name, entryKey(each)] as const));
  const has = new Map(Arr.map(after.servers, (each) => [each.name, entryKey(each)] as const));

  const lines = (problems: ReadonlyArray<McpProblem>) => new Set(Arr.map(problems, mcpProblemLine));
  const hadProblems = lines(before.problems);
  const hasProblems = lines(after.problems);

  return {
    scope: environment,
    name: after.name,
    servers: after.servers.length,
    repos: Arr.map(after.repos, (file): SettingsMcpReloadRepo => {
      const earlier = Arr.findFirst(before.repos, (each) => each.repo === file.repo).pipe(
        Option.getOrElse((): McpReloadSnapshot["repos"][number] => ({
          repo: file.repo,
          path: file.path,
          state: "never",
        })),
      );

      return {
        directory: file.repo,
        slug: file.slug ?? null,
        path: file.path,
        outcome: outcomeOf(earlier, file),
        blob: file.blob ?? null,
        readAt: file.readAt ?? null,
        error: file.error ?? null,
        errorSince: file.errorSince ?? null,
        keptCopy: readMcpRepoFileState(file.state) === "unreadable" && file.text !== undefined,
        problem: file.problem ?? null,
      };
    }),
    set: {
      added: Arr.filter(Arr.fromIterable(has.keys()), (name) => !had.has(name)),
      removed: Arr.filter(Arr.fromIterable(had.keys()), (name) => !has.has(name)),
      changed: Arr.filter(
        Arr.fromIterable(has.keys()),
        (name) => had.has(name) && had.get(name) !== has.get(name),
      ),
      problemsAdded: Arr.filter(Arr.fromIterable(hasProblems), (line) => !hadProblems.has(line)),
      problemsCleared: Arr.filter(Arr.fromIterable(hadProblems), (line) => !hasProblems.has(line)),
    },
  };
};

/** The orphaned adjustments, for a caller that lists them. */
export type { McpOrphan };
