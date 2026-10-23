// A test Session DO on a real Workspace: the Session host with the extensions a Session runs with, over the Workspace DO
// `bindWorkspace` names, as the Session DO reaches it through its `WORKSPACES` binding.
// @effect-diagnostics asyncFunction:off
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type { CodemodeSandboxBase } from "@earendil-works/pi-codemode/portable";
import type { Harness } from "@cloudpid/effect-durable";
import { BrowserHost, BrowserSession, type BrowserHandoffs } from "@cloudpid/extensions/browser";
import { WorkspaceFiles } from "@cloudpid/extensions/files";
import { Images } from "@cloudpid/extensions/images";
import type { Secrets } from "@cloudpid/extensions/secrets";
import { SubagentSettings, subagentOptions } from "@cloudpid/extensions/subagents";
import { fixedToolSearchSettings } from "@cloudpid/extensions/tool-search";
import { WebConfig } from "@cloudpid/extensions/web";
import { DEFAULT_OFFERED_TOOLS } from "@cloudpid/config";
import { DEFAULT_MACHINE } from "@cloudpid/protocol";
import type { Extension, HarnessOptions } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CodemodeSandbox, remoteSandbox } from "../session/codemode.ts";
import { sessionExtensions } from "../session/extensions.ts";
import { TestSession } from "../session/host.fixture.ts";
import {
  earlyStartOnSubmit,
  type PlacedWorktree,
  type Placement,
  sessionWorkspace,
} from "../session/workspace.ts";
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

/** The prefix of the Workspaces an early start cannot reach, and where the attempts are counted. */
const UNREACHABLE = "early-start-unreachable";

const UNREACHABLE_KEY = "early-start-unreachable";

export class TestWorkspaceSession extends TestSession {
  /** The Session's Workspace, as the Session DO makes it from its Registry record and its `WORKSPACES` binding. */
  #workspace() {
    return sessionWorkspace({
      namespace: this.env.WORKSPACES,
      placement: () =>
        Promise.resolve(
          this.ctx.storage.kv.get<Placement>(KEY) ?? {
            machine: DEFAULT_MACHINE,
            repo: null,
            worktree: null,
          },
        ),
      // The test Worker has no Container to make a worktree on: a Session placed in one can use only what does not
      // wait for it to be made, such as the composer's lookups.
      prepare: () => Promise.reject(new Error("The test Worker makes no worktrees")),
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
    Harness | Secrets | BrowserHandoffs
  > {
    return sessionExtensions.pipe(
      Effect.provideService(WorkspaceFiles, this.#workspace().files),
      Effect.provideService(Images, this.env.IMAGES),
      Effect.provideService(CodemodeSandbox, this.sandbox()),
      // No browser: the tests script the model, and none drives one.
      Effect.provideService(BrowserHost, {
        describe: Effect.succeed(""),
        run: () => Effect.succeed({ output: [] }),
        close: Effect.succeed(false),
        startHandoff: () => Effect.die("No browser"),
        waitHandoff: () => Effect.die("No browser"),
        endHandoff: () => Effect.void,
      }),
      Effect.provideService(BrowserSession, {
        touch: Effect.void,
        closeAt: Effect.undefined,
        closeIfIdle: Effect.void,
      }),
      Effect.provideService(SubagentSettings, { current: () => subagentOptions({}, undefined) }),
      Effect.provide(fixedToolSearchSettings(DEFAULT_OFFERED_TOOLS)),
      // No search keys: the tests script the model, and none searches.
      Effect.provideService(WebConfig, { exaApiKey: Option.none(), parallelApiKey: Option.none() }),
    );
  }

  /**
   * As the Session DO's: each message the owner sends asks its Workspace for the early start of the Container. On a
   * Workspace named `early-start-unreachable-…` the request fails as an RPC that cannot reach the object does, with a
   * rejection the Session gets and the Workspace never sees.
   */
  protected override hostOnSubmit(): Effect.Effect<void> {
    const workspace = this.#workspace();
    const { kv } = this.ctx.storage;

    return earlyStartOnSubmit({
      startContainerEarly: async () => {
        if (kv.get<Placement>(KEY)?.machine.startsWith(UNREACHABLE) !== true) {
          return workspace.startContainerEarly();
        }

        kv.put(UNREACHABLE_KEY, this.unreachableEarlyStarts() + 1);

        throw new Error("the Workspace is unreachable");
      },
    });
  }

  /** Early starts asked of an unreachable Workspace. */
  unreachableEarlyStarts(): number {
    return this.ctx.storage.kv.get<number>(UNREACHABLE_KEY) ?? 0;
  }

  protected override hostEnv(): HarnessOptions["env"] {
    return this.#workspace().env;
  }

  protected override hostLookupEnv(): HarnessOptions["env"] {
    return this.#workspace().lookupEnv;
  }

  /**
   * Bind this Session to Workspace `slug` (and the repo directory in it, and its worktree of that repo), as the Registry
   * binds a Session when it is created. The test Worker makes no worktree: a test writes the files of one it names.
   */
  bindWorkspace(
    slug: string,
    repo: string | null = null,
    worktree: PlacedWorktree | null = null,
  ): void {
    this.ctx.storage.kv.put(KEY, { machine: slug, repo, worktree } satisfies Placement);
  }
}
