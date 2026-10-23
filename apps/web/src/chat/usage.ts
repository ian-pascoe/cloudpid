// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
// What the Session's header shows of its spend: the models' cost and its Workspace's Containers', which grows while a
// Container runs. The server sends the Containers' cost as of a moment and the rates since; this brings it to now.
import { INSTANCE_RESOURCES } from "@cloudpid/config";
import type { ContainerUsage, SessionUsage } from "@cloudpid/protocol";

/** The Containers' cost brought to a moment. */
export type LiveContainerUsage = {
  readonly memory: number;
  readonly disk: number;
  readonly cpu: number;
  readonly egress: number;
  readonly total: number;
  readonly runSeconds: number;
  readonly cpuSeconds: number;
  /** Whether it still grows after this moment, so the header should look again. */
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

/** What the header shows as spent at `now`: the models' cost and the Containers'. */
export const totalSpend = (usage: SessionUsage, now: number): number =>
  usage.cost + (usage.container === undefined ? 0 : liveContainerUsage(usage.container, now).total);
