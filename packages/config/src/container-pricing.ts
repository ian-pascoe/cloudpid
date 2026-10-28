// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
// What a Workspace's Container costs to run (`docs/architecture/operations.md` → Usage): Cloudflare's list prices for
// Containers on the Workers Paid plan (https://developers.cloudflare.com/containers/pricing/, 2026-10), applied to each
// size's resources. Memory and disk are billed on the provisioned size for as long as the Container runs, CPU on active
// use only. The monthly allowance the plan includes is the account's, not a Workspace's, so it is not taken off.
import { INSTANCE_RESOURCES, type InstanceType } from "./container-settings.ts";

/** US dollars per unit-second. */
export const CONTAINER_PRICES = {
  /** Per GiB of provisioned memory, per second the Container runs. */
  memoryGibSecond: 0.0000025,
  /** Per vCPU, per second of active use. */
  vcpuSecond: 0.00002,
  /** Per GB of provisioned disk, per second the Container runs. */
  diskGbSecond: 0.00000007,
  /** Per GB sent out, North America and Europe. */
  egressGb: 0.025,
} as const;

/** What Cloudflare's usage analytics report for Containers (`containersUsageAdaptiveGroups`' `sum`). */
export type ContainerUsageSums = {
  readonly cpuTimeSec: number;
  /** Byte-seconds. */
  readonly allocatedMemory: number;
  /** Byte-seconds. */
  readonly allocatedDisk: number;
  readonly txBytes: number;
};

export const NO_USAGE_SUMS: ContainerUsageSums = {
  cpuTimeSec: 0,
  allocatedMemory: 0,
  allocatedDisk: 0,
  txBytes: 0,
};

/** `left` and `right` added. */
export const addUsageSums = (
  left: ContainerUsageSums,
  right: ContainerUsageSums,
): ContainerUsageSums => ({
  cpuTimeSec: left.cpuTimeSec + right.cpuTimeSec,
  allocatedMemory: left.allocatedMemory + right.allocatedMemory,
  allocatedDisk: left.allocatedDisk + right.allocatedDisk,
  txBytes: left.txBytes + right.txBytes,
});

/** What `sums` cost, in US dollars: memory in GiB-seconds, disk in GB-seconds, as Cloudflare bills them. */
export const usageSumsCost = (sums: ContainerUsageSums) => ({
  memory: (sums.allocatedMemory / 2 ** 30) * CONTAINER_PRICES.memoryGibSecond,
  disk: (sums.allocatedDisk / 1e9) * CONTAINER_PRICES.diskGbSecond,
  cpu: sums.cpuTimeSec * CONTAINER_PRICES.vcpuSecond,
  egress: (sums.txBytes / 1e9) * CONTAINER_PRICES.egressGb,
});

/** What a Container of one size costs per second, in US dollars: memory and disk while it runs, CPU per busy second. */
export type ContainerRates = {
  readonly memory: number;
  readonly disk: number;
  /** Every vCPU at full use: an upper bound on a busy second. */
  readonly cpu: number;
};

/** The per-second rates of a Container of size `instance`. */
export const containerRates = (instance: InstanceType): ContainerRates => {
  const { vcpu, memoryMib, diskMb } = INSTANCE_RESOURCES[instance];

  return {
    memory: (memoryMib / 1024) * CONTAINER_PRICES.memoryGibSecond,
    disk: (diskMb / 1000) * CONTAINER_PRICES.diskGbSecond,
    cpu: vcpu * CONTAINER_PRICES.vcpuSecond,
  };
};
