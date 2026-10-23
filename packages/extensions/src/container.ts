// The `container` extension (`docs/spec.md` → Container and Toolchains → Restart by the agent): `restart_container`,
// which stops the Session's Workspace's Container so the next command starts a new one. It is the agent's way out of a
// Container that no longer answers (every command hangs, `echo` included), which it cannot fix with a command. It
// reaches the Container only through `WorkspaceContainer`, which the Session provides over its Workspace DO: the
// platform stops the Container whatever computerd is doing, and nothing here runs a command.
// @effect-diagnostics missingPipeableSignature:off
import { defineEffectTool } from "@cloudpid/effect-durable";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const extensionName = "container";

/** The Session's Workspace's Container, as `restart_container` stops it. */
export interface ContainerControl {
  /**
   * Stop the Container if it runs, so the next command starts a new one: from the Workspace's last snapshot, or, when
   * `fresh`, with the snapshot forgotten, from the Environment's Build or the image. Answers whether one was running.
   */
  restart(options: { readonly fresh: boolean }): Promise<{ readonly wasRunning: boolean }>;
}

/** The Container `restart_container` restarts: the Session provides its Workspace's. */
export class WorkspaceContainer extends Context.Service<WorkspaceContainer, ContainerControl>()(
  "@cloudpid/extensions/container/WorkspaceContainer",
) {}

/** A restart failed; its message is what the model sees. */
export class ContainerError extends Schema.TaggedError<
  ContainerError,
  { readonly brand: unique symbol }
>()("ContainerError", { message: Schema.String }) {}

/** The longest reason a call may give. */
export const MAX_RESTART_REASON = 500;

const description = Arr.join(
  [
    "Restart this Workspace's container (where `bash` runs with the `container` backend). Use it when the container stops answering: container commands hang or time out, `echo` included, or keep failing in ways no command can fix. Do not use it to stop one command: give a command that may run long a `timeout` instead.",
    "It stops the container at once: every command running there ends, other Sessions' in this Workspace too, and so do the services its Start Scripts started. The files in /workspace stay. The next container command starts a new container (several seconds), from the Workspace's last snapshot: dependency directories, build output and caches are as they were when it was taken, and the Start Scripts run again.",
    "With `fresh`, the snapshot is forgotten too, as the owner's Restart container does: the new container starts from the Environment's Build or the image, so dependency directories, build output and caches are gone, and the Setup Scripts run again (minutes). Use it only when a restart from the snapshot did not help.",
  ],
  "\n\n",
);

const Parameters = Schema.Struct({
  reason: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_RESTART_REASON),
  ).annotate({
    description:
      "Why the container needs a restart, for the user to read: what hung or broke, such as 'pnpm test and then echo hung for minutes'",
  }),
  fresh: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Forget the snapshot too, and start from the Environment's Build or the image (default: false)",
    }),
  ),
});

/** What the model is told once the Container is stopped. */
export const describeRestart = (fresh: boolean, wasRunning: boolean): string => {
  const next = fresh
    ? "The next container command starts a new container from the Environment's Build or the image: dependency directories, build output and caches are gone, and the Setup Scripts run again, which can take minutes."
    : "The next container command starts a new container from the Workspace's last snapshot, with what its disk held then.";

  return wasRunning
    ? `Stopped the container: the commands that were running there have ended, so run again what you still need. ${next}`
    : `No container was running, so none was stopped.${fresh ? " The snapshot is forgotten." : ""} ${next}`;
};

/**
 * `restart_container`. Not replay-safe: after an eviction a rerun would stop the Container the next command started, so
 * the model gets an interrupted result instead. Sequential, so a conversation's other calls do not run on a Container
 * it is stopping.
 */
const RestartContainer = defineEffectTool({
  name: "restart_container",
  description,
  parameters: Parameters,
  executionMode: "sequential",
  replay: "unsafe",
  execute: Effect.fnUntraced(function* ({ fresh = false }) {
    const container = yield* WorkspaceContainer;

    const { wasRunning } = yield* Effect.tryPromise({
      try: () => container.restart({ fresh }),
      catch: (cause) =>
        ContainerError.make({
          message: `Could not restart the container: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });

    return {
      output: [{ type: "text" as const, text: describeRestart(fresh, wasRunning) }],
      details: { fresh, wasRunning },
    };
  }),
});

/** The `container` extension: `restart_container`, over the Session's `WorkspaceContainer`. */
export const ContainerTools: Effect.Effect<Extension, never, WorkspaceContainer> = Effect.map(
  RestartContainer,
  (tool) => defineExtension({ name: extensionName, tools: [tool] }),
);
