// @effect-diagnostics missingPipeableSignature:off -- read and write helpers over a Scope, not combinators.

// The state of the MCP servers section (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers"
// section): what the page reads at a Scope (the settings' two documents, resolved into rows; the Secret and Variable names
// a `${NAME}` may use; the connection status of an Environment's servers), and what it writes (a change to a server, which
// is one Registry call at either Scope). The open form, import and tool exposure editor are kept per Scope while the app is
// open, as the other sections' drafts are.

import {
  GLOBAL_SCOPE,
  type McpRepoFileView,
  type McpRepoFilesView,
  type McpServersView,
  type SettingsOverridesState,
} from "@cloudpid/protocol";
import type { SettingsState } from "@cloudpid/protocol";
import { resolveMcpServerSet, SettingsError } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Predicate from "effect/Predicate";
import {
  environmentSecretsAtom,
  environmentSettingsAtom,
  globalVariablesAtom,
  secretsInAtom,
} from "../environments-state.ts";
import { changing, failureOf, RegistryClient } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import {
  readSettings,
  readSettingsOverrides,
  settingsAtom,
  settingsOverridesAtom,
} from "../settings.ts";
import { visibleTickAtom } from "../sessions.ts";
import {
  mcpRepoLayersOf,
  mcpScopeView,
  mcpStatuses,
  type McpReferenceNames,
  type McpScopeView,
  type McpStatuses,
  NO_MCP_STATUSES,
} from "./mcp-model.ts";
import type { McpFormDraft, McpToolsDraft } from "./mcp-form.ts";
import type { McpImportDraft } from "./mcp-import.ts";
import { type McpChange, mcpGlobalDocument, mcpOverridesPatch } from "./mcp-write.ts";

const isGlobal = (scope: string): boolean => scope === GLOBAL_SCOPE;

const viewOf = (
  scope: string,
  global: SettingsState,
  environment: SettingsOverridesState | null,
  repoFiles: ReadonlyArray<McpRepoFileView> | undefined,
): McpScopeView =>
  mcpScopeView({
    repoFiles,
    scope,
    global: global.overrides,
    globalProblem: global.problem,
    globalMcpProblems: global.mcpProblems,
    overrides: environment === null ? null : environment.overrides,
    overridesProblem: environment?.problem,
    overridesMcpProblems: environment?.mcpProblems,
    offered: (environment ?? global).settings.tools.offered,
    overriddenIn: global.overriddenIn,
  });

/** Where the Repos' `.pi/mcp.json` files of an Environment stand for the page: being asked, not answered, or known. */
export type McpRepoFilesState =
  | { readonly status: "loading" }
  /** The Registry did not answer (an older one does not know the call); its servers are not shown. */
  | { readonly status: "failed"; readonly problem: string }
  | { readonly status: "ready"; readonly files: ReadonlyArray<McpRepoFileView> };

const NO_REPO_FILES: McpRepoFilesState = { status: "ready", files: [] };

/**
 * Environment `environment`'s Repos' `.pi/mcp.json` as the Registry last looked at them, asked again every few seconds while
 * the page is visible (a Build's look is the Registry's own) and whenever the settings change. It asks GitHub for nothing.
 */
export const mcpRepoFilesQueryAtom = Atom.family((environment: string) =>
  RegistryClient.query("mcpRepoFiles", { environment }, { reactivityKeys: ["settings"] }).pipe(
    Atom.makeRefreshOnSignal(visibleTickAtom),
  ),
);

/** The answer `view` (a `mcpRepoFiles` or `mcpReloadRepoFiles` answer) gives, or why it gives no files. */
const repoFilesOf = (view: McpRepoFilesView): McpRepoFilesState =>
  Predicate.isTagged(view, "RepoFiles")
    ? { status: "ready", files: view.files }
    : {
        status: "failed",
        problem: Predicate.isTagged(view, "NoEnvironment")
          ? "This environment is not there any more."
          : "message" in view && view.message !== undefined
            ? view.message
            : "The Registry's answer is one this page does not know.",
      };

/** The Repo files at Scope `scope`: none at Global, which has no Repos. */
export const mcpRepoFilesAtom = Atom.family((scope: string) =>
  Atom.readable((get): McpRepoFilesState => {
    if (isGlobal(scope)) return NO_REPO_FILES;

    const asked = get(mcpRepoFilesQueryAtom(scope));

    return Option.match(AsyncResult.value(asked), {
      onNone: () => {
        const problem = failureOf(asked);

        return problem === null ? { status: "loading" } : { status: "failed", problem };
      },
      onSome: repoFilesOf,
    });
  }),
);

/**
 * The servers the page shows at Scope `scope`, resolved from Global's document, the Environment's Overrides and the Repos'
 * files as the Registry last read them. Until those are known, or where the Registry cannot say, a Repo's servers are not
 * among them (the files part of the section says why).
 */
export const mcpViewAtom = Atom.family((scope: string) =>
  Atom.readable((get) => {
    if (isGlobal(scope)) {
      return AsyncResult.map(get(settingsAtom), (global) => viewOf(scope, global, null, undefined));
    }

    const repos = get(mcpRepoFilesAtom(scope));

    return AsyncResult.map(
      AsyncResult.all([get(settingsAtom), get(settingsOverridesAtom(scope))]),
      ([global, environment]) =>
        viewOf(scope, global, environment, repos.status === "ready" ? repos.files : undefined),
    );
  }),
);

/** Whether the Secret and Variable names a `${NAME}` may use are known at a Scope: still being asked, failed, or known. */
export type McpReferencesState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly problem: string }
  | { readonly status: "ready"; readonly names: McpReferenceNames };

const LOADING: McpReferencesState = { status: "loading" };

/**
 * The Secrets and Variables a `${NAME}` may name at Scope `scope`, by name (never a value): at an Environment its Secrets
 * and Global's, then its Variables and Global's; at Global, Global's. Until they are known, or when asking failed, it says
 * so: an Environment's Save and Import are held for them (a `${NAME}` that nothing provides must not be missed).
 */
export const mcpReferenceNamesAtom = Atom.family((scope: string) =>
  Atom.readable((get): McpReferencesState => {
    const secrets = get(environmentSecretsAtom);
    const own = get(secretsInAtom(scope));
    const global = get(secretsInAtom(GLOBAL_SCOPE));

    if (own === null || global === null) {
      const problem = failureOf(secrets);

      return problem === null ? LOADING : { status: "failed", problem };
    }

    const names = Arr.map(isGlobal(scope) ? own : [...own, ...global], ({ name }) => name);

    if (isGlobal(scope)) {
      return {
        status: "ready",
        names: { secrets: names, variables: Record.keys(get(globalVariablesAtom)) },
      };
    }

    const settings = get(environmentSettingsAtom(scope));

    return Option.match(AsyncResult.value(settings), {
      onNone: () => {
        const problem = failureOf(settings);

        return problem === null ? LOADING : { status: "failed", problem };
      },
      onSome: (environment): McpReferencesState => ({
        status: "ready",
        names: { secrets: names, variables: Record.keys(environment.settings.variables) },
      }),
    });
  }),
);

/**
 * Environment `environment`'s MCP servers as its host reports them, asked again every few seconds while the page is visible
 * and whenever the settings change. It starts no Container. Global has no host to ask.
 */
export const mcpServersAtom = Atom.family((environment: string) =>
  RegistryClient.query("mcpServers", { environment }, { reactivityKeys: ["settings"] }).pipe(
    Atom.makeRefreshOnSignal(visibleTickAtom),
  ),
);

/** The status chips at Scope `scope`, as the last answer has them; none at Global or before the first answer. */
export const mcpStatusesAtom = Atom.family((scope: string) =>
  Atom.readable((get): McpStatuses => {
    if (isGlobal(scope)) return NO_MCP_STATUSES;

    return get(mcpServersAtom(scope)).pipe(
      AsyncResult.value,
      Option.match({
        onNone: () => NO_MCP_STATUSES,
        onSome: (answer: McpServersView) => mcpStatuses(answer),
      }),
    );
  }),
);

/** What the section has open above its list at a Scope: a form, the tool exposure editor, the import, or nothing. */
export type McpPanel = McpFormDraft | McpToolsDraft | McpImportDraft;

/** The panel open at Scope `scope`. */
export const mcpPanelAtom = Atom.family((_scope: string) => Atom.make<McpPanel | null>(null));

/** The server whose Remove dialog is open at Scope `scope`, by name. */
export const mcpRemoveAtom = Atom.family((_scope: string) => Atom.make<string | null>(null));

/** Whether `change` adjusts a server (rather than an own entry) that is not one of `globalServers`. */
const adjustsAnotherServer = (change: McpChange, globalServers: ReadonlyArray<string>): boolean =>
  (change.kind === "enabled" || change.kind === "exposure" || change.kind === "toolExposure") &&
  change.target === "adjustment" &&
  !Arr.contains(globalServers, change.name);

/** The names of the Repo servers Environment `environment` has now, as the Registry holds the files. */
const repoServerNames = (environment: string, overrides: SettingsOverridesState["overrides"]) =>
  Effect.gen(function* () {
    const global = yield* readSettings;

    const answered = yield* RegistryClient.use((registry) =>
      registry("mcpRepoFiles", { environment }),
    );

    const files = repoFilesOf(answered);

    if (files.status !== "ready") return [];

    return Arr.filterMap(
      resolveMcpServerSet(global.overrides, overrides, mcpRepoLayersOf(files.files)).servers,
      (resolved) =>
        resolved.source.kind === "repo" ? Result.succeed(resolved.name) : Result.failVoid,
    );
  });

/**
 * Make `change` to the servers of Scope `scope`, against the document as the Registry has it now: at Global the whole
 * document with the server's entry changed (`updateSettings`), at an Environment a patch of its Overrides
 * (`updateSettingsOverrides`). It fails with why the change no longer applies, or with the Registry's refusal.
 */
export const writeMcpChange = (scope: string, change: McpChange) =>
  Effect.gen(function* () {
    if (isGlobal(scope)) {
      const state = yield* readSettings;
      const document = mcpGlobalDocument(state.overrides, change);

      if (Result.isFailure(document)) {
        return yield* SettingsError.make({ message: document.failure });
      }

      return yield* RegistryClient.use((registry) =>
        registry("updateSettings", { overrides: document.success }),
      );
    }

    const state = yield* readSettingsOverrides(scope);
    const globalServers = Record.keys(state.global.mcp.servers);

    // An adjustment of a server Global does not have may be of a Repo's: its base is looked up as the Registry has it now.
    const repoServers = yield* adjustsAnotherServer(change, globalServers)
      ? repoServerNames(scope, state.overrides)
      : Effect.succeed([]);

    const patch = mcpOverridesPatch(state.overrides, change, [...globalServers, ...repoServers]);

    if (Result.isFailure(patch)) {
      return yield* SettingsError.make({ message: patch.failure });
    }

    return yield* RegistryClient.use((registry) =>
      registry("updateSettingsOverrides", { environment: scope, ...patch.success }),
    );
  });

/** Make a change to the servers of Scope `scope`; the settings and the servers' status ask again once it ends. */
export const changeMcpAtom = Atom.family((scope: string) =>
  appRuntime.fn((change: McpChange) => writeMcpChange(scope, change).pipe(changing(["settings"])), {
    concurrent: true,
  }),
);

/** Keep a server from a form or an import, then close the panel. */
export const saveMcpAtom = Atom.family((scope: string) =>
  appRuntime.fn(
    (change: McpChange, get) =>
      writeMcpChange(scope, change).pipe(
        changing(["settings"]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(mcpPanelAtom(scope), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/** Remove a server's own entry, then close its dialog. */
export const removeMcpAtom = Atom.family((scope: string) =>
  appRuntime.fn(
    (name: string, get) =>
      writeMcpChange(scope, { kind: "remove", name }).pipe(
        changing(["settings"]),
        Effect.tap(() =>
          Effect.sync(() => {
            get.set(mcpRemoveAtom(scope), null);
          }),
        ),
      ),
    { concurrent: true },
  ),
);

/**
 * Reload Repo `repo`'s `.pi/mcp.json` (every Repo's when undefined) of Environment `scope` from GitHub now, as the owner's
 * Reload does: whatever the last look was, and a Repo that cannot be read loses its last good copy. The files and the
 * servers' status ask again once it ends. It fails with why when the Environment is not there.
 */
export const reloadMcpRepoAtom = Atom.family((scope: string) =>
  appRuntime.fn(
    (repo: string | undefined) =>
      RegistryClient.use((registry) =>
        registry(
          "mcpReloadRepoFiles",
          repo === undefined ? { environment: scope } : { environment: scope, repo },
        ),
      ).pipe(
        Effect.flatMap((view) => {
          const files = repoFilesOf(view);

          return files.status === "failed"
            ? Effect.fail(SettingsError.make({ message: files.problem }))
            : Effect.void;
        }),
        changing(["settings"]),
      ),
    { concurrent: true },
  ),
);
