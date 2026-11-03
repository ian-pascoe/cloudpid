// @effect-diagnostics missingPipeableSignature:off -- read and write helpers over a Scope, not combinators.

// The state of the MCP servers section (docs/architecture/mcp-configuration.md → The Settings page's "MCP servers"
// section): what the page reads at a Scope (the settings' two documents, resolved into rows; the Secret and Variable names
// a `${NAME}` may use; the connection status of an Environment's servers), and what it writes (a change to a server, which
// is one Registry call at either Scope). The open form, import and tool exposure editor are kept per Scope while the app is
// open, as the other sections' drafts are.

import { GLOBAL_SCOPE, type McpServersView, type SettingsOverridesState } from "@cloudpid/protocol";
import type { SettingsState } from "@cloudpid/protocol";
import { SettingsError } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import {
  environmentSettingsAtom,
  globalVariablesAtom,
  secretsInAtom,
} from "../environments-state.ts";
import { changing, RegistryClient } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import {
  readSettings,
  readSettingsOverrides,
  settingsAtom,
  settingsOverridesAtom,
} from "../settings.ts";
import { visibleTickAtom } from "../sessions.ts";
import {
  mcpScopeView,
  mcpStatuses,
  type McpReferenceNames,
  type McpScopeView,
  type McpStatuses,
  NO_MCP_STATUSES,
} from "./mcp-model.ts";
import type { McpFields } from "./mcp-form.ts";
import type { McpToolRow } from "./mcp-form.ts";
import { type McpChange, mcpGlobalDocument, mcpOverridesPatch } from "./mcp-write.ts";
import type { McpConflictChoice } from "./mcp-import.ts";

const isGlobal = (scope: string): boolean => scope === GLOBAL_SCOPE;

const viewOf = (
  scope: string,
  global: SettingsState,
  environment: SettingsOverridesState | null,
): McpScopeView =>
  mcpScopeView({
    scope,
    global: global.overrides,
    globalProblem: global.problem,
    overrides: environment === null ? null : environment.overrides,
    overridesProblem: environment?.problem,
    offered: (environment ?? global).settings.tools.offered,
    overriddenIn: global.overriddenIn,
  });

/** The servers the page shows at Scope `scope`, resolved from Global's document and the Environment's Overrides. */
export const mcpViewAtom = Atom.family((scope: string) =>
  Atom.readable((get) =>
    isGlobal(scope)
      ? AsyncResult.map(get(settingsAtom), (global) => viewOf(scope, global, null))
      : AsyncResult.map(
          AsyncResult.all([get(settingsAtom), get(settingsOverridesAtom(scope))]),
          ([global, environment]) => viewOf(scope, global, environment),
        ),
  ),
);

/**
 * The Secrets and Variables a `${NAME}` may name at Scope `scope`, by name (never a value): at an Environment its Secrets
 * and Global's, then its Variables and Global's; at Global, Global's. Null until they are known.
 */
export const mcpReferenceNamesAtom = Atom.family((scope: string) =>
  Atom.readable((get): McpReferenceNames | null => {
    const own = get(secretsInAtom(scope));
    const global = get(secretsInAtom(GLOBAL_SCOPE));

    if (own === null || global === null) return null;

    const secrets = Arr.map(isGlobal(scope) ? own : [...own, ...global], ({ name }) => name);

    if (isGlobal(scope)) {
      return { secrets, variables: Record.keys(get(globalVariablesAtom)) };
    }

    const environment = get(environmentSettingsAtom(scope)).pipe(AsyncResult.value);

    return Option.isNone(environment)
      ? null
      : { secrets, variables: Record.keys(environment.value.settings.variables) };
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

/** The form of an Add or an Edit: its fields, which tab is shown, and the JSON tab's text. */
export interface McpFormDraft {
  readonly kind: "form";
  /** `add`; `edit` of the Scope's own server `name`; `replace`, a copy of Global's `name` as this Environment's own. */
  readonly mode: "add" | "edit" | "replace";
  readonly fields: McpFields;
  readonly tab: "form" | "json";
  readonly json: string;
  /** Why the JSON tab's text cannot be read into the form, while it is shown. */
  readonly jsonProblem: string | null;
}

/** The editor of a Global server's tool exposure at an Environment, which is an adjustment. */
export interface McpToolsDraft {
  readonly kind: "tools";
  readonly name: string;
  readonly rows: ReadonlyArray<McpToolRow>;
}

/** The import: the text pasted, and what the owner chose for each name the Scope has. */
export interface McpImportDraft {
  readonly kind: "import";
  readonly text: string;
  readonly choices: Readonly<Record<string, McpConflictChoice>>;
}

/** What the section has open above its list at a Scope: a form, the tool exposure editor, the import, or nothing. */
export type McpPanel = McpFormDraft | McpToolsDraft | McpImportDraft;

/** The panel open at Scope `scope`. */
export const mcpPanelAtom = Atom.family((_scope: string) => Atom.make<McpPanel | null>(null));

/** The server whose Remove dialog is open at Scope `scope`, by name. */
export const mcpRemoveAtom = Atom.family((_scope: string) => Atom.make<string | null>(null));

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
    const patch = mcpOverridesPatch(state.overrides, change);

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
