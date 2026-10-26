// A test Session DO on a Workspace that also has a `hold` tool, for scripts an eviction interrupts: the first call to it
// stops the instance's script where a test needs it, and a call after that returns.
// @effect-diagnostics asyncFunction:off
import { defineEffectTool, type Harness } from "@cloudpid/effect-durable";
import type { Approvals } from "@cloudpid/extensions/approvals";
import type { BrowserHandoffs, OwnerTabDrivers } from "@cloudpid/extensions/browser";
import type { AgentChangeLog } from "@cloudpid/extensions/environment";
import type { Secrets } from "@cloudpid/extensions/secrets";
import type { SettingsReload } from "@cloudpid/extensions/settings";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TestWorkspaceSession } from "./session.fixture.ts";

const HOLDS = "holds";

export class TestCodemodeSession extends TestWorkspaceSession {
  /** Resolves when this instance's `hold` call starts and waits. */
  readonly holding = Promise.withResolvers<void>();

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
    const { kv } = this.ctx.storage;

    const hold = defineEffectTool({
      name: "hold",
      description: "Wait once, then answer",
      parameters: Schema.Struct({}),
      // A rerun of a call an eviction cut off must hold no longer: it is the second.
      replay: "safe",
      execute: () =>
        Effect.suspend(() => {
          const holds = (kv.get<number>(HOLDS) ?? 0) + 1;

          kv.put(HOLDS, holds);

          if (holds > 1)
            return Effect.succeed({ output: [{ type: "text" as const, text: "released" }] });

          this.holding.resolve();

          return Effect.never;
        }),
    });

    return Effect.all([
      super.hostExtensions(),
      Effect.map(hold, (tool) => [defineExtension({ name: "hold", tools: [tool] })]),
    ]).pipe(Effect.map(([base, extra]) => [...base, ...extra]));
  }

  /**
   * Close the sandbox, as a Session shuts down before an eviction: the script it runs stops without an outcome, so the
   * next instance replays it. The test runtime cannot evict an object that is in a call to another one.
   */
  closeSandbox(): Promise<void> {
    return this.sandbox().close();
  }

  /** How many times the `hold` tool ran, across instances. */
  holds(): number {
    return this.ctx.storage.kv.get<number>(HOLDS) ?? 0;
  }
}
