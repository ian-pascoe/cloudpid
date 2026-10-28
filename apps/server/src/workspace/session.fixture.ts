// A test Session DO on a real Workspace: the Session host with the extensions a Session runs with, over the Workspace DO
// `bindWorkspace` names, as the Session DO reaches it through its `WORKSPACES` binding.
// @effect-diagnostics asyncFunction:off
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import type { Harness } from "@cloudpid/effect-durable";
import { EnvironmentRemoval } from "@cloudpid/extensions/approval-tools";
import type { Approvals } from "@cloudpid/extensions/approvals";
import {
  BrowserHost,
  BrowserSession,
  type BrowserHandoffs,
  type OwnerTabDrivers,
} from "@cloudpid/extensions/browser";
import { WorkspaceContainer } from "@cloudpid/extensions/container";
import {
  type AgentChangeLog,
  DeployCredentials,
  Environments,
} from "@cloudpid/extensions/environment";
import { WorkspaceFiles } from "@cloudpid/extensions/files";
import { Images } from "@cloudpid/extensions/images";
import { InstructionsSettings } from "@cloudpid/extensions/instructions";
import type { Secrets } from "@cloudpid/extensions/secrets";
import { SettingsAccess, type SettingsReload } from "@cloudpid/extensions/settings";
import {
  type AgentWorkspace,
  SubagentSettings,
  type SubagentWorkspaceHost,
  SubagentWorkspaces,
  subagentOptions,
} from "@cloudpid/extensions/subagents";
import { fixedToolSearchSettings } from "@cloudpid/extensions/tool-search";
import { WebConfig } from "@cloudpid/extensions/web";
import { DEFAULT_OFFERED_TOOLS } from "@cloudpid/config";
import { repoDirectory, WORKSPACE_ROOT } from "@cloudpid/protocol";
import type { Extension, HarnessOptions } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CodemodeSandbox, remoteSandbox } from "../session/codemode.ts";
import { testEnvironments, unusedRemoval } from "../session/environments.fixture.ts";
import { sessionExtensions } from "../session/extensions.ts";
import { TestSession } from "../session/host.fixture.ts";
import { type Placement, sessionWorkspace } from "../session/workspace.ts";
import type { TestWorkspace } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the Workspace test Worker. */
    interface Env {
      readonly WORKSPACES: DurableObjectNamespace<TestWorkspace>;
      readonly CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
      /** The Images binding, which miniflare emulates with sharp. */
      readonly IMAGES: ImagesBinding;
    }
  }
}

const KEY = "workspace";

/** The prefix of the Subagent Workspaces' ids and objects the test Session makes. */
export const SUBAGENT_WORKSPACE_PREFIX = "subagent-";

/**
 * Subagent Workspaces as the Session makes them, without a Registry: subagent `agent` gets the Workspace DO
 * `subagent-<agent>` of this Session, at its root, where the test Worker clones nothing; the same one when asked again.
 */
const testSubagentWorkspaces = (session: string): SubagentWorkspaceHost => ({
  create: async ({ agent }) => {
    const id = `${SUBAGENT_WORKSPACE_PREFIX}${session}-${agent}`;

    const workspace: AgentWorkspace = {
      id,
      branch: `cloudpid/${agent}`,
      object: id,
      directory: WORKSPACE_ROOT,
    };

    return { workspace, warnings: [] };
  },
  workState: async () => [],
  remove: async () => {},
});

export class TestWorkspaceSession extends TestSession {
  /** The Session's Workspace, as the Session DO makes it from its Registry record and its `WORKSPACES` binding. */
  #workspace() {
    return sessionWorkspace({
      namespace: this.env.WORKSPACES,
      placement: () =>
        Promise.resolve(
          this.ctx.storage.kv.get<Placement>(KEY) ?? {
            workspace: null,
            object: "default",
            directory: WORKSPACE_ROOT,
          },
        ),
      // The test Worker has no Container to clone on: its Sessions are placed in Workspaces nobody readies, and its
      // Subagent Workspaces hold nothing to ready.
      prepare: (id) =>
        id.startsWith(SUBAGENT_WORKSPACE_PREFIX)
          ? Promise.resolve()
          : Promise.reject(new Error("The test Worker readies no Workspace")),
    });
  }

  #sandbox: CodemodeSandboxBase | undefined;

  /** The Session's sandbox: one object per Session, as the Session DO reaches it. Only the codemode tests run scripts. */
  protected sandbox(): CodemodeSandboxBase {
    return (this.#sandbox ??= remoteSandbox(this.env.CODEMODE_SANDBOX, this.ctx.id.toString()));
  }

  protected override hostExtensions(): Effect.Effect<
    readonly Extension[],
    never,
    | Harness
    | Secrets
    | BrowserHandoffs
    | OwnerTabDrivers
    | AgentChangeLog
    | SettingsReload
    | Approvals
  > {
    return sessionExtensions.pipe(
      // The tests of the Workspace delete nothing.
      Effect.provideService(EnvironmentRemoval, unusedRemoval),
      Effect.provideService(Environments, testEnvironments(this.ctx.storage.kv)),
      // The tests of the Workspace call no `settings_*` tool.
      Effect.provideService(SettingsAccess, {
        get: () => Effect.die("No Settings"),
        own: Effect.die("No Settings"),
        change: () => Effect.die("No Settings"),
      }),
      Effect.provideService(DeployCredentials, { values: [] }),
      Effect.provideService(WorkspaceFiles, this.#workspace().files),
      Effect.provideService(WorkspaceContainer, this.#workspace().container),
      Effect.provideService(Images, this.env.IMAGES),
      Effect.provideService(CodemodeSandbox, this.sandbox()),
      // No browser: the tests script the model, and none drives one.
      Effect.provideService(BrowserHost, {
        describe: Effect.succeed(""),
        run: () => Effect.succeed({ output: [] }),
        close: Effect.succeed(false),
        startHandoff: () => Effect.die("No browser"),
        liveView: () => Effect.die("No browser"),
        ownerTabView: () => Effect.die("No browser"),
        ownerTabs: Effect.die("No browser"),
        openOwnerTab: Effect.die("No browser"),
        showOwnerTab: () => Effect.die("No browser"),
        closeOwnerTab: () => Effect.die("No browser"),
        readOwnerTabPages: () => Effect.die("No browser"),
        waitHandoff: () => Effect.die("No browser"),
        endHandoff: () => Effect.succeed({ windowOrigins: [] }),
      }),
      Effect.provideService(BrowserSession, {
        touch: Effect.void,
        watch: Effect.succeed(false),
        closeAt: Effect.undefined,
        closeIfIdle: Effect.void,
      }),
      Effect.provideService(SubagentSettings, { current: () => subagentOptions({}, undefined) }),
      // The tests of the Workspace keep no Instructions.
      Effect.provideService(InstructionsSettings, { current: () => ({ global: "" }) }),
      Effect.provideService(SubagentWorkspaces, testSubagentWorkspaces(this.ctx.id.toString())),
      Effect.provide(fixedToolSearchSettings(DEFAULT_OFFERED_TOOLS)),
      // No search keys: the tests script the model, and none searches.
      Effect.provideService(WebConfig, { exaApiKey: Option.none(), parallelApiKey: Option.none() }),
    );
  }

  protected override hostEnv(): HarnessOptions["env"] {
    return this.#workspace().env;
  }

  protected override hostLookupEnv(): HarnessOptions["env"] {
    return this.#workspace().lookupEnv;
  }

  /**
   * Bind this Session to the Workspace whose object is `object`, working in its clone of `repo` (or at its root), as the
   * Registry binds a Session when it is created. The test Worker clones nothing: a test writes the files it needs.
   */
  bindWorkspace(object: string, repo: string | null = null): void {
    this.ctx.storage.kv.put(KEY, {
      workspace: null,
      object,
      directory: repo === null ? WORKSPACE_ROOT : repoDirectory(repo),
    } satisfies Placement);
  }
}
