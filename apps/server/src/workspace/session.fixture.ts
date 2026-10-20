// A test Session DO on a real Workspace: the Session host with the extensions a Session runs with, over the Workspace DO
// `bindWorkspace` names, as the Session DO reaches it through its `WORKSPACES` binding.
// @effect-diagnostics asyncFunction:off
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import type { Harness } from "@cloudpid/effect-durable";
import { BrowserHost, BrowserSession } from "@cloudpid/extensions/browser";
import { WorkspaceFiles } from "@cloudpid/extensions/files";
import type { Secrets } from "@cloudpid/extensions/secrets";
import { SubagentSettings, subagentOptions } from "@cloudpid/extensions/subagents";
import { WebConfig } from "@cloudpid/extensions/web";
import { DEFAULT_WORKSPACE } from "@cloudpid/protocol";
import type { Extension, HarnessOptions } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CodemodeSandbox, remoteSandbox } from "../session/codemode.ts";
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
    }
  }
}

const KEY = "workspace";

export class TestWorkspaceSession extends TestSession {
  /** The Session's Workspace, as the Session DO makes it from its Registry record and its `WORKSPACES` binding. */
  #workspace() {
    return sessionWorkspace({
      namespace: this.env.WORKSPACES,
      placement: () =>
        Promise.resolve(
          this.ctx.storage.kv.get<Placement>(KEY) ?? { slug: DEFAULT_WORKSPACE, repo: null },
        ),
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
    Harness | Secrets
  > {
    return sessionExtensions.pipe(
      Effect.provideService(WorkspaceFiles, this.#workspace().files),
      Effect.provideService(CodemodeSandbox, this.sandbox()),
      // No browser: the tests script the model, and none drives one.
      Effect.provideService(BrowserHost, {
        describe: Effect.succeed(""),
        run: () => Effect.succeed({ output: [] }),
        close: Effect.succeed(false),
      }),
      Effect.provideService(BrowserSession, {
        touch: Effect.void,
        closeAt: Effect.undefined,
        closeIfIdle: Effect.void,
      }),
      Effect.provideService(SubagentSettings, { current: () => subagentOptions({}, undefined) }),
      // No search keys: the tests script the model, and none searches.
      Effect.provideService(WebConfig, { exaApiKey: Option.none(), parallelApiKey: Option.none() }),
    );
  }

  protected override hostEnv(): HarnessOptions["env"] {
    return this.#workspace().env;
  }

  /** Bind this Session to Workspace `slug` (and the repo directory in it), as the Registry binds a Session when it is created. */
  bindWorkspace(slug: string, repo: string | null = null): void {
    this.ctx.storage.kv.put(KEY, { slug, repo } satisfies Placement);
  }
}
