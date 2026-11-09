// What the Registry tells a Session of the MCP servers of one Scope, for the agent's read-only `settings_mcp_*` tools
// (`docs/architecture/mcp-configuration.md` → The agent's changes → Lists, Results; `docs/architecture/agent-changes.md` →
// MCP server changes): the Scope's servers as `resolveMcpServerSet` resolves them, with where each key comes from, what
// each `${NAME}` reads, the MCP sign-in it uses, its problems, each Repo's file as last looked at, and what a reload found.
// The Session adds what the Registry does not have, the host's inventory, and cuts and words it for the model.
//
// Plain data between two objects of one deploy, over Durable Object RPC: nothing here crosses to a client. It never holds
// a resolved `${NAME}` value, a hash, a token or a Repo file's text, so no tool built on it can show one: an entry is
// as written, `${NAME}` unresolved. Every view only gains (`docs/architecture/mcp.md` → Deploys): a field a later build adds
// is ignored by one that does not know it, and a string where a state is (`McpRepoFileState`) reads as `unknown`.
import type {
  McpHint,
  McpOrphan,
  McpProblem,
  McpResolvedServer,
  McpSource,
  McpWidening,
} from "@cloudpid/config";
import type * as Schema from "effect/Schema";
import type { McpRepoFileView } from "./mcp-repo-files.ts";

/** An Environment, by id and name. */
export type SettingsMcpEnvironment = { readonly id: string; readonly name: string };

/** What a `${NAME}` an entry reads is, in the Scope it is read in. */
export type SettingsMcpReadKind = "secret" | "variable" | "missing";

/**
 * One `${NAME}` that a server's entry reads, and where in the entry (`env.TOKEN`, `headers.Authorization`,
 * `oauth.clientSecret`). Never its value. A Repo's entry reads Variables only, so a name that is only a Secret is
 * `missing` for it (the server is skipped).
 */
export type SettingsMcpRead = {
  readonly name: string;
  readonly kind: SettingsMcpReadKind;
  readonly where: ReadonlyArray<string>;
  /** At Global: the Environments where the name is neither a Secret nor a Variable, in the order the Registry lists them. */
  readonly missingIn?: ReadonlyArray<SettingsMcpEnvironment> | undefined;
};

/**
 * Where the value in force of `enabled`, `exposure` or `toolExposure` is written: `default` (nowhere), the entry that
 * defines the server (`global`, `environment`, `repo`), or an adjustment over it (`environment_adjustment`,
 * `repo_adjustment`).
 */
export type SettingsMcpKeyFrom =
  | "default"
  | "global"
  | "environment"
  | "repo"
  | "environment_adjustment"
  | "repo_adjustment";

/** Where each of the keys an adjustment may hold is written. */
export type SettingsMcpKeyOrigins = {
  readonly enabled: SettingsMcpKeyFrom;
  readonly exposure: SettingsMcpKeyFrom;
  readonly toolExposure: SettingsMcpKeyFrom;
};

/** What the Registry says of the MCP sign-in a server uses (no token, no URL: the host of its issuer only). */
export type SettingsMcpSignIn = {
  /** `ok`, `required`, `step_up`, `rejected` or `refresh_failing`; a string, so a status a later build adds reads as itself. */
  readonly status: string;
  readonly issuerHost: string | null;
  /** The scopes granted, space-separated; null for none. */
  readonly scopes: string | null;
  /** `configured`, `document`, `registered` or `client_grant`; null for a row that only remembers a challenge. */
  readonly clientKind: string | null;
};

/** One MCP server of a Scope's set, with what the Registry knows of it beside the entry. */
export type SettingsMcpServer = {
  /** The resolved server: its name, source, entry in force (`${NAME}` unresolved), what it replaces and shadows. */
  readonly server: McpResolvedServer;
  readonly origins: SettingsMcpKeyOrigins;
  readonly reads: ReadonlyArray<SettingsMcpRead>;
  /** The Override fields an Environment holds for the server that `settings_reset` takes (its adjustment keys); none at Global. */
  readonly resetFields: ReadonlyArray<string>;
  readonly signIn: SettingsMcpSignIn | null;
  readonly hints: ReadonlyArray<McpHint>;
  /** The problems whose entry is this server's (by name), wherever they come from. */
  readonly problems: ReadonlyArray<McpProblem>;
  /** At Global: the Environments with their own full entry of the name, which replaces Global's there. */
  readonly overriddenIn?: ReadonlyArray<SettingsMcpEnvironment> | undefined;
  /** At Global: the Environments that adjust Global's server (`enabled`, `exposure`, `toolExposure`). */
  readonly adjustedIn?: ReadonlyArray<SettingsMcpEnvironment> | undefined;
};

/** A Repo's file as last looked at, without its text. */
export type SettingsMcpRepo = Omit<McpRepoFileView, "text">;

/** An entry or an adjustment of one layer, as written (decoded: unknown keys are not here). */
export type SettingsMcpWritten = {
  readonly kind: "entry" | "adjustment";
  readonly value: Schema.Json;
};

/** One server's layers as written, shadowed Repo entries included (`settings_mcp_get`). */
export type SettingsMcpLayers = {
  readonly global: SettingsMcpWritten | null;
  readonly environment: SettingsMcpWritten | null;
  readonly repos: ReadonlyArray<
    SettingsMcpWritten & {
      readonly source: Extract<McpSource, { readonly kind: "repo" }>;
      /** The name as the Repo's file spells it. */
      readonly name: string;
      /** An owner's entry of the name (or its twin) hides it. */
      readonly shadowed: boolean;
    }
  >;
};

/**
 * `mcpSettingsView`'s answer: the Scope's MCP servers (only the one asked for, with its `layers`, when a name is given), its
 * Repos' files, the adjustments with no server, the problems of the whole set and the warnings. Null from the Registry when
 * no Environment has the id.
 */
export type SettingsMcpView = {
  /** `*` for Global, or the Environment's id. */
  readonly scope: string;
  /** The Environment's name; `Global` at Global. */
  readonly name: string;
  readonly servers: ReadonlyArray<SettingsMcpServer>;
  /** With a name asked for: the names of the Scope's servers, for a refusal that lists them. */
  readonly names: ReadonlyArray<string>;
  /** With a name asked for and found: its layers as written. */
  readonly layers: SettingsMcpLayers | null;
  /** Each Repo's file as last looked at, in the Environment's Repo order; none at Global. */
  readonly repos: ReadonlyArray<SettingsMcpRepo>;
  readonly orphans: ReadonlyArray<McpOrphan>;
  /** Every problem of the set, a Repo file's own included. */
  readonly problems: ReadonlyArray<McpProblem>;
  /** `tools.offered` in force at the Scope, which can lift an MCP tool to `direct`. */
  readonly offered: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /**
   * At Global, with a name asked for that Global's own entries do not have: the Environments whose set has a server of that
   * name (their own entry or a Repo's), which no `settings_mcp_*` tool at `*` can change. Absent otherwise, and from a
   * Registry from before it.
   */
  readonly definedIn?: ReadonlyArray<SettingsMcpEnvironment> | undefined;
  /**
   * At Global, with a name asked for: the Environments that have an entry of their own whose name differs from it only in
   * case or in `-`/`_` (with that name), which a new Global entry of the name would clash with. Absent when there are none,
   * and from a Registry from before it.
   */
  readonly twinsIn?: ReadonlyArray<SettingsMcpTwin> | undefined;
};

/** An Environment's own server whose name is the case or `-`/`_` twin of another. */
export type SettingsMcpTwin = SettingsMcpEnvironment & { readonly twin: string };

/** One field of a server given a new value, or reset (Global: back to its default; an Environment: inheriting again). */
export type McpFieldChange = {
  readonly field: string;
  readonly value: Schema.Json | null;
  readonly reset?: true | undefined;
};

/**
 * What `mcpChangeCheck` finds of one Environment's set for a change to a server's keys: whether the entry in force of the
 * server changes there (`reached`: an Environment whose own entry or adjustment overrides the key is not), and what
 * the change makes reachable that was not (`checkMcpWidening`: a switched-off server on, a hidden tool in reach).
 */
export type SettingsMcpReach = {
  readonly environment: SettingsMcpEnvironment;
  readonly reached: boolean;
  readonly widening: ReadonlyArray<McpWidening>;
  /**
   * With `reads` asked: what each `${NAME}` is there (a Secret of the Environment's or Global's, a Variable, or missing), by
   * name only. Absent from a Registry from before it.
   */
  readonly reads?:
    | ReadonlyArray<{ readonly name: string; readonly kind: SettingsMcpReadKind }>
    | undefined;
};

/**
 * What the Registry checks again inside the transaction of an agent's MCP change (`changeSettings`'s `guard`;
 * `docs/architecture/mcp-configuration.md` → Approval, Applying): that it widens nothing (a change made without asking,
 * checked as narrowing a moment ago), and, at an Environment, that every `${NAME}` its entry reads resolves there.
 */
export type McpChangeGuard = {
  readonly name: string;
  readonly widening?: true | undefined;
  readonly reads?: ReadonlyArray<string> | undefined;
};

/**
 * The end of the Registry's refusal of a change made without asking that widens in its transaction (`mcpGuardRefusal`), which
 * a caller reads (`isWideningRefusal`) to tell it from any other rejection of the write (a bound, a name clash).
 */
export const WIDENING_REFUSAL_TAIL =
  "and something changed since it was checked as narrowing. Call again.";

/** Whether `message` is the Registry's refusal of a change that widens only since it was checked as narrowing. */
export const isWideningRefusal = (message: string): boolean =>
  message.endsWith(WIDENING_REFUSAL_TAIL);

/**
 * `mcpChangeCheck`'s answer (`docs/architecture/mcp-configuration.md` → Approval, The check): for each Environment whose set
 * has the server before or after the change, in the Registry's order (only the named one at an Environment's Scope). Null
 * from the Registry when no Environment has the id.
 */
export type SettingsMcpChangeCheck = {
  readonly environments: ReadonlyArray<SettingsMcpReach>;
};

/** What a reload made of one Repo's file. A string-valued state, so one a later build adds reads as itself. */
export type SettingsMcpReloadOutcome =
  | "changed"
  | "unchanged"
  | "absent"
  | "unreadable"
  | "invalid"
  | "not_github"
  | "recent";

/** One Repo as a reload found it. Times are epoch milliseconds. */
export type SettingsMcpReloadRepo = {
  readonly directory: string;
  readonly slug: string | null;
  readonly path: string;
  readonly outcome: SettingsMcpReloadOutcome;
  readonly blob: string | null;
  readonly readAt: number | null;
  readonly error: string | null;
  readonly errorSince: number | null;
  /** An unreadable Repo's last good copy is kept (only the owner's Reload drops it): its servers still stand. */
  readonly keptCopy: boolean;
  /** What is wrong with the file as a whole, as `mcpRepoFileViews` words it; null for none. */
  readonly problem: string | null;
};

/** What changed in the set between the look and before it, by server name; never a hash. */
export type SettingsMcpReloadSet = {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  /** Servers whose entry in force changed. */
  readonly changed: ReadonlyArray<string>;
  /** Problems the set has now that it did not have, and ones it had that are gone, as `<source>: <name> <message>` lines. */
  readonly problemsAdded: ReadonlyArray<string>;
  readonly problemsCleared: ReadonlyArray<string>;
};

/** `mcpSettingsReload`'s answer. Null from the Registry when no Environment has the id. */
export type SettingsMcpReload = {
  readonly scope: string;
  readonly name: string;
  readonly repos: ReadonlyArray<SettingsMcpReloadRepo>;
  readonly set: SettingsMcpReloadSet;
  /** The number of servers the set has now. */
  readonly servers: number;
};
