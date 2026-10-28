# Cheaper Container backends: research summary (2026-10-28)

Question: is there a cheaper backend for a Workspace's Container than Cloudflare Containers, with a large refactor acceptable? The trigger was more than $10 of Container compute in a few days.

| File                                                               | Covers                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| [`_brief.md`](_brief.md)                                           | Requirements, Cloudflare baseline, the reference workload every report prices                                       |
| [`code-coupling.md`](code-coupling.md)                             | How tied the code is to Cloudflare Containers, a `SandboxProvider` seam, and cost leaks found in the code           |
| [`hyperscalers-and-cloudflare.md`](hyperscalers-and-cloudflare.md) | Cloudflare pricing re-verified, cost levers; AWS, GCP and Azure options                                             |
| [`managed-sandboxes-a.md`](managed-sandboxes-a.md)                 | E2B, Daytona, Modal, Vercel Sandbox, Runloop, Northflank                                                            |
| [`managed-sandboxes-b.md`](managed-sandboxes-b.md)                 | Fly Machines, Fly Sprites, Morph, CodeSandbox, Blaxel, Freestyle, exe.dev, Koyeb, Railway, Beam, Hopx               |
| [`self-hosted.md`](self-hosted.md)                                 | Renting a box (Hetzner, OVH, Netcup, Oracle) and running Incus, Firecracker or E2B on it; reaching it from a Worker |

Prices and capabilities are cited in each file. Items the sources did not document are marked there.

## Conclusion

1. **Per hour, Cloudflare is already among the cheapest options for this workload.** It bills CPU only while it is busy, and most providers bill provisioned CPU for the whole time a sandbox runs. The reference workload (60 h a month on 2 vCPU / 6 GiB, 15 h of it busy) costs about **$5–6.5** on Cloudflare, or about $17–19 for a month at 3× the usage. Disk and egress are negligible (1 TB of egress is included). Memory held while the Container runs is about 95% of the idle cost.
2. **The $10 in a few days is a usage problem, not a price problem.** That rate is about $75–100 a month, 10–15× the reference workload. Containers are running far more than the owner's own sessions explain. The code shows several ways Containers start or stay up with nobody working (`code-coupling.md` §5):
   - The daily Build check boots a whole Container from the image just to run `git ls-remote`.
   - Each move of a default branch remakes the Build and then the spare.
   - A spare is refilled after every new Workspace, Subagent Workspaces included, and up to 3 Subagent Workspaces run in parallel by default.
   - A subagent's report starts its stopped Container to read unpushed work.
   - Every idle stop takes a 45–90 s snapshot at full memory, even when nothing changed.
   - An open preview page keeps its Container up indefinitely, and no watchdog caps how long a hold can last.

   Any per-use provider would bill these the same way.

3. **No managed sandbox provider is materially cheaper.** At list prices on the reference month:

   | Provider                                 | Reference month  | Heavy (3×) month | Notes                                                                             |
   | ---------------------------------------- | ---------------- | ---------------- | --------------------------------------------------------------------------------- |
   | **Cloudflare (today)**                   | **≈ $5–6.5**     | **≈ $17–19**     | $5 Workers Paid fee is paid anyway for the DOs                                    |
   | Beam VMs                                 | ≈ $4.3           | ≈ $13            | Memory pause, Docker, snapshots; whether a Worker can drive the API is unknown    |
   | Northflank                               | ≈ $6.6 + backups | ≈ $14.6          | No root-fs snapshot; pause wipes the disk; exec needs a Node relay                |
   | Morph                                    | ≈ $6.5           | ≈ $18.5          | Memory snapshots and branching; PTY only over SSH; Docker not documented          |
   | Fly Sprites                              | ≈ $7.3           | ≈ $19            | REST+WSS with PTY; fixed Ubuntu 25.10 image; no clone from checkpoint             |
   | Fly Machines                             | ≈ $8.4–10.6      | ≈ $20–22         | No streaming exec or PTY, no rootfs snapshot: most glue code                      |
   | Vercel Sandbox                           | ≈ $11.8          | ≈ $31            | Active-CPU billing, FUSE, ubuntu:26.04; PTY in the CLI only                       |
   | Daytona                                  | ≈ $12.7          | ≈ $33            | Full egress needs a $500 top-up tier; 10 GiB disk cap                             |
   | Modal                                    | ≈ $14.3          | ≈ $43            | Control plane is gRPC only, so a Worker cannot call it                            |
   | Blaxel                                   | ≈ $16            | ≈ $36            | Snapshots in private preview                                                      |
   | Runloop                                  | ≈ $19 (Basic)    | ≈ $58            | Suspend needs Pro ($250/mo)                                                       |
   | Freestyle                                | $50 floor        | $50              | Best feature fit (WS PTY, memory+disk snapshots, Docker, forward-auth previews)   |
   | E2B                                      | ≈ $10 + $150 Pro | ≈ $30 + $150     | Closest semantics (memory pause, templates, PTY), but Hobby caps a session at 1 h |
   | Azure Container Apps Sandboxes (preview) | ≈ $13            | —                | Memory+disk snapshots, PTY, REST/WS; storage billing "coming soon"                |

   Hyperscaler serverless is ruled out: Fargate, Cloud Run, Lambda and ACI either give no Docker or FUSE, or have no snapshots. Spot VMs (EC2 ≈ $5, GCE ≈ $8 a month) are cheap, but you build the control plane yourself and start times are slower.

4. **Only a flat-rate self-hosted box beats Cloudflare, and only at the current burn rate.** Cost no longer depends on usage, so concurrency, previews and idle time stop costing money.

   | Box                                                         | Price / month      | KVM | Fits                                               |
   | ----------------------------------------------------------- | ------------------ | --- | -------------------------------------------------- |
   | Netcup RS 2000 (8 cores, 16 GB, 256 GB NVMe, 12-month term) | €40.70             | ✗   | Incus system containers only; about 2–3 Workspaces |
   | OVH Kimsufi KS-A (Ryzen, 32–64 GB)                          | from $43.20        | ✓   | Incus containers or VMs, Firecracker, E2B          |
   | Hetzner AX41 (64 GB, NVMe RAID1, no setup fee)              | €59                | ✓   | About 9–14 Workspaces of 2 vCPU / 6 GiB            |
   | Hetzner AX42 (Zen4, DDR5 ECC)                               | €79–99 + €49 setup | ✓   | Same, newer hardware                               |

   Hetzner Cloud and Netcup give no nested virtualization, and Hetzner Cloud bills stopped servers. Oracle's free Ampere tier is 2 OCPU / 12 GB, arm64, and can be reclaimed when idle. Break-even against Cloudflare is about **$45–70 a month** of Container spend. After the leaks in point 2 are fixed, spend should fall far below that, unless the real usage is genuinely heavy.

## Measured usage (October 2026, read 2026-10-28)

Sources: Cloudflare's billable usage API, the Containers instance list, and Workers Observability logs of the Workspaces Worker, all for the whole account (prod and PR preview stages together).

| Line                                      | Quantity    | Billed (after the plan's allowance) |
| ----------------------------------------- | ----------- | ----------------------------------- |
| Container memory                          | 1,130 GiB-h | $9.94                               |
| Container vCPU                            | 83 vCPU-h   | $5.54                               |
| Container disk                            | 2,059 GB-h  | $0.47                               |
| Container egress                          | 24 GB       | $0 (1 TB included)                  |
| Dynamic Workers, Browser Run, DO requests |             | $1.33                               |

- **Container-hours per day:** Oct 22 ≈ 6, Oct 23 ≈ 24, Oct 25 ≈ 12, Oct 26 ≈ 57, Oct 27 ≈ 54. That is roughly 2.3 Containers running around the clock on the busiest days. These figures are disk GB-h divided by the 12 GB disk.
- **Average memory per running Container is about 6.8 GiB, against the 3 GiB default.** The last run of each prod Workspace Container was on:

  | Size            | Workspaces |
  | --------------- | ---------- |
  | 4 vCPU / 12 GiB | 61         |
  | 2 vCPU / 8 GiB  | 20         |
  | 2 vCPU / 6 GiB  | 26         |
  | 1 vCPU / 3 GiB  | 1          |

  The agent resized only once (`custom-1` → `custom-2`), so the large sizes come from the Environment's saved size. Memory is 62% of the bill.

- **CPU averaged about 0.5 vCPU busy per running Container.** The 4-vCPU size lets parallel tools (Turborepo, Vitest workers, `tsc`) burn more vCPU-seconds.
- **14 idle snapshots failed** because the scan for Secrets did not finish in 30 s. **3 were skipped** because a GitHub token was found in `/root/.gitconfig` and in computerd's store, which means in a Workspace file. Such a Workspace cannot take another snapshot until the file is cleaned. Its next launch restores an older snapshot and runs its Setup Scripts again.
- **Background Containers:**
  - 16 spare preparations in three days, each 1–2 min plus a snapshot
  - about 10 Builds of 1–4 min
  - 2 Test Builds
  - PR preview stages launching their own Containers (`pr-217` launched 27 on Oct 26)
- Seven PR stages' Container applications (`pr-148` … `pr-316`) and two `commissary-sandboxsession-*` applications exist on the account with no instances. They cost nothing.

## What a migration involves

The refactor is smaller than it looks (`code-coupling.md` §1–4):

- **One place to change.** Every `ctx.container` call is in `Workspace.ts`'s constructor (about 20 sites), plus one exec in `snapshots.ts`. Launch, snapshots, idle stop, resize, Builds, spares, usage and previews already take their host through injected dependencies.
- **computerd is portable.** It is MIT-licensed and ships as a standalone linux-x64 binary. `@cloudflare/computer` reaches it with a few HTTP requests and one WebSocket, behind a host interface that cloudpid already wraps (`IWorkspaceContainerAPI`). A remote backend can open a TLS WebSocket through a Cloudflare Tunnel with an Access service token, so no public port is needed. Its protocol is marked Experimental.
- **Requirements are set by computerd and the Snapshot design.** A target needs `/dev/fuse` with libfuse 3.17 or newer, a root-filesystem snapshot that can be restored into another sandbox (for Builds and spares), and Docker in the guest. That narrows the list:
  - Self-hosted Incus (VMs for certain; containers need FUSE checked), or Firecracker / E2B self-host on a KVM box
  - E2B, Freestyle, Vercel Sandbox, Beam (if its API works from a Worker), Daytona's Linux VM class
- **Main risk:** computer syncs files before and after every command. Over the internet, from a Cloudflare PoP to a box in Germany, each sync costs round-trips that today are in-datacentre. Measure this before committing (§6 step 3).
- **Effort:** the seam plus a Cloudflare implementation with no behaviour change is M. A remote-computerd backend is M. Each managed-provider adapter is M. The self-hosted box with its gateway is L. Dropping computerd entirely is XL and not recommended.

## Recommended order

1. **Measure:** set `CLOUDPID_ANALYTICS_TOKEN` (with `CLOUDFLARE_ACCOUNT_ID`) on prod, or read the dashboard's Containers usage filtered by the `cloudpid-ws=<DO id>` label. This shows whether `build:*`, `test-build:*`, spare or subagent objects make up the hours.
2. **Fix the leaks** (all small, no architecture change; `code-coupling.md` §5):
   - a maximum-runtime watchdog, and an end to previews holding a Container indefinitely
   - `ls-remote` from the DO instead of from a Container
   - no idle snapshot when nothing ran
   - unpushed-work reads through isomorphic-git
   - spares refilled lazily, or switched off
   - Builds remade on a config change or weekly, not on every branch move
   - `maxSubagentWorkspaces` default 1

   This is the change most likely to bring the bill to single dollars a month.

3. **If spend still exceeds about $45 a month:** add the `SandboxProvider` seam, then spike a remote computerd on a Kimsufi KS-A or a Hetzner AX41 running Incus behind a Tunnel. Measure per-command sync overhead, `pnpm install`, and snapshot and restore times, and decide go or no-go on those numbers. Keep Cloudflare as a per-Environment fallback.
4. **Move to a managed provider for features, not cost.** If memory pause/resume (instant warm restores, no 45–90 s idle snapshot) becomes worth paying for, prototype Freestyle and E2B.
