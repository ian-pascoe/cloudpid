// The `container` extension (`docs/architecture/container.md` → Restart by the agent, Resize by the agent): the
// tools that act on the Container of the calling conversation's Workspace (the Session's, or its Subagent Workspace).
// `container_restart` stops it so the next command starts a new one: the agent's way out of a Container that no longer
// answers (every command hangs, `echo` included), which it cannot fix with a command. `container_resize` restarts it at
// another size, up to its Environment's size limit, until the idle stop (GLOSSARY.md → Container resize). Both reach the
// Container only through `WorkspaceContainer`, which the Session provides over the conversation's Workspace DO, and
// nothing here runs a command.
// @effect-diagnostics missingPipeableSignature:off
import {
  compareInstances,
  INSTANCE_DESCRIPTIONS,
  INSTANCE_RESOURCES,
  INSTANCE_TYPES,
  InstanceType,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type ConversationTarget, conversationTarget } from "./conversation-target.ts";

export const extensionName = "container";

/** What a resize did (`ContainerControl.resize`). */
export type ContainerResizeOutcome =
  /** The size is above the Environment's size limit, `limit`: nothing was stopped or recorded. */
  | { readonly outcome: "refused"; readonly limit: InstanceType }
  /** The running Container already has `size`: it was not stopped. */
  | { readonly outcome: "unchanged"; readonly size: InstanceType }
  | {
      readonly outcome: "resized";
      /** Whether a Container was running, and so was snapshotted and stopped. */
      readonly wasRunning: boolean;
      /** The size the stopped Container ran on, or, with none running, the one the next launch would have had. */
      readonly previous: InstanceType;
      /** The size the next launch has. */
      readonly next: InstanceType;
      /** The Environment's own size, which the launch after the idle stop has. */
      readonly environment: InstanceType;
      /** Whether the stopped Container's disk was snapshotted; false when none was running. */
      readonly snapshotted: boolean;
    };

/**
 * The Container of the Workspace a conversation works in (`target`: the Session's Workspace, or the conversation's
 * Subagent Workspace), as `container_restart` and `container_resize` stop it.
 */
export interface ContainerControl {
  /**
   * Stop the Container if it runs, so the next command starts a new one: from the Workspace's last snapshot, or, when
   * `fresh`, with the snapshot forgotten, from the Environment's Build or the image. Answers whether one was running.
   */
  restart(options: {
    readonly fresh: boolean;
    readonly target: ConversationTarget;
  }): Promise<{ readonly wasRunning: boolean }>;
  /**
   * Have the next launch start on `size` (until the idle stop) if the Environment's size limit allows it: a running
   * Container is snapshotted and stopped first, unless it already runs on `size`.
   */
  resize(options: {
    readonly size: InstanceType;
    readonly target: ConversationTarget;
  }): Promise<ContainerResizeOutcome>;
}

/** The Container the tools act on: the Session provides its Workspace's. */
export class WorkspaceContainer extends Context.Service<WorkspaceContainer, ContainerControl>()(
  "@cloudpid/extensions/container/WorkspaceContainer",
) {}

/** A restart or resize failed, or was refused; its message is what the model sees. */
export class ContainerError extends Schema.TaggedError<
  ContainerError,
  { readonly brand: unique symbol }
>()("ContainerError", { message: Schema.String }) {}

/** The longest reason a call of either tool may give. */
export const MAX_CONTAINER_REASON = 500;

const restartDescription = Arr.join(
  [
    "Restart this Workspace's container (where `bash` runs with the `container` backend). Use it when the container stops answering: container commands hang or time out, `echo` included, or keep failing in ways no command can fix. Do not use it to stop one command: give a command that may run long a `timeout` instead.",
    "It stops the container at once: every command running there ends, other Sessions' in this Workspace too, and so do the services its Start Scripts started. The files in /workspace stay. The next container command starts a new container (several seconds) of the same size, a size `container_resize` gave it included, from the Workspace's last snapshot: dependency directories, build output and caches are as they were when it was taken, and the Start Scripts run again.",
    "With `fresh`, the snapshot is forgotten too, as the owner's Restart container does: the new container starts from the Environment's Build or the image, so dependency directories, build output and caches are gone, and the Setup Scripts run again (minutes). Use it only when a restart from the snapshot did not help.",
  ],
  "\n\n",
);

const Reason = (description: string) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_CONTAINER_REASON)).annotate({
    description,
  });

const RestartParameters = Schema.Struct({
  reason: Reason(
    "Why the container needs a restart, for the user to read: what hung or broke, such as 'pnpm test and then echo hung for minutes'",
  ),
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

/** `cause`'s message, for the model. */
const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * `container_restart`. Not replay-safe: after an eviction a rerun would stop the Container the next command started, so
 * the model gets an interrupted result instead. Sequential, so a conversation's other calls do not run on a Container
 * it is stopping.
 */
const ContainerRestart = defineEffectTool({
  name: "container_restart",
  description: restartDescription,
  parameters: RestartParameters,
  executionMode: "sequential",
  replay: "unsafe",
  execute: Effect.fnUntraced(function* ({ fresh = false }, api) {
    const container = yield* WorkspaceContainer;
    const target = yield* conversationTarget(api);

    const { wasRunning } = yield* Effect.tryPromise({
      try: () => container.restart({ fresh, target }),
      catch: (cause) =>
        ContainerError.make({ message: `Could not restart the container: ${messageOf(cause)}` }),
    });

    return {
      output: [{ type: "text" as const, text: describeRestart(fresh, wasRunning) }],
      details: { fresh, wasRunning },
    };
  }),
});

/** Every size, smallest memory first, with what it offers. */
export const SIZE_LINES = Arr.join(
  Arr.map(
    Arr.sort(INSTANCE_TYPES, compareInstances),
    (size) => `- ${size}: ${INSTANCE_DESCRIPTIONS[size]}`,
  ),
  "\n",
);

const resizeDescription = Arr.join(
  [
    "Restart this Workspace's container (where `bash` runs with the `container` backend) at another size. Use it when commands need more memory than the container has (the memory guard stopped a process, and running less at once is not enough), or to go back to a smaller size once that work is done.",
    `Sizes, by memory, then vCPU:\n${SIZE_LINES}`,
    "cpu-N sizes have the most vCPU for their memory; mem-N sizes (N GiB) have more memory on fewer vCPU, for work that needs memory more than cores, such as a single-threaded tsc or a tool that starts a worker per core. CPU is billed only while busy, so fewer vCPU do not make a size cheaper to keep running.",
    "The Environment's size limit bounds the size; a size above it is refused (only the owner can raise the limit).",
    "A running container is snapshotted and stopped: every command running there ends, other Sessions' in this Workspace too, and so do the services its Start Scripts started. The files in /workspace stay. The next container command starts a new container on the new size from that snapshot, so dependency directories, build output and caches come back, and the Start Scripts run again. With no container running, the size is only recorded for the next one.",
    "The size lasts until the container is stopped for being idle: the one after that has the Environment's own size again. `container_restart` keeps it. Resizing to the Environment's own size goes back to it at once.",
  ],
  "\n\n",
);

const ResizeParameters = Schema.Struct({
  size: InstanceType.annotate({ description: "The size the next container starts on" }),
  reason: Reason(
    "Why the container needs another size, for the user to read: such as 'tsc was stopped by the memory guard at 2.6 GB'",
  ),
});

/** `size`, with what it offers. */
const sizeLabel = (size: InstanceType) => `${size} (${INSTANCE_DESCRIPTIONS[size]})`;

/** What the model is told once a resize is done. */
const describeResize = (
  resized: Extract<ContainerResizeOutcome, { readonly outcome: "resized" }>,
): string => {
  const { wasRunning, previous, next, environment, snapshotted } = resized;

  const from = !wasRunning
    ? "from the Workspace's last snapshot"
    : snapshotted
      ? "from the snapshot just taken, with dependency directories, build output and caches as they were"
      : "from the Workspace's last snapshot (the snapshot could not be taken, so what the container wrote since that one is gone)";

  const lasts =
    next === environment
      ? `${next} is the Environment's own size, which the containers after it keep.`
      : `It keeps ${next} until the container is stopped for being idle; the one after that starts on the Environment's size, ${environment}.`;

  const previousDisk = INSTANCE_RESOURCES[previous].diskMb;
  const nextDisk = INSTANCE_RESOURCES[next].diskMb;

  const disk =
    nextDisk < previousDisk
      ? ` ${next}'s disk (${nextDisk / 1000} GB) is smaller than ${previous}'s (${previousDisk / 1000} GB): a snapshot that does not fit on it is not restored, and the container starts from the image instead, without what the snapshot held, and runs the Setup Scripts again.`
      : "";

  const stopped = wasRunning
    ? `Stopped the container (it ran on ${previous}): the commands that were running there have ended, other Sessions' in this Workspace too, so run again what you still need.`
    : "No container was running, so none was stopped.";

  return `${stopped} The next container command starts a new container on ${sizeLabel(next)} ${from}. ${lasts}${disk}`;
};

/**
 * `container_resize`. Not replay-safe, as `container_restart` is not: a rerun after an eviction would stop the Container
 * the next command started on the new size. Sequential, for the same reason as `container_restart`.
 */
const ContainerResize = defineEffectTool({
  name: "container_resize",
  description: resizeDescription,
  parameters: ResizeParameters,
  executionMode: "sequential",
  replay: "unsafe",
  execute: Effect.fnUntraced(function* ({ size }, api) {
    const container = yield* WorkspaceContainer;
    const target = yield* conversationTarget(api);

    const resized = yield* Effect.tryPromise({
      try: () => container.resize({ size, target }),
      catch: (cause) =>
        ContainerError.make({ message: `Could not resize the container: ${messageOf(cause)}` }),
    });

    if (resized.outcome === "refused") {
      return yield* ContainerError.make({
        message: `${size} is above this Environment's size limit, ${resized.limit}: pick a size up to ${resized.limit}, or ask the owner: the owner can raise the limit. Nothing was stopped.`,
      });
    }

    const text =
      resized.outcome === "unchanged"
        ? `The container already runs on ${resized.size}, so it was not stopped.`
        : describeResize(resized);

    return { output: [{ type: "text" as const, text }], details: { size, ...resized } };
  }),
});

/** The `container` extension: `container_restart` and `container_resize`, over the Session's `WorkspaceContainer`. */
export const ContainerTools: Effect.Effect<Extension, never, WorkspaceContainer> = Effect.map(
  Effect.all([ContainerRestart, ContainerResize]),
  (tools) => defineExtension({ name: extensionName, tools }),
);
