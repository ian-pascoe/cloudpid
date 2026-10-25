// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
// What the composer's context ring shows of the Session's usage: how full the active branch's Context Window is, and
// its spend: the models' cost and its Workspace's Containers', which grows while a Container runs. The server sends the
// Containers' cost as of a moment and the rates since; this brings it to now.
import { INSTANCE_RESOURCES } from "@cloudpid/config";
import type { ContainerUsage, ContextUsage, SessionUsage } from "@cloudpid/protocol";

/** The share of the context window `context` fills, as a whole percentage from 0 to 100. */
export const contextPercent = (context: ContextUsage): number =>
  context.contextWindow <= 0
    ? 0
    : Math.min(100, Math.max(0, Math.round((context.tokens / context.contextWindow) * 100)));

/**
 * How near a context is to being compacted (or, with automatic compaction off, to its window): `full` at or past it,
 * `near` from 85% of it, else `ok`.
 */
export const contextLevel = (context: ContextUsage): "ok" | "near" | "full" => {
  const limit = context.compactAt ?? context.contextWindow;

  if (context.tokens >= limit) return "full";

  return context.tokens >= limit * 0.85 ? "near" : "ok";
};

/** The Containers' cost brought to a moment. */
export type LiveContainerUsage = {
  readonly memory: number;
  readonly disk: number;
  readonly cpu: number;
  readonly egress: number;
  readonly total: number;
  readonly runSeconds: number;
  readonly cpuSeconds: number;
  /** Whether it still grows after this moment, so the ring's breakdown should look again. */
  readonly growing: boolean;
};

/**
 * `container` at `now`: a Container that ran at its reading adds memory and disk for the time since, up to its idle
 * stop (`until`), and CPU (every vCPU busy) while a command ran.
 */
export const liveContainerUsage = (container: ContainerUsage, now: number): LiveContainerUsage => {
  const end = container.until === null ? now : Math.min(now, container.until);
  const ran = container.running ? Math.max(0, end - container.asOf) / 1000 : 0;
  const busy = container.busy ? Math.max(0, now - container.asOf) / 1000 : 0;
  const memory = container.memory + ran * container.rates.memory;
  const disk = container.disk + ran * container.rates.disk;
  const cpu = container.cpu + busy * container.rates.cpu;

  return {
    memory,
    disk,
    cpu,
    egress: container.egress,
    total: memory + disk + cpu + container.egress,
    runSeconds: container.runSeconds + ran,
    cpuSeconds: container.cpuSeconds + busy * INSTANCE_RESOURCES[container.instance].vcpu,
    growing: container.running && (container.until === null || now < container.until),
  };
};

/** What the breakdown shows as spent at `now`: the models' cost and the Containers'. */
export const totalSpend = (usage: SessionUsage, now: number): number =>
  usage.cost + (usage.container === undefined ? 0 : liveContainerUsage(usage.container, now).total);
