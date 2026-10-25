// What a Session's Containers cost together (`docs/spec.md` → Operations → Container cost): its Workspace's, and its
// Subagent Workspaces', each read by its own Workspace DO, summed into the one `ContainerUsage` the Session header shows.
import type { ContainerUsage } from "@cloudpid/protocol";
import * as Arr from "effect/Array";

/** `usage` brought forward to `asOf` at its own rates, as a client brings it to now (`liveContainerUsage`). */
const broughtTo = (usage: ContainerUsage, asOf: number): ContainerUsage => {
  const end = usage.until === null ? asOf : Math.min(asOf, usage.until);
  const ran = usage.running ? Math.max(0, end - usage.asOf) / 1000 : 0;
  const busy = usage.busy ? Math.max(0, asOf - usage.asOf) / 1000 : 0;
  const stopped = usage.until !== null && usage.until <= asOf;

  return {
    ...usage,
    runSeconds: usage.runSeconds + ran,
    memory: usage.memory + ran * usage.rates.memory,
    disk: usage.disk + ran * usage.rates.disk,
    cpu: usage.cpu + busy * usage.rates.cpu,
    asOf,
    running: usage.running && !stopped,
    rates: stopped ? { memory: 0, disk: 0, cpu: 0 } : usage.rates,
  };
};

/**
 * The Containers of `usages` as one: amounts summed as of the latest reading, the rates of those that still run summed
 * (CPU's of those a command runs on), and running until the last of them stops. The size is the first's: the Session's
 * own Workspace's. Null for none.
 */
export const sumContainerUsage = (usages: ReadonlyArray<ContainerUsage>): ContainerUsage | null => {
  const [first, ...rest] = usages;

  if (first === undefined) return null;

  if (rest.length === 0) return first;

  const asOf = Math.max(...Arr.map(usages, (usage) => usage.asOf));
  const now = Arr.map(usages, (usage) => broughtTo(usage, asOf));
  const running = Arr.filter(now, (usage) => usage.running);

  const sum = (pick: (usage: ContainerUsage) => number) =>
    Arr.reduce(now, 0, (total, usage) => total + pick(usage));

  const reported = Arr.map(now, (usage) => usage.reportedThrough);

  return {
    instance: first.instance,
    runSeconds: sum((usage) => usage.runSeconds),
    cpuSeconds: sum((usage) => usage.cpuSeconds),
    egressBytes: sum((usage) => usage.egressBytes),
    memory: sum((usage) => usage.memory),
    disk: sum((usage) => usage.disk),
    cpu: sum((usage) => usage.cpu),
    egress: sum((usage) => usage.egress),
    // The analytics cover all of it only up to the earliest of them.
    reportedThrough: Arr.some(reported, (through) => through === null)
      ? null
      : Math.min(...Arr.map(reported, (through) => through ?? 0)),
    asOf,
    running: running.length > 0,
    busy: Arr.some(now, (usage) => usage.busy),
    rates: {
      memory: sum((usage) => (usage.running ? usage.rates.memory : 0)),
      disk: sum((usage) => (usage.running ? usage.rates.disk : 0)),
      cpu: sum((usage) => (usage.busy ? usage.rates.cpu : 0)),
    },
    until:
      running.length === 0 || Arr.some(running, (usage) => usage.until === null)
        ? null
        : Math.max(...Arr.map(running, (usage) => usage.until ?? 0)),
  };
};
