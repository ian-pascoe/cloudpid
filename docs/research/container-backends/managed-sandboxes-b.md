# Managed sandbox / VM providers (batch B): Fly Machines, Sprites, Morph, CodeSandbox, Blaxel, Freestyle, exe.dev, Koyeb, Railway, Hopx, Beam

Read 2026-10-28 from primary sources (official pricing pages, docs, OpenAPI). Every claim has a URL; "not documented" means I looked and did not find it. Several vendor docs are marked preview/beta; these products change fast, so re-verify before committing.

Reference workload (from `_brief.md`): 60 h/month running on a 2 vCPU / 4 GiB (6 GiB where noted) / 12-20 GB sandbox. 15 h at ~100% of 2 vCPU, 45 h at ~5%. Plus 3 golden snapshots (~3 GB each), ~10 workspace snapshots (~2 GB each) kept all month, 20 GB egress. "Heavy" = 3× running time (180 h; 45 h busy).

Shared CPU arithmetic: busy = 15 h × 2 = 30 vCPU-h; idle = 45 h × 2 × 0.05 = 4.5 vCPU-h; **34.5 active vCPU-h** (heavy 103.5).
Snapshot footprint: 3×3 + 10×2 = **29 GB**.

## TL;DR

| Provider                                      | Ref month                        | Heavy month               | Fit for cloudpid                             | One-line verdict                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------- | ------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CF Containers (brief baseline, my arithmetic) | ≈ $5.4                           | ≈ $16.8                   | n/a                                          | 4 GiB×60 h×$0.009 = 2.16; 34.5 vCPU-h×$0.072 = 2.48; 20 GB disk ≈ 0.30; egress 0.50. Not verified against the CF page.                                                                    |
| **Beam VMs**                                  | **≈ $4.3**                       | ≈ $13                     | Good on paper                                | Cheapest. Persistent microVM, pause with RAM, Docker+Compose documented, FS snapshots, fork. Open question: can a Worker drive it (JS SDK is Node-targeted, REST for VMs not documented). |
| **Fly Sprites**                               | ≈ $7.3                           | ≈ $19                     | Good API fit, weak on golden images          | Bills actual CPU and actual RAM, so idle is nearly free. Full WS exec/PTY/FS/checkpoint REST API. Fixed Ubuntu 25.10 image, no documented clone-from-checkpoint, Docker unclear.          |
| Fly Machines                                  | ≈ $8.4-10.6                      | ≈ $20-22                  | Needs glue                                   | Cheap per hour but no rootfs snapshot, no streaming/PTY exec in REST, suspend capped at 2 GB. Most plumbing to write.                                                                     |
| Morph Cloud                                   | ≈ $6.5                           | ≈ $18.5                   | Good (snapshots/branching)                   | $0.10/h for 2 vCPU/4 GB, paused = storage only. Exec is REST/SSE, PTY only via SSH. Docker not documented.                                                                                |
| CodeSandbox SDK (Together)                    | $3-9 (Build plan) / $170 (Scale) | $21-27 / $170             | Memory snapshots yes, Worker control unclear | Best memory-snapshot story (0.5-2 s resume), but fixed VM tiers, Node SDK, 20 GB disk. Together successor SDK is access-gated.                                                            |
| Blaxel                                        | ≈ $16                            | ≈ $36                     | Good (25 ms resume)                          | Billed by allocated memory only (CPU free) while active, $0.20/GB-mo for standby snapshots. Snapshots/fork = private preview.                                                             |
| Freestyle                                     | **$50** (Hobby minimum)          | $50                       | Strong feature fit                           | Persistent VMs, memory-preserving pause, Docker from boot, PTY WS, snapshots. Usage is inside the $50 minimum. 24.04 base. Free tier cannot persist.                                      |
| exe.dev                                       | $15 flat (or $21 w/ standalone)  | $15 (1 sandbox at a time) | Weak                                         | Flat pool pricing, not per-use. No PTY over HTTPS, no documented snapshots.                                                                                                               |
| Railway                                       | ≈ $20                            | ≈ $58                     | Poor                                         | Pays memory held; idle sandboxes are destroyed; checkpoints are disk only.                                                                                                                |
| Koyeb                                         | ≈ $1.7-3.5 + plan                | ≈ $5-10 + plan            | Fails requirements                           | Cheap but sandboxes are ephemeral; volumes 1-10 GB, ≤1 instance, two regions; no sandbox snapshots.                                                                                       |
| Hopx                                          | ≈ $10                            | ≈ $30                     | Weak/unclear                                 | Per-second, no minimum; pause exists; sandboxes auto-delete on timeout; stopped/paused billing and snapshots not documented.                                                              |

**Observation:** at this workload CF is itself only ≈ $5-6/month by the brief's rates, so no provider here is dramatically cheaper per month. The big spend risk is hours of running time (forgetting to stop, or memory held while idle), not the unit price. Providers that bill actual use and stop quickly (Sprites, Blaxel standby, Beam idle-pause, Freestyle idle-pause, Morph pause) are the ones that actually cap that risk. Real savings come from making idle time free, not from a lower $/h.

---

## 1. Fly.io Machines

### Pricing (https://docs.fly.io/about/pricing/, https://fly.io/docs/about/pricing/)

| Item                                                | Price                                                                                                                                               |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Started Machine, per second (no minimum documented) | `shared-cpu-2x` 2 GB $13.39/mo; `performance-1x` 2 GB $33.00/mo; `performance-2x` 4 GB $66.00/mo (30-day month, iad/ewr cheapest; varies by region) |
| Extra RAM                                           | $6.00/GB/month                                                                                                                                      |
| Stopped or suspended Machine                        | $0.15/GB/month of rootfs only                                                                                                                       |
| Volume                                              | $0.15/GB/month provisioned, billed pro-rated to the hour, including when detached or on a stopped Machine                                           |
| Volume snapshots                                    | $0.08/GB/month, first 10 GB free; based on stored (incremental) size                                                                                |
| Egress                                              | $0.02/GB NA/EU, $0.04 APAC/SA, $0.12 Africa/India; inbound free                                                                                     |
| Plan fee                                            | none; builders and registry storage currently free ("may start charging")                                                                           |
| Reservation blocks                                  | 40% off via prepaid yearly blocks ($36/yr for $5/mo shared; $144/yr for $20/mo performance)                                                         |

Shared CPUs are throttled to 5 ms per 80 ms (6.25% per vCPU, shared across vCPUs) with a 500 s max burst balance (https://docs.fly.io/machines/cpu-performance/). A `shared-cpu-2x` is therefore unusable for tsc/vitest/pnpm builds. Use `performance`.

### Worked cost

`performance-2x` 4 GB = $66/720 h = **$0.0917/h** (6 GiB: +$12/mo = $0.108/h). Busy and idle cost the same.

| Line                                                                    | Ref (60 h) | Heavy (180 h) |
| ----------------------------------------------------------------------- | ---------- | ------------- |
| Compute (perf-2x, 4 GiB)                                                | $5.50      | $16.50        |
| Volume 20 GB created per session, prorated                              | $0.25      | $0.75         |
| Volume snapshots: 29 GB stored − 10 free = 19 × $0.08                   | $1.52      | $1.52         |
| Stopped rootfs (~1.5 GB × 3 Machines × $0.15)                           | ~$0.70     | ~$0.70        |
| Egress 20 GB × $0.02                                                    | $0.40      | $0.40         |
| **Subtotal**                                                            | **≈ $8.4** | **≈ $19.9**   |
| + always-on router app for Worker→Machine (shared-cpu-1x 256 MB, $2.19) | ≈ $10.6    | ≈ $22.1       |

If instead each of 10 workspaces keeps a persistent 15 GB volume: +10 × 15 × $0.15 = **+$22.50/mo**. Snapshot retention is max 60 days (https://docs.fly.io/volumes/snapshots/), so "kept all month" works but "kept forever" does not.

### Capability table

| Requirement                                | Status     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu 26.04 image, 1.5 GB+, any OCI image | ✓          | Any OCI image runs as Firecracker VM, root access (https://fly.io/docs/machines/overview/). Registry storage free.                                                                                                                                                                                                                                                                                                                                                                           |
| Sizes 1-4 vCPU / 3-12 GiB                  | ✓          | Perf CPUs with extra RAM at $6/GB-mo. x86_64 only.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Docker inside (overlay2, cgroup v2)        | partial    | Community reports dockerd works on Machines and overlay2 is supported (https://github.com/teovillanueva/code-runner/blob/main/docs/deploy-fly.md, https://community.fly.io/t/docker-in-docker-on-fly/3674). Not in official docs; the docs example shows a 5.15 kernel. Test cgroup v2 + overlay2.                                                                                                                                                                                           |
| Streaming exec                             | ✗ via REST | `POST /v1/apps/{app}/machines/{id}/exec` returns whole stdout/stderr/exit code in one response (`timeout`, `stdin` fields). No streaming (https://docs.fly.io/api/machines/machines/execute-command.md).                                                                                                                                                                                                                                                                                     |
| PTY exec w/ resize                         | ✗ via API  | `fly ssh console` uses WireGuard/SSH. You would run your own WS server (computerd) in the VM.                                                                                                                                                                                                                                                                                                                                                                                                |
| FUSE                                       | ✓ (likely) | Own kernel, root; not explicitly documented.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Rootfs disk snapshots                      | ✗          | Rootfs is ephemeral and resets on stop (https://docs.fly.io/volumes/overview/). Only volumes snapshot.                                                                                                                                                                                                                                                                                                                                                                                       |
| Volume snapshots / golden snapshots        | ✓          | Daily auto (5-day default, 1-60 days), on-demand via API (beta), restore to a new volume via `snapshot_id`, fork via `source_volume_id` (https://docs.fly.io/machines/api/volumes-resource/). Put `/workspace` + `/var/lib/docker` on the volume. Take 1-3 GB snapshots async; timing not documented.                                                                                                                                                                                        |
| Memory snapshot                            | partial    | `suspend` uses Firecracker snapshots, resume in "a few hundred ms", but **≤ 2 GB RAM**, no swap, snapshot can be dropped on host migration/deploy (https://fly.io/docs/reference/suspend-resume/). Not usable for 3-12 GiB.                                                                                                                                                                                                                                                                  |
| Scale to zero (2 min idle)                 | ✓          | Start in "well under a second" for existing stopped Machine; you own the idle timer. Fly Proxy autostop only for HTTP traffic.                                                                                                                                                                                                                                                                                                                                                               |
| Outbound internet                          | ✓          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Inbound previews                           | partial    | Flycast = private IPv6 via Fly Proxy, with autostart/stop (https://docs.fly.io/networking/flycast/). **Not reachable from a Cloudflare Worker** without WireGuard. Pattern: per-user app + public router app issuing `fly-replay: app=…;instance=…;state=<key>` (https://docs.fly.io/networking/dynamic-request-routing/, https://docs.fly.io/blueprints/connecting-to-user-machines.md). Replay starts a stopped Machine and works for WebSockets. Auth is yours (check `state` in the VM). |
| Control from Worker                        | ✓          | REST `https://api.machines.dev`, bearer token (https://docs.fly.io/machines/api/working-with-machines-api/).                                                                                                                                                                                                                                                                                                                                                                                 |

### Limits and gotchas

- Machines API rate limit: 1 req/s per action per Machine, burst 3 (Get Machine 5/s, burst 10).
- Volumes are local NVMe on one host. A stopped Machine with a volume can only start on that host, so capacity errors (`insufficient_capacity`, `volume_placement_capacity`) are possible. Single-volume loss = data loss; snapshots are the backup (https://docs.fly.io/volumes/overview/).
- Create a volume with a `compute` size hint so it lands on a host with room for the Machine.
- Stop/restart wipes rootfs; anything not on the volume is rebuilt from the image.
- Memory snapshot suspend is effectively out for your sizes.
- Needs a PTY/exec agent in the VM and a router app: the most glue code of anything in this doc.

---

## 2. Fly.io Sprites (sprites.dev)

### Pricing (https://fly.io/sprites, https://fly.io/pricing, https://sprites.dev)

| Resource                                                                                                                                                       | Rate                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CPU                                                                                                                                                            | $0.0385 / CPU-hour, from `cpu.stat` cumulative usage (actual CPU consumed, not allocated)                                                                                                                                |
| Memory                                                                                                                                                         | $0.021875 / GB-hour of actual memory use                                                                                                                                                                                 |
| Hot storage                                                                                                                                                    | $0.000683/GB-h (≈ $0.50/GB-mo), only while awake                                                                                                                                                                         |
| Cold storage                                                                                                                                                   | $0.000027/GB-h (≈ $0.02/GB-mo), as long as data exists                                                                                                                                                                   |
| Egress                                                                                                                                                         | "Sprites bandwidth isn't metered today"                                                                                                                                                                                  |
| Plan fee                                                                                                                                                       | Pricing page: "No plans and no tiers". The sprites.dev FAQ also mentions optional plans (Hero $100/mo etc.) with included allowances: contradictory; treat pay-as-you-go as the baseline. New orgs get $30 trial credit. |
| Running = billed; warm (suspended) and cold = not billed for compute. Idle window ≈ 30 s before it pauses (https://docs.fly.io/sprites/concepts/lifecycle.md). |

### Worked cost (my assumptions: avg 3 GiB actual RAM while awake; 12 GB hot data; 10 sprites × 5 GB cold + 29 GB snapshots)

| Line                                                                                           | Ref        | Heavy       |
| ---------------------------------------------------------------------------------------------- | ---------- | ----------- |
| CPU 34.5 / 103.5 CPU-h × $0.0385                                                               | $1.33      | $3.98       |
| Memory 3 GiB × 60/180 h × $0.021875                                                            | $3.94      | $11.81      |
| Hot storage 12 GB × h × $0.000683                                                              | $0.49      | $1.48       |
| Cold storage (29 GB ckpt + 50 GB sprite data) × 730 h × $0.000027                              | $1.56      | $1.56       |
| Egress                                                                                         | $0         | $0          |
| **Total**                                                                                      | **≈ $7.3** | **≈ $18.8** |
| At 4 GiB average memory add ≈ $1.3 / $3.9. Fly's own Claude Code example: 4 h session = $0.23. |

### Capability table

| Requirement                        | Status           | Notes                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ubuntu 26.04 / own image           | ✗                | Fixed Ubuntu 25.10 base with toolchains preinstalled (https://docs.fly.io/sprites/working-with-sprites.md). Custom OCI image not documented. Install mise toolchains on first boot or into a checkpoint.                                                                                        |
| Sizes                              | ✗                | 8 vCPU, memory "managed by the platform" and autoscaled, 100 GB disk, none configurable (https://docs.fly.io/sprites/concepts/lifecycle.md). A resources policy endpoint exists (`/policy/resources`) but is undocumented here.                                                                 |
| Docker inside                      | partial          | Fly's comparison page says Docker inside = Yes (https://fly.io/learn/sprites-vs-e2b-vs-modal-vs-daytona); a community thread (Feb 2026) shows users struggling to get dockerd running (https://community.fly.io/t/how-to-get-docker-running-on-sprites/27168/12). Must test overlay2/cgroup v2. |
| Streaming exec                     | ✓                | `WSS /v1/sprites/{name}/exec`, stdin 0x00 / stdout 0x01 / stderr 0x02 frames; sessions persist across disconnect (https://sprites.dev/api/sprites/exec). Plain `POST /exec` also exists.                                                                                                        |
| PTY w/ resize                      | ✓                | `tty=true`, JSON `{"type":"resize","cols":..,"rows":..}`; attach/list/kill sessions.                                                                                                                                                                                                            |
| FUSE                               | not documented   | Own VM with root, so likely.                                                                                                                                                                                                                                                                    |
| Disk snapshots                     | ✓                | Checkpoint ≈ 1 s per marketing, 10-30 s per docs (https://docs.fly.io/sprites/working-with-sprites.md); live, copy-on-write, automatic on idle/after work. REST: create/list/get/restore (`/v1/sprites/{name}/checkpoint(s)`).                                                                  |
| Golden snapshots for new sandboxes | ✗/not documented | API only shows restore of a Sprite to its own checkpoint. No "create Sprite from checkpoint" documented.                                                                                                                                                                                        |
| Memory snapshot                    | partial          | Warm state = VM suspended, processes preserved, resume 100-500 ms; cold = processes lost, 1-2 s. Not a user-addressable snapshot. Docs conflict on whether checkpoints include RAM: one page says disk only, another lists "in-memory state".                                                   |
| Scale to zero                      | ✓                | ~30 s idle → warm; wakes on API call, exec, or HTTPS request. Tasks API to hold active (max 1 h, renewable).                                                                                                                                                                                    |
| Outbound internet                  | ✓                | Network policy API to restrict.                                                                                                                                                                                                                                                                 |
| Inbound previews                   | ✓                | `https://<name>-<org>.sprites.app`, wakes on request, routes to 8080/first HTTP port, org-auth by default or public. Whether a bearer token from a Worker works against the URL is not documented.                                                                                              |
| Control from Worker                | ✓                | Pure REST + WSS with bearer (https://api.sprites.dev/openapi.json). Also FS REST (read/write/list/copy), services, usage API. JS SDK `@fly/sprites`.                                                                                                                                            |

### Limits and gotchas

- Org limits by plan, e.g. Hero 100 concurrently running; PAYG creation rate 10/min.
- Idle detection counts open TCP connections and exec output; background processes with no output do not keep it awake.
- Open TCP connections never survive a pause.
- Storage is S3-backed with an NVMe cache; the `S3 Block Device` variant is early access.
- Destroying a Sprite deletes its checkpoints.

---

## 3. Morph Cloud (Infinibranch)

### Pricing (https://cloud.morph.so/pricing)

- 1 **MCU** = 1 vCPU-h + 4 GB RAM-h + 16 GB disk-h, **or** 5 TB snapshot-hours. Standard MCU rate **$0.05**.
- Instance MCU/h = max(vCPUs, ceil(RAM/4 GiB), ceil(disk/16 GiB)) (stated for Devboxes; same MCU basis for MorphVMs).
- Paused instance: "stops consuming MCUs; you only get charged for the snapshot taken" (https://cloud.morph.so/docs/documentation/instances/pause-resume).
- Plans (page layout is garbled; as I read it): Developer $0 (buy MCUs PAYG), Team $40/mo (1,000 MCUs = $50 value), Scale $250/mo (7,500 MCUs). Developer caps: 64 vCPU/256 GB per instance, 8 concurrent / 32 total devboxes.
- Snapshot example from the page: 8 vCPU / 8 GB RAM / 8 GB disk snapshot = $0.12/month, so a snapshot costs about (RAM+disk GB) × 730 h ÷ 5 TB-h × $0.05.
- Egress: not documented on the pricing page.

### Worked cost

2 vCPU / 4 GiB / 16-20 GB = **2 MCU/h = $0.10/h**, busy or idle. (6 GiB and 20 GB disk are also 2 MCU.)

| Line                                                                    | Ref            | Heavy            |
| ----------------------------------------------------------------------- | -------------- | ---------------- |
| Compute 60/180 h × $0.10                                                | $6.00          | $18.00           |
| Snapshots, 29 GB disk-only ≈ $0.21; with ~4 GB RAM per snapshot ≈ $0.76 | $0.2-0.8       | $0.2-0.8         |
| Egress                                                                  | not documented | not documented   |
| **Total**                                                               | **≈ $6.2-6.8** | **≈ $18.2-18.8** |

### Capability table

| Requirement                               | Status         | Notes                                                                                                                                                                                  |
| ----------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Own image                                 | partial        | Create from `morphvm-minimal` image or snapshot; build via exec/snapshots. OCI/Dockerfile import not verified.                                                                         |
| Sizes                                     | ✓              | Arbitrary vCPU/RAM/disk up to 64 vCPU/256 GB (Developer).                                                                                                                              |
| Docker inside                             | not documented | Full VM, so likely.                                                                                                                                                                    |
| Streaming exec                            | ✓              | `POST /api/instance/{id}/exec` (stdout/stderr/exit code) and `exec-sse` streaming (https://cloud.morph.so/docs/api-reference/exec-instance-instance-id-exec-post).                     |
| PTY                                       | ✗ via HTTP     | SSH (`ssh.cloud.morph.so`) only (https://cloud.morph.so/docs/documentation/instances/ssh). A Worker would need raw TCP/SSH or an in-VM WS PTY server behind an exposed HTTP service.   |
| Disk + memory snapshots, golden templates | ✓              | Snapshot, branch (N clones from a live instance), boot-from-snapshot API; "snapshot/branch/restore in < 250 ms" claim (https://cloud.morph.so/docs/developers). Snapshots support TTL. |
| Memory snapshot / pause                   | ✓              | Pause = new snapshot + suspend; resume restores processes.                                                                                                                             |
| Scale to zero                             | ✓              | `ttl` with action `pause` or `stop`; `wake_on_http` and `wake_on_ssh` (REST exec needs `wake_on_ssh`) (https://cloud.morph.so/docs/documentation/instances/wake-on).                   |
| Outbound internet                         | not documented |                                                                                                                                                                                        |
| Inbound previews                          | ✓              | `expose-http-service` gives public URL; auth options not verified.                                                                                                                     |
| Control from Worker                       | ✓ (REST)       | REST API with API key; Python/TS SDKs.                                                                                                                                                 |

### Gotchas

- Instance size is chosen at boot from the snapshot; MCU billing is by allocated size, not use.
- Free "Developer" tier has no starting credit: you must buy MCUs.
- Wake-on-exec relies on SSH wake setting.

---

## 4. CodeSandbox SDK (now Together AI)

### Pricing

Legacy SDK (self-serve at codesandbox.io; docs https://docs.together.ai/docs/together-code-sandbox-legacy; codesandbox.io pages returned 403 to me, so plan details come from Together docs and search excerpts of https://codesandbox.io/docs/sdk/pricing):

- Credits **$0.01486 each**; billed in **minutes (rounded up)**.
- Nano 2 vCPU/4 GB = 10 credits/h = **$0.1486/h**; Micro 4 vCPU/8 GB = $0.2972/h; Small 8/16 = $0.5944/h. Pico 2/1 GB = $0.0743/h.
- Plans: Build (free) 10 concurrent VMs, 400 credits/month (https://codesandbox.io/docs/learn/credit-usage/credits, excerpt); Scale = $170/mo base, 250 concurrent, 1,100 credits included (Together example).
- Storage per VM fixed at 20 GB (https://codesandbox.io/docs/learn/environment/vm). Hibernated snapshot storage cost: not documented. Egress: not documented.

New `together-sandbox` SDK (Docker-image snapshots, **access gated via sales**, https://docs.together.ai/docs/together-code-sandbox): $0.0446/vCPU-h + $0.0149/GiB-h (https://www.together.ai/pricing), custom `cpu` 0.1-16 and 1-8 GB/CPU, shared filesystem $0.16/GiB-mo. 2 vCPU/4 GiB = **$0.1488/h**. Billing granularity not documented.

### Worked cost (legacy Nano)

| Line                                                                               | Ref                                                                             | Heavy   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------- |
| 600 / 1,800 credits gross                                                          | $8.92                                                                           | $26.75  |
| Build plan (400 free credits) net                                                  | ≈ $2.97                                                                         | ≈ $20.8 |
| Scale plan                                                                         | $170 flat (covers 1,100 credits; heavy overage 700 × $0.01486 = $10.4 → ≈ $180) | ≈ $180  |
| Together new SDK: 60 h × $0.1488 = $8.93; 180 h = $26.8 (+ storage, undocumented). |

### Capability table

| Requirement             | Status          | Notes                                                                                                                                                                                                                                                                                                                                            |
| ----------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Image                   | partial         | Template/Dev Container (Dockerfile) inside the VM; the Together SDK builds from Docker images. Dev Containers run rootless Podman as non-root, so "docker-in-docker features won't work" (https://codesandbox.io/docs/learn/environment/devcontainers, https://codesandbox.io/docs/learn/environment/docker). dockerd with overlay2 is doubtful. |
| Sizes                   | partial         | Fixed tiers only (no 2 vCPU/6 GiB or 3 vCPU/12 GiB: next is 4/8 then 8/16). Together SDK allows custom.                                                                                                                                                                                                                                          |
| Streaming exec / PTY    | ✓               | SDK `commands.run`, terminals; Firecracker VM with an in-VM agent over WebSocket. Raw protocol not documented; SDK is Node/browser (`@codesandbox/sdk/browser`). A Worker would need the browser build or a custom WS client (untested).                                                                                                         |
| FUSE                    | not documented  |                                                                                                                                                                                                                                                                                                                                                  |
| Memory + disk snapshots | ✓               | Hibernate = memory snapshot, resume 0.5-2 s (disk-only 5-20 s); fork 1-3 s from hibernated; templates are memory+FS snapshots (https://codesandbox.io/docs/sdk/core-concepts, https://codesandbox.io/docs/sdk/create). Hibernated sandboxes kept on disk up to 7 days then archived to slower long-term storage.                                 |
| Scale to zero           | ✓               | Hibernation timeout configurable (max 86400 s), auto-wake on access.                                                                                                                                                                                                                                                                             |
| Inbound previews        | ✓               | `https://$ID-$PORT.csb.app`, private mode needs signed host token (https://codesandbox.io/docs/sdk/sandbox-hosts).                                                                                                                                                                                                                               |
| Control from Worker     | partial/unknown | Token-authenticated SDK; REST surface not documented; Together successor is CLI/SDK-first.                                                                                                                                                                                                                                                       |

### Gotchas

- Rounded-up minutes bite short bursts.
- Concurrency caps (10 on Build, 250 Scale); plan tier decides persistence.
- Legacy SDK is described as deprecated in Together docs; successor requires sales enablement.

---

## 5. Blaxel sandboxes

### Pricing (https://blaxel.ai/pricing)

| Item                                                                                                                                      | Rate                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox active time                                                                                                                       | **$0.0000115/GB-RAM-second ($0.0414/GB-h)**; CPU is not billed separately: allocated as memory MB / 2048 vCPU (4 GiB → 2 vCPU, 8 GiB → 4, 16 GiB → 6) (https://docs.blaxel.ai/Sandboxes/Overview, https://docs.blaxel.ai/api-reference/compute/create-sandbox) |
| Standby (suspended)                                                                                                                       | no compute; pays snapshot storage                                                                                                                                                                                                                              |
| Snapshot storage (memory+FS standby snapshots)                                                                                            | $0.20/GB-month                                                                                                                                                                                                                                                 |
| Images                                                                                                                                    | $0.045/GB-month                                                                                                                                                                                                                                                |
| Volumes                                                                                                                                   | $0.12/GB-month provisioned                                                                                                                                                                                                                                     |
| Egress                                                                                                                                    | included                                                                                                                                                                                                                                                       |
| Plan                                                                                                                                      | pay-as-you-go with prepaid credits; free credits up to $200; tiers by top-up (Tier 0 free: 10 sandboxes; Tier 1 $20/mo: 50; Tier 2 $50/mo: 200)                                                                                                                |
| Tier 0 / 1 sandboxes expire after 7 / 30 days; higher tiers allow unlimited persistence (https://docs.blaxel.ai/Sandboxes/Expiration.md). |

### Worked cost (4 GiB sandbox = 2 vCPU)

| Line                                                                                                               | Ref         | Heavy       |
| ------------------------------------------------------------------------------------------------------------------ | ----------- | ----------- |
| 4 GiB × 60/180 h × $0.0414                                                                                         | $9.94       | $29.81      |
| Standby snapshots 29 GB × $0.20 (actual standby size not documented; RAM may add)                                  | $5.80       | $5.80       |
| 3 golden images × 3 GB × $0.045                                                                                    | $0.41       | $0.41       |
| Egress                                                                                                             | $0          | $0          |
| **Total**                                                                                                          | **≈ $16.2** | **≈ $36.0** |
| (6 GiB = 3 vCPU: $14.9 compute for 60 h.) Busy vs idle same; time with no open connection is standby and unbilled. |

### Capability table

| Requirement         | Status         | Notes                                                                                                                                                                                                                                                                                                                        |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom image        | ✓              | Custom template images via `bl deploy`; public images `blaxel/base-image`. Ubuntu 26.04 not stated.                                                                                                                                                                                                                          |
| Sizes               | ✓              | `memory` in MB; CPU follows memory. 12 GiB → 6 vCPU. CPU not independently settable (heavy CPU:RAM ratio fixed at 1 vCPU per 2 GiB).                                                                                                                                                                                         |
| Docker inside       | ✓              | Official `blaxel/docker-in-sandbox` image with Docker CLI, Compose, `iptables-legacy` (https://docs.blaxel.ai/Tutorials/Docker).                                                                                                                                                                                             |
| Streaming exec      | ✓              | REST + SDK; `process.exec`, log streaming (https://docs.blaxel.ai/Sandboxes/Processes).                                                                                                                                                                                                                                      |
| PTY                 | partial        | Terminal via `bl connect sandbox`; WS terminal exists in sandbox API ("the sandbox and its terminal answer", Archive docs); protocol details not verified.                                                                                                                                                                   |
| FUSE                | not documented |                                                                                                                                                                                                                                                                                                                              |
| Snapshots           | partial        | Auto standby snapshot (memory + FS + processes). Explicit `snapshots.create` / fork / rollback: **private preview, not for production** (https://docs.blaxel.ai/Sandboxes/Fork.md). Archive (FS only) also private preview (https://docs.blaxel.ai/Sandboxes/Archive.md). Volumes: one per sandbox, attach at creation only. |
| Resume              | ✓              | ~25 ms from standby; standby after ~15 s without connection; WS/TCP idle timeout 15 min.                                                                                                                                                                                                                                     |
| Outbound internet   | ✓              | Egress gateways/proxy (beta).                                                                                                                                                                                                                                                                                                |
| Inbound previews    | ✓              | `*.preview.bl.run` public or private with `bl_preview_token` / `X-Blaxel-Preview-Token`; 15-minute connection timeout, bundler must implement WS ping/pong (https://docs.blaxel.ai/Sandboxes/Preview-url).                                                                                                                   |
| Control from Worker | ✓              | REST `https://api.blaxel.ai/v0` (Bearer + `X-Blaxel-Workspace`); sandbox API reachable via fetch.                                                                                                                                                                                                                            |

### Gotchas

- Persistence means paid snapshot storage forever unless expiration policies delete it.
- Snapshot/fork (what the brief wants for golden snapshots) is preview; golden images via image build are slower to update.
- Memory-based billing: a 12 GiB sandbox costs 3× the 4 GiB one even if idle at the CPU level (but idle is standby).

---

## 6. Freestyle (freestyle.sh VMs)

### Pricing (https://www.freestyle.sh/pricing, https://www.freestyle.sh/docs/vms/pricing-and-limits)

| Plan                                                                                                                                                                                                                                                                                                                                                         | Fee                                              | Notes                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Free                                                                                                                                                                                                                                                                                                                                                         | $0                                               | 10 concurrent, 10 saved VMs, **no persistent VMs or persistent snapshots**; hard stops at allowances |
| Hobby                                                                                                                                                                                                                                                                                                                                                        | **$50/mo minimum, fully usable as usage credit** | 40 concurrent, 200 saved, 1,000 snapshots, max 8 vCPU/16 GiB/64 GB per VM                            |
| Pro                                                                                                                                                                                                                                                                                                                                                          | $500/mo minimum                                  | 400 concurrent, 32 vCPU/64 GiB/256 GB per VM                                                         |
| Usage (per second, billed on **allocated** resources): vCPU $0.04032/h, memory $0.0129/GiB-h, storage $0.000086/GiB-h, transfer $0.02/GB. Included each month on every plan: 200 vCPU-h, 400 GiB-h, 60,000 GiB-h storage, transfer 500 GB on paid. Paused VMs hold no compute reservation and bill only storage. Snapshot storage pricing is not documented. |

### Worked cost (Hobby)

- Ref: 2 vCPU/4 GiB: 120 vCPU-h and 240 GiB-h are both under the free allowance. Storage 10 saved VMs × 20 GiB × 730 h = 146,000 GiB-h − 60,000 free = 86,000 × $0.000086 = $7.40. Total usage ≈ $7.4 (< $50). **Bill = $50.**
- Heavy: 360 vCPU-h (160 over × $0.04032 = $6.45) + 720 GiB-h (320 over × $0.0129 = $4.13) + $7.40 = $18.0 (< $50). **Bill = $50.**
- Egress 20 GB is within 500 GB.

### Capability table

| Requirement             | Status         | Notes                                                                                                                                                                                                                                                                            |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image                   | partial        | Ubuntu 24.04 base snapshots (`freestyle/ubuntu-sm` = 2 vCPU/4 GiB/16 GB). Build your own snapshot with `snapshot create --script …` or from a base (https://www.freestyle.sh/docs/vms/base-snapshots, https://www.freestyle.sh/docs/vms/cli). Arbitrary OCI import not verified. |
| Sizes                   | ✓              | Any size up to plan max (Hobby 8 vCPU/16 GiB); live grow-only resize of CPU/RAM/disk.                                                                                                                                                                                            |
| Docker inside           | ✓              | "systemd is pid 1, Docker runs from boot" on `freestyle/ubuntu`.                                                                                                                                                                                                                 |
| Streaming exec          | partial        | `vm.exec` returns result, max 5 min timeout. Longer or streaming via PTY.                                                                                                                                                                                                        |
| PTY w/ resize           | ✓              | WebSocket PTY sessions, `resize`, signals, detach/reattach by slug, xterm adapter; works with browser identity tokens (https://www.freestyle.sh/docs/vms/pty).                                                                                                                   |
| FUSE                    | not documented | Full VM, likely.                                                                                                                                                                                                                                                                 |
| Snapshots               | ✓              | `POST /v5/vms/{id}/snapshot` captures **exact state, memory and disk** (https://api.freestyle.sh/openapi.json); boot new VMs from it (golden images, ~1 s boot for base snapshots). Snapshot latency for GB-size not documented.                                                 |
| Memory snapshot / pause | ✓              | `pause()` freezes and saves memory; resume continues processes. Files readable while paused.                                                                                                                                                                                     |
| Scale to zero           | ✓              | `idleTimeoutSeconds` pauses on no network activity; wakes on next traffic or `start()`. `maxRunSeconds`, `ttlSeconds`, `autoDeleteSeconds` policies.                                                                                                                             |
| Outbound internet       | ✓              | Required explicit firewall rule at creation. TLS outbound transforms for credential injection.                                                                                                                                                                                   |
| Inbound previews        | ✓              | Public HTTPS on `*.style.dev` or own domain, with **forward auth** run at the edge before wake-up (https://www.freestyle.sh/docs/vms/forward-auth, https://www.freestyle.sh/docs/vms/domains). Meets the "private authenticated route" need.                                     |
| Control from Worker     | ✓              | REST (OpenAPI at api.freestyle.sh) + WS PTY; identity tokens for scoped client access.                                                                                                                                                                                           |

### Gotchas

- Paying $50/mo even if usage is $5: no PAYG tier with persistence.
- Resize is grow-only; to shrink make a new VM.
- Persistent VMs/saved VM count and total-disk budgets apply (default 4 vCPU/8 GiB/32 GB VM; use `ubuntu-sm`).
- Default VM size 4 vCPU/8 GiB would burn allowances faster than the reference 2 vCPU.

---

## 7. exe.dev

### Pricing (https://exe.dev/pricing, https://exe.dev/docs/billing/personal, https://exe.dev/docs/standalone-vms)

- **Personal**: pick a pool: 2 vCPU/4 GB $15/mo (100 GB disk, 200 GB egress), 4/8 $35, 8/16 $75, 16/32 $155; up to 50 VMs share the pool; 7-day trial via paid ChatGPT subscription.
- **Work**: $75/mo (intro $37.50 × 3 mo) includes 2 vCPU/4 GiB; extra pool capacity $0.105 per 2 vCPU/4 GiB unit-hour.
- **Standalone VM (sandbox)**: $0.105 per 2 vCPU/4 GiB unit-hour, per second, no minimum, billed while running, paused while stopped; stopped VMs keep disk and cost nothing for CPU/RAM. On top of Personal. Max 16 vCPU/32 GiB Personal.
- Extra disk $0.08/GiB-mo; extra bandwidth $0.05/GiB.

### Worked cost

- **Flat pool (Personal 2 vCPU/4 GiB):** **$15/mo** both ref and heavy, if one sandbox at a time. 10 workspace disks × 15 GB = 150 GB vs 100 GB included → + 50 × $0.08 = $4. Concurrent 2-3 sandboxes need the $35 (4 vCPU/8 GB) or $75 pool.
- **Standalone:** $15 + 60 h × $0.105 = **$21.3** ref; $15 + 180 × $0.105 = $33.9 heavy.

### Capability table

| Requirement         | Status       | Notes                                                                                                                                                                                                                                                                            |
| ------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image               | ✓            | `new --image=<OCI>`, private registry supported; exeuntu base (https://exe.dev/docs/customization).                                                                                                                                                                              |
| Docker inside       | ✓            | Docs say run `docker`/`docker-compose` in the VM (https://exe.dev/docs/all). Nested VMs only on Enterprise.                                                                                                                                                                      |
| Streaming exec      | ✓            | `POST https://exe.dev/exec` with body `ssh <vm> <cmd>`, bearer token; `Accept: application/x-ndjson` gives streamed stdout/stderr/exit code; works with `fetch` (https://exe.dev/docs/https-api-run-on-vm). No stdin streaming documented.                                       |
| PTY                 | ✗ over HTTPS | API _is_ SSH; PTY needs SSH TCP. Workers can open raw TCP, but you'd need an SSH client in the Worker (untested).                                                                                                                                                                |
| Disk snapshots      | partial      | Disks stream to a backup on another host (durability, not user snapshots). `cp <vm>` copies a VM (a manual golden-image mechanism). No documented snapshot/restore.                                                                                                              |
| Memory snapshot     | ✗            | not documented                                                                                                                                                                                                                                                                   |
| Scale to zero       | partial      | Pool VMs are always on within reserved capacity; only standalone VMs stop billing when stopped (stop/start API timing not documented).                                                                                                                                           |
| Inbound previews    | ✓            | `https://vm.exe.xyz[:3000-9999]`, private by default with exe.dev login or `share set-public`. A Worker must send an exe.dev-issued token; machine auth for the HTTP proxy is covered by "HTTPS Tokens for VMs" (https://exe.dev/docs/https-tokens-for-vms, not read in detail). |
| Control from Worker | partial      | HTTPS API only exposes the SSH command surface.                                                                                                                                                                                                                                  |

### Gotchas

- Interactive signup (`ssh exe.dev`), standalone VMs need team approval on some paths; individual "ChatGPT trial" onboarding.
- Pricing is capacity-reserved not usage: with only ~60 h/month usage, a flat $15 is fine but doesn't scale to zero.

---

## 8. Koyeb (Sandboxes, scale-to-zero, light sleep)

### Pricing (https://www.koyeb.com/pricing, https://www.koyeb.com/docs/reference/instances)

- Per second. Plans: Pro $29/mo (includes $10 compute), Scale $299/mo; sandboxes need Starter/Pro/Scale (https://www.koyeb.com/docs/sandboxes). The Starter plan fee did not appear in the scraped pricing page: not captured.
- Instances: `eco-large` 2 vCPU/4 GB **$0.0288/h** (shared, no volumes); `standard large` 4 vCPU/4 GB $0.0576/h; `xlarge` 8/8 $0.1152/h; `medium` 2/2 $0.0288/h.
- Light Sleep (snapshot-based wake in ~200 ms): public preview, free; at GA will charge **15% of the normal instance price** (https://www.koyeb.com/blog/avoid-cold-starts-with-scale-to-zero-light-sleep). Deep sleep cold start 1-5 s.
- Volumes: 1-10 GB, was/fra only, scale 1, standard/GPU instances only (not eco) (https://www.koyeb.com/docs/reference/volumes). Snapshots exist for volumes only. Volume/snapshot prices not captured. Egress price not captured.

### Worked cost

`eco-large` 60 h = **$1.73** (heavy $5.18). `standard large` (4 vCPU) $3.46 (heavy $10.37). Plus plan fee (Pro $29 includes $10 compute) and storage/egress not captured.

### Capability table

| Requirement             | Status         | Notes                                                                                                                                                |
| ----------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image                   | ✓              | Any Docker Hub image (`Sandbox.create(image=…)`). Container sandbox on microVM.                                                                      |
| Docker inside           | not documented |                                                                                                                                                      |
| Streaming exec          | ✓              | Python SDK `exec` with `on_stdout`; JS `exec_stream` (https://www.koyeb.com/docs/sandboxes/sandbox-run-commands). Python SDK primary, JS SDK exists. |
| PTY                     | not documented |                                                                                                                                                      |
| Disk snapshots / golden | ✗              | Sandboxes are "ephemeral compute environments… discarded after use"; snapshots only for volumes.                                                     |
| Memory snapshot         | partial        | Light Sleep only for scale-to-zero Services, HTTP-wake, preview; not user-addressable.                                                               |
| Disk 12 GB persistent   | ✗/partial      | Instance SSD is ephemeral; volumes max 10 GB.                                                                                                        |
| Scale to zero           | partial        | HTTP-traffic based, idle 5 min default (Pro up to 6 h); sandboxes are deleted by you.                                                                |
| Inbound previews        | ✓              | `expose_port` TCP proxy (sandbox).                                                                                                                   |
| Control from Worker     | partial        | Koyeb REST exists; sandbox SDKs are Python/JS clients to a sandbox daemon.                                                                           |

Verdict: fails snapshots/persistence; skip.

---

## 9. Railway (usage pricing, serverless sleep, Sandboxes)

### Pricing (https://railway.com/pricing)

- Plans: Hobby $5/mo (includes $5 credit; sandboxes up to 8 vCPU/8 GB), Pro $20/mo (includes $20; up to 32 vCPU/32 GB per https://docs.railway.com/sandboxes), Free $1.
- **Sandboxes (VM rates):** memory $0.00001929/GB-s (≈ $50/GB-month, **$0.0694/GB-h**), CPU $0.00001929/vCPU-s **active use** (≈ $0.0694/vCPU-h), egress $0.05/GB. Charged for CPU actually used and memory "it holds while it runs".
- Container services (not sandboxes): memory $10/GB-mo, CPU $20/vCPU-mo, volumes $0.15/GB-mo, egress $0.05/GB.
- Checkpoint/template storage pricing: not documented.

### Worked cost (4 GB held, CPU by use)

| Line                                                                                                  | Ref       | Heavy     |
| ----------------------------------------------------------------------------------------------------- | --------- | --------- |
| CPU 34.5 / 103.5 vCPU-h × $0.0694                                                                     | $2.40     | $7.19     |
| Memory 4 GB × 60/180 h × $0.0694                                                                      | $16.67    | $50.00    |
| Egress 20 GB × $0.05                                                                                  | $1.00     | $1.00     |
| **Total** (Hobby $5 credit absorbs the first $5)                                                      | **≈ $20** | **≈ $58** |
| If "memory held" means actual usage rather than allocation, it would be lower; the page does not say. |

### Capability table

| Requirement             | Status         | Notes                                                                                                                                                                                                              |
| ----------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Image                   | partial        | Standard Ubuntu image with git/node/coding agents; templates from checkpoints (https://docs.railway.com/sandboxes). Custom image: not documented.                                                                  |
| Sizes                   | ✓              | `resources {cpu, memoryGB}` up to plan max (Hobby 8/8; 12 GiB needs Pro).                                                                                                                                          |
| Streaming exec          | ✓              | TypeScript SDK `exec` over WebSocket with `onStdout`, stdin, detach/reattach by `sessionName`; `execHttp` for no-WS runtimes. SDK requires Node 22; underlying API is GraphQL (`sandboxCreate`).                   |
| PTY                     | partial        | SSH and dashboard terminal; `SHELL` sessions listed; PTY over WS not documented.                                                                                                                                   |
| Docker inside           | not documented |                                                                                                                                                                                                                    |
| Disk snapshots / golden | ✓              | `checkpoint(name)` (live disk snapshot) and `fork`; new sandbox boots fresh from the disk copy (processes lost); max checkpoints = plan sandbox limit; same region only. Capture time scales with changed disk.    |
| Memory snapshot         | ✗              |                                                                                                                                                                                                                    |
| Scale to zero           | ✗/partial      | No sleep for sandboxes: idle timeout **destroys** the sandbox (default 30 min, 1-120 min, `0` = never). Persistence only through checkpoints. Container services have "serverless sleep" but that's not a sandbox. |
| Outbound internet       | ✓              |                                                                                                                                                                                                                    |
| Inbound previews        | ✓              | `domains: [{port}]` public domains; `networkIsolation: "PRIVATE"` joins private network. Authenticated private route not documented.                                                                               |
| Control from Worker     | ✓              | API token + HTTP/WS.                                                                                                                                                                                               |

Verdict: most expensive per GB of memory; sandbox model is create/destroy. Skip.

---

## 10. Other providers found

### Beam (https://www.beam.cloud/pricing, https://docs.beam.cloud/v2/vm/overview.md)

**Pricing (VMs, "persistent Linux VMs for agents"):** $0.0252/vCPU-h + $0.0054/GiB-h, 50 GiB root disk included, per second while running, **no compute charge while stopped/paused**. Storage over 1 TB $0.021/GB-mo, snapshots "included". Sandboxes (container/microVM, ephemeral): $0.0000375/core-s (physical core = 2 vCPU) + $0.0000064/GiB-s = $0.319/h for 2 vCPU/8 GiB. Egress: not documented.
**Cost (VM, 2 vCPU/4 GiB):** 2×0.0252 + 4×0.0054 = **$0.0720/h** → ref **$4.32**, heavy **$12.96** (6 GiB $0.0828/h = $4.97 / $14.9). Busy and idle cost the same. Disk 20 GB inside the 50 GiB included.

| Requirement                                                                                                                               | Status      | Notes                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Image/size                                                                                                                                | ✓           | Ubuntu 24.04 default, custom images/templates; `--cpu` ≥ 0.1, `--memory` ≥ 256 MiB, disk 1-100 GiB, chosen at creation (cannot resize) (https://docs.beam.cloud/v2/vm/configuration.md). x86 presumably; not stated.     |
| Docker inside                                                                                                                             | ✓           | Docker daemon, Compose and Buildx on VMs; `/var/lib/docker` persists on the root (https://docs.beam.cloud/v2/vm/docker.md). overlay2/cgroup v2 not stated.                                                               |
| Streaming exec                                                                                                                            | ✓           | `beam vm exec` streams; SDK `vm.exec`, process APIs, logs.                                                                                                                                                               |
| PTY                                                                                                                                       | partial     | Browser terminal on port 7681 (ttyd-style) with token, SSH via authenticated tunnel. Programmatic PTY w/ resize via SDK: not documented.                                                                                 |
| Disk snapshots                                                                                                                            | ✓           | `beam vm snapshot create` (restore points); stop auto-creates a named snapshot; fork copies root to a new VM; templates (https://docs.beam.cloud/v2/vm/storage.md). Timing/size limits: not documented.                  |
| Memory snapshot                                                                                                                           | ✓           | `pause`/`resume` keep RAM + processes; `start --cold` discards. Sandboxes also have `snapshot_memory()` (https://docs.beam.cloud/v2/sandbox/snapshots).                                                                  |
| Scale to zero                                                                                                                             | ✓           | Idle TTL with `--idle-action pause                                                                                                                                                                                       | stop`and`--auto-resume`(SDK calls, tunnels and published-URL requests wake it). Activity = SDK/SSH/WS; a guest command running alone does not count, so use`keep_alive()` leases for long builds. |
| Inbound previews                                                                                                                          | ✓           | Stable published URL per port, `--protected` requires VM traffic token header.                                                                                                                                           |
| Control from Worker                                                                                                                       | **unknown** | Python/JS SDKs (`@beamcloud/beam-js`), CLI, MCP; workspace REST API covers apps/deployments (https://docs.beam.cloud/v2/reference/platform-api.md); a VM REST/WS API is not documented. Needs a prototype from a Worker. |
| Gotchas: resume time for paused VMs and snapshot sizes are not documented; VMs are CPU-only; microVM pool capacity "depends on the pool". |

### Hopx (https://www.hopx.ai/pricing, https://docs.hopx.ai)

**Pricing:** $0.000014/vCPU-s ($0.0504/h), $0.0000045/GiB-s ($0.0162/h), $0.00000003/GiB-s storage; no subscription or minimum; $200 free credits. 2 vCPU/4 GiB/20 GiB = **$0.168/h** → ref **$10.07**, heavy **$30.2**. Stopped/paused billing: not documented. Egress: not documented.
Capabilities: Control-plane REST + in-VM agent API; **WebSocket PTY terminal with resize** (https://docs.hopx.ai/core-concepts/terminal/websocket); pause/resume preserving RAM (https://docs.hopx.ai/core-concepts/sandboxes/managing-state); templates built from Docker images (https://docs.hopx.ai/core-concepts/templates/building.md). Gaps: sandboxes auto-delete when `timeout_seconds` expires (https://docs.hopx.ai/api/control-plane/set-timeout) so persistence is not a first-class feature; no documented snapshots/fork; Docker-in-sandbox, max size, concurrency not found. Sync exec max 300 s. Treat as unproven.

### Others seen but not researched (outside this batch)

E2B, Modal, Daytona appear in Fly's comparison (https://fly.io/learn/sprites-vs-e2b-vs-modal-vs-daytona); presumably covered in sibling docs.

---

## Capability matrix (✓ / ✗ / partial)

| Provider     | Ubuntu 26.04 / own image | 2-12 GiB sizes  | Docker (overlay2) | Stream exec     | PTY resize    | Disk snapshot / golden | Memory snapshot     | Scale to zero  | Private preview route     | Worker-friendly API |
| ------------ | ------------------------ | --------------- | ----------------- | --------------- | ------------- | ---------------------- | ------------------- | -------------- | ------------------------- | ------------------- |
| Fly Machines | ✓ OCI                    | ✓               | partial           | ✗ REST          | ✗ (own agent) | partial (volumes only) | partial (≤2 GB)     | partial (DIY)  | partial (router + replay) | ✓ REST              |
| Fly Sprites  | ✗ (25.10)                | ✗ not settable  | partial           | ✓ WSS           | ✓             | partial (no clone)     | partial (warm only) | ✓              | ✓/partial                 | ✓ REST+WSS          |
| Morph        | partial                  | ✓               | not doc.          | ✓ SSE           | ✗ (SSH)       | ✓                      | ✓                   | ✓              | ✓                         | ✓ REST              |
| CodeSandbox  | partial                  | partial (tiers) | partial (Podman)  | ✓ SDK           | ✓ SDK         | ✓                      | ✓                   | ✓              | ✓ (token)                 | partial             |
| Blaxel       | ✓                        | ✓               | ✓                 | ✓               | partial       | partial (preview)      | ✓ auto standby      | ✓              | ✓                         | ✓ REST              |
| Freestyle    | partial (24.04)          | ✓               | ✓                 | partial (5 min) | ✓ WS          | ✓                      | ✓                   | ✓              | ✓ forward-auth            | ✓ REST+WS           |
| exe.dev      | ✓ OCI                    | ✓               | ✓                 | ✓ ndjson        | ✗ (SSH)       | partial (`cp`)         | ✗                   | partial        | ✓                         | partial             |
| Koyeb        | ✓                        | ✓               | not doc.          | ✓               | not doc.      | ✗                      | ✗                   | partial        | ✓                         | partial             |
| Railway      | partial                  | ✓               | not doc.          | ✓               | partial       | ✓ (disk)               | ✗                   | ✗ (destroys)   | partial                   | ✓                   |
| Beam VMs     | ✓                        | ✓               | ✓                 | ✓               | partial       | ✓                      | ✓                   | ✓              | ✓                         | unknown             |
| Hopx         | ✓ templates              | ✓               | not doc.          | ✓               | ✓             | not doc.               | partial (pause)     | ✗ (TTL delete) | not doc.                  | ✓ REST+WS           |

## Recommendations

1. **Prototype first: Freestyle (best feature fit; costs a $50 floor) and Fly Sprites (cheapest well-featured API, but 25.10 image and no golden-image clone).** Both have a WS PTY and pure REST/WS control that a Durable Object can drive.
2. **Beam VMs** are the cost leader and match nearly every requirement (pause with RAM, Docker/Compose, FS snapshots, fork); the single unknown is Worker-compatible control. Spend an hour to see whether the JS SDK's transport runs in a Worker (or whether there is an HTTP/WS gateway). If yes it is the first choice.
3. **Morph** if branching/forking memory snapshots matter more than PTY; $0.10/h is simple and predictable.
4. **Fly Machines** only if you accept writing the exec/PTY agent, router app, and volume-snapshot choreography; per-hour price is good but total engineering is highest.
5. Skip Koyeb, Railway, Hopx for this use (no persistent snapshot story / destroy-on-idle / unproven).
6. Whatever is chosen, the cost lever is shutting down within 1-2 min of idle and not holding memory for hours; unit price differences here are cents per day.
