# Managed AI-sandbox providers (A): E2B, Daytona, Modal, Vercel Sandbox, Runloop, Northflank

Read 2026-10-28. Primary sources only (URLs inline). "n/d" = not documented on the pages I read. Ratings: ✓ / ✗ / partial.
Cost arithmetic is mine, from the published rates. Worked costs use the brief's reference workload.

## 0. Reference workload and baseline

Workload: 60 h running on 2 vCPU / 4 GiB (6 GiB variant where the provider allows) / 12 GB disk. 15 h at ~100% of 2 vCPU, 45 h at ~5%.

- Provisioned vCPU-h = 120. Active vCPU-h = 15×2 + 45×2×0.05 = **34.5**. GiB-h = 240 (4 GiB) or 360 (6 GiB).
- Snapshots kept all month = 3×3 + 10×2 = **29 GB**. Egress = 20 GB.
- "Heavy" = 3× running time: 180 h, 360 provisioned vCPU-h, 103.5 active vCPU-h, 720 GiB-h (4 GiB) / 1080 (6 GiB). Storage and egress are unchanged.

**Cloudflare Containers baseline** (re-verified, https://developers.cloudflare.com/containers/pricing/):

- Rates match the brief: memory $0.0000025/GiB-s, CPU $0.000020/vCPU-s, disk $0.00000007/GB-s.
- Memory and disk bill on provisioned size. **CPU bills on active usage only.**
- Egress is $0.025/GB in NA/EU with **1 TB/month included** (the brief didn't mention the allotment).
- Instance types: `standard-3` = 2 vCPU / 8 GiB / 16 GB; `standard-2` = 1 vCPU / 6 GiB / 12 GB. There is no 2 vCPU / 4 GiB type.
- Reference month on `standard-3`, 60 h: memory 480 GiB-h × $0.009 = $4.32; CPU 34.5 × $0.072 = $2.48; disk 960 GB-h × $0.000252 = $0.24. Total **≈ $7.05 gross, ≈ $6.3 after Workers Paid allotments**. Snapshot storage is not modelled.
- Heavy: ≈ **$21** (memory $12.96 + CPU $7.45 + disk $0.73).

**Key finding.** Among these providers only Cloudflare, Vercel and Northflank (flat plan) come in under ~$12 for this workload.

- E2B, Daytona, Modal and Runloop bill CPU on **provisioned** time, so the 45 idle hours cost full CPU. That is about 3.5× more billable CPU than the 34.5 active vCPU-h Cloudflare bills.
- If the >$10 observed on Cloudflare came from containers staying awake long past idle, moving to a provisioned-CPU provider will not fix it.
- Make sure idle sleep (2 min) actually fires before changing backend.

## 1. Cost summary (reference month, compute + storage; egress noted)

| Provider                                         | 60 h, 2 vCPU/4 GiB                          | 60 h, 6 GiB                  | Heavy (180 h, 4 GiB) | Fixed fee / free tier                                               | Notes                                                              |
| ------------------------------------------------ | ------------------------------------------- | ---------------------------- | -------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Cloudflare (baseline, standard-3 = 2 vCPU/8 GiB) | ≈ $6.3–7.1                                  | n/a                          | ≈ $21                | Workers Paid $5                                                     | CPU on active only                                                 |
| **E2B**                                          | $9.94                                       | $11.88                       | $29.8                | **Pro $150/mo** (Hobby $0 + $100 one-time credit)                   | Storage free. Hobby disk (10 GiB) and 1 h runtime make it unusable |
| **Daytona**                                      | ≈ $12.7                                     | ≈ $14.7                      | ≈ $32.6              | $200 free credit. Full-internet tier needs a $500 top-up            | Snapshot storage rate not published; I assumed the disk rate       |
| **Modal**                                        | $14.28                                      | $17.16                       | $42.8                | Starter $30/mo free credit (covers normal month; heavy ≈ $12.8 net) | 20 GB egress is inside the 1 TiB free. Snapshot storage price n/d  |
| **Vercel Sandbox**                               | ≈ $11.8                                     | n/a (memory fixed 2 GB/vCPU) | ≈ $30.8              | Pro seat; $20/mo credit applies                                     | Active-CPU billing like Cloudflare                                 |
| **Runloop**                                      | ≈ $19.3 (Basic) / ≈ $270 (Pro, for suspend) | ≈ $22.3 / $273               | ≈ $57.8 / ≈ $310     | Basic $0; Pro $250/mo                                               | Suspend/resume is Pro-only                                         |
| **Northflank**                                   | ≈ $6.6 + backup storage (n/d)               | ≈ $8.6 (2 vCPU/8 GB plan)    | ≈ $14.6              | No plan fee; Sandbox free tier ≤ $20/mo                             | Flat plan, no idle discount. Pause = $0 compute                    |

Egress (20 GB): E2B n/d (not on pricing page); Daytona n/d; Modal inside 1 TiB free; Vercel Pro "included in Flat Rate CDN" (worst case Enterprise $0.15/GB = $3); Runloop n/d; Northflank $0.06/GB = $1.20.

## 2. Capability matrix

| Requirement                          | E2B                                                                                                                    | Daytona                                                                                                                       | Modal                                                                                              | Vercel Sandbox                                                                                                                          | Runloop                                                                             | Northflank                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Isolation                            | Firecracker microVM                                                                                                    | Container (default) or Linux VM                                                                                               | gVisor (default) or `runtime="vm"`                                                                 | Firecracker microVM                                                                                                                     | microVM                                                                             | Cloud Hypervisor microVM (gVisor for GPU)                                                                |
| Docker-in-sandbox (dockerd, compose) | ✓ (microVM; docs recommend ≥2 CPU/2 GB)                                                                                | ✓ (docs: DinD + compose; containers and VM)                                                                                   | ✓ **only `runtime="vm"`**; `/var/lib/docker` is included in fs snapshots                           | ✓ (changelog 2026-05-29; sudo + dockerd in microVM)                                                                                     | ✓ (`universal-*-dnd` blueprints, root)                                              | ✓ ("Docker inside" on product page; no detail page found)                                                |
| FUSE                                 | ✓ (kernel has FUSE; docs use FUSE in templates for bucket mounts; `fuse3` not in base image)                           | n/d for user FUSE in container; platform Volumes are FUSE-based                                                               | ✓ in VM runtime (docs say so explicitly)                                                           | ✓ (changelog 2026-07-03, mount-s3 example)                                                                                              | n/d                                                                                 | ✓ (S3-via-FUSE advertised on product page)                                                               |
| PTY                                  | ✓ `sandbox.pty.create` (cols/rows, sendInput, reconnect). Resize call not confirmed in what I read                     | ✓ WebSocket PTY with resize                                                                                                   | partial: `exec(pty=True)` boolean, no resize documented                                            | partial: CLI `--tty` only. Python SDK says no PTY; JS SDK has stdin, no PTY                                                             | ✓ PTY sessions: REST control plane + raw-binary WebSocket data plane                | partial: CLI interactive TTY; JS client exec streams. No raw WS/resize documented                        |
| Pause/resume **with memory**         | ✓ default (`pause()` keeps FS + RAM; kept indefinitely)                                                                | ✓ **Linux VM class only** (pause, memory snapshot, fork). Containers: ✗                                                       | partial: alpha memory snapshot. Terminates the sandbox, 7-day TTL, same instance type only, no GPU | ✗ (FS snapshot on stop)                                                                                                                 | ✗ (suspend = disk only; processes lost)                                             | ✗ (pause kills processes; ephemeral wiped)                                                               |
| Persistent disk / FS snapshots       | Paused sandbox persists forever. Snapshots (1→many) with full or `filesystem` mode. Volumes private beta               | Stopped container keeps FS; archive moves it to object store; VM stop/pause offloaded. FS snapshots from sandboxes            | FS snapshots (30-day default TTL, `ttl=None` = forever), directory snapshots, Volumes              | Persistent sandboxes: auto-snapshot on stop and auto-resume. Manual snapshots, `Sandbox.fork`, Drives                                   | Snapshots (all plans); suspend (Pro) keeps disk                                     | Volumes only (attach at create; RWX). No root-FS snapshot. Volume backups/clones                         |
| Custom image                         | Template builder: Dockerfile-style SDK, `fromImage`, Debian/Ubuntu/Fedora/Alpine/Arch; build ≤1 h, disk ≤20+ GiB (Pro) | Docker image (public/private registry) or Dockerfile/declarative builder (containers). **VM class: existing image refs only** | Any registry image + Dockerfile commands                                                           | OCI image pushed to Vercel Container Registry, linux/amd64 only, ENTRYPOINT/CMD ignored. Managed `vercel/sandbox/ubuntu` = ubuntu:26.04 | Blueprints from Dockerfile + build context                                          | Any OCI image or Dockerfile build                                                                        |
| Max size                             | Pro: 8 vCPU / 8 GiB (more via support); disk 20+ GiB                                                                   | Default tier cap **4 vCPU / 8 GiB / 10 GiB disk** per sandbox (raise via support)                                             | CPU/mem max n/d; disk quota 512 GiB default, 3 TiB max                                             | Pro: 8 vCPU / 16 GB; 64 GB disk                                                                                                         | Custom: ≤16 CPU, ≤64 GiB RAM (cpu:mem 1:2–1:8), disk 2–64 GiB                       | Default quota 8 vCPU / 16 GiB / **2 GiB ephemeral** per instance (raisable); custom PaaS plans ≤384 vCPU |
| Max lifetime                         | Pro 24 h continuous; resets on pause; paused state indefinite. Hobby 1 h                                               | No max documented. Default auto-stop 15 min                                                                                   | 24 h max (default 5 min); idle timeout optional                                                    | Pro 24 h per session (Hobby 45 min), resets on resume; default 5 min                                                                    | `keep_alive_time_seconds` default 1 h, max 48 h                                     | "No time limits" (product page)                                                                          |
| Scale-to-zero / start                | Auto-pause on timeout (`onTimeout:'pause'`, `autoResume`). Start time n/d                                              | Auto-stop/auto-pause. Marketing: "sub 90 ms" creation (pricing page)                                                          | Idle timeout terminates. Restore time n/d                                                          | Auto-stop; auto-resume from snapshot on any SDK call. Resume time n/d                                                                   | Idle config → suspend (Pro). Resume "typically seconds"                             | `pause` / `resume` endpoints; "boot < 1 s" (docs)                                                        |
| Inbound HTTP/WS to dev server        | `https://{port}-{id}.e2b.app`; public by default, restrictable (secured access)                                        | Preview URLs: token header or signed URL                                                                                      | Tunnels and **Sandbox Connect Tokens** (Bearer or `_modal_connect_token` query; HTTP + WebSocket)  | `sandbox.domain(port)` public URL; ≤15 ports. Auth n/d                                                                                  | Tunnel `https://{port}-{key}.tunnel.runloop.ai`; `open` or `authenticated` (Bearer) | Public port URL with TLS or private port; private networking                                             |
| Unrestricted outbound                | ✓ default, on/off + allow/deny lists                                                                                   | ✓ **only Tier 3+ ($500 top-up)**; Tier 1/2 restricted                                                                         | ✓ default; allowlists optional                                                                     | ✓ default; network policies exist                                                                                                       | ✓ default; egress policy per devbox                                                 | ✓ default; egress by FQDN optional                                                                       |
| Self-host / BYOC                     | **OSS (Apache-2.0)** "E2B Embed" (single node via Docker Compose or Terraform) + Enterprise BYOC                       | **OSS (AGPL-3.0)**, Docker Compose (api, proxy, runner, ssh-gateway, Postgres); community-supported                           | ✗                                                                                                  | ✗ (Vercel-managed)                                                                                                                      | Enterprise "Deploy to VPC"                                                          | **BYOC** on AWS/GCP/Azure/OCI/etc., self-serve; billed per node vCPU                                     |

## 3. Callable from a Cloudflare Worker?

| Provider   | Control plane                                                                                                                             | Data plane (exec/PTY)                                                                                                                                                                                            | Worker verdict                                                                                                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2B        | REST `api.e2b.app` (OpenAPI public)                                                                                                       | **Connect protocol over HTTP/WebSocket** to `sandbox.e2b.app`, routed by `E2b-Sandbox-Id` / `E2b-Sandbox-Port` headers (https://docs.e2b.dev/api-reference/process/connect.md). SSH-over-WebSocket also possible | **✓ best fit.** JS SDK crashed in workerd at import (`createRequire(import.meta.url)`). Fixed by PR #1583 (2026-07): "runs a full sandbox lifecycle from inside a Worker" with `nodejs_compat` (https://github.com/e2b-dev/E2B/pull/1583). Raw fetch + Connect framing is the fallback |
| Daytona    | REST `https://app.daytona.io/api/...`                                                                                                     | Toolbox REST on `proxy.app.daytona.io/toolbox/{id}/...`; PTY over WebSocket                                                                                                                                      | **✓.** TS SDK docs say Workers works with `nodejs_compat` (https://www.daytona.io/docs/en/typescript-sdk.md). REST direct is safe                                                                                                                                                      |
| Modal      | **gRPC only** (JS SDK `modal` depends on `nice-grpc`, https://github.com/modal-labs/libmodal). No public REST for sandbox lifecycle found | Sandbox Connect Tokens give plain HTTP/WS to a port in the sandbox                                                                                                                                               | **✗ for control plane.** Need a small proxy (Modal web endpoint or Node host) that a Worker calls over HTTP. Data plane via Connect Token works from a Worker                                                                                                                          |
| Vercel     | REST `api.vercel.com/v2/sandboxes/...` (create, exec, snapshot, etc.) (https://vercel.com/docs/rest-api)                                  | Command exec via REST (async, returns cmd id; logs by streaming endpoint). No PTY endpoint documented                                                                                                            | **✓ via REST.** SDK deps (undici, tar-stream) are Node-oriented, workerd support not claimed                                                                                                                                                                                           |
| Runloop    | REST + TS SDK; docs list **Cloudflare Workers** as a supported runtime (https://github.com/runloopai/api-client-ts)                       | SSE log streaming; PTY via WebSocket                                                                                                                                                                             | **✓.** Best documented Worker support after E2B                                                                                                                                                                                                                                        |
| Northflank | REST `api.northflank.com/v1`; JS client is Node-oriented                                                                                  | `exec` returns Node streams (WebSocket under the hood; wire protocol not documented). File copy needs `tar` over the exec connection                                                                             | **partial.** Lifecycle via REST fine; exec/PTY would need reverse-engineering the WS protocol, or a Node relay                                                                                                                                                                         |

## 4. Provider detail

### E2B

Sources: https://e2b.dev/pricing, https://docs.e2b.dev/billing.md, /sandbox/persistence.md, /sandbox/snapshots.md, /faq/sandbox-lifetime.md, /byoc.md, https://github.com/e2b-dev/infra (renamed `e2b-dev/runtime`).

- **Pricing**:
  - Per-second on provisioned resources: $0.000014/vCPU-s ($0.0504/h) and $0.0000045/GiB-s ($0.0162/h). Storage is free and included.
  - Hobby is $0 with a one-time $100 credit, 20 concurrent sandboxes, 1 h sessions, 10 GiB disk. Pro is $150/mo with 100 concurrent, 24 h sessions, 20 GiB disk, custom CPU/RAM.
  - Pro+ (600 concurrent) is $650; Pro++ (1,100) is $1,150. Enterprise has a $3,000 monthly minimum.
  - Sandbox sizes are 1–8 vCPU and 1–8 GiB; default 2 vCPU / 4 GiB.
- **Worked cost**:
  - 4 GiB: 120 vCPU-h × $0.0504 = $6.05, plus 240 GiB-h × $0.0162 = $3.89, gives **$9.94**. Add $150 Pro for 12 GB disk and >1 h sessions: **≈ $160**.
  - 6 GiB: $11.88 (≈ $162 on Pro).
  - Heavy: $29.8 (≈ $180 on Pro).
  - On Hobby the compute is covered by the $100 credit for ~10 months, but 10 GiB disk < 12 GB.
  - Snapshot/template storage is free today. Template storage "may be introduced in the future" (https://docs.e2b.dev/template/quickstart.md).
- **Strengths**:
  - Full memory pause/resume is default and indefinite.
  - Snapshots spawn many sandboxes: a golden "Build" snapshot maps directly.
  - Templates can capture a _running_ start command.
  - Docker works.
  - OSS runtime is self-hostable: Firecracker, Apache-2.0, KVM host required.
- **Gotchas**:
  - $150/mo floor dominates the cost.
  - Max memory is 8 GiB; the 12 GiB tier needs a support request.
  - `createSnapshot()` and `pause()` **drop PTY/WebSocket/command streams**, so clients must reconnect.
  - The base image lacks `fuse3`.
  - Volumes are private beta with file-locking and many-small-files caveats.
  - Public URLs are open by default (restrict via secured access).
  - Streams are not guaranteed beyond ~1 h; SDK uses 50 s keepalives.
  - Pause can be refused with 503 `ServiceBusy` (rolling out).
  - Template builds are capped at 1 h and 8 vCPU / 8 GiB / 10 GiB (Hobby) or 20+ GiB (Pro).
  - Self-host: "E2B Embed" is single-node, while multi-node scale-out is Enterprise (https://raw.githubusercontent.com/e2b-dev/infra/main/embed/README.md).

### Daytona

Sources: https://www.daytona.io/pricing, /docs/en/billing.md, /limits.md, /sandboxes.md, /linux-sandboxes.md, /snapshots.md, /network-limits.md, /pty.md, /preview.md, /oss-deployment.

- **Pricing**:
  - vCPU $0.0504/h, memory $0.0162/GiB-h, storage $0.000108/GiB-h (≈ $0.078/GiB-mo) "after first 5 free". Per-second billing; $200 free credit.
  - Billed states: started = CPU+RAM+disk. **Stopped = disk only. Paused (VM) = disk only; memory state free. Archived = $0** (container sandboxes). Deleted sandboxes' snapshots stay billed for storage.
  - No plan fee.
- **Worked cost (4 GiB)**:
  - Compute $9.94.
  - Sandbox disk 12 GiB billed all month (7 GiB after free 5) = $0.54.
  - Snapshots 29 GiB × 720 h × $0.000108 = $2.26, assuming snapshot storage uses the same rate (n/d).
  - Total **≈ $12.7**; 6 GiB ≈ $14.7; heavy ≈ **$32.6**.
  - Archive between sessions would drop the idle disk charge.
- **Strengths**:
  - Only provider here with all of: memory pause/resume (Linux VM class), fork, and memory snapshots.
  - Cheap storage.
  - OSS self-host (AGPL).
  - WebSocket PTY with resize.
  - Dockerfile builds.
  - Warm pools.
- **Gotchas** (several are blockers):
  - **Per-sandbox cap defaults to 4 vCPU / 8 GiB / 10 GiB disk**, so a 12 GB disk needs a limit raise. Max-3-4 vCPU/12 GiB needs a custom limit too.
  - **Outbound internet is restricted on Tier 1 and Tier 2 and cannot be overridden per sandbox.** Full internet requires Tier 3 ($500 top-up) (https://www.daytona.io/docs/en/network-limits.md). This conflicts with the "unrestricted outbound" requirement unless you pay in.
  - **VM sandboxes can only be created from existing image refs.** Dockerfile/declarative builds are container-only. VM snapshots need a registry image.
  - **Container sandboxes cannot pause and have no memory snapshot.**
  - VM class availability and KVM (nested virt) need to be enabled by Daytona support for KVM.
  - Preview-URL traffic does not reset the auto-stop timer.
  - Docker support docs I found were for snapshots (DinD base images). v2 docs are alpha.
  - OSS self-host is community-supported and AGPL-3.0.

### Modal Sandboxes

Sources: https://modal.com/pricing, /docs/guide/sandboxes, /sandbox-snapshots, /sandbox-networking, /tunnels, /resources, https://github.com/modal-labs/libmodal.

- **Pricing**:
  - Sandbox CPU is $0.00003942 per physical core-s ($0.1419/h; 1 core = 2 vCPU). Memory is $0.00000667/GiB-s ($0.0240/h). Sandboxes bill at the non-preemptible 3× rate.
  - You pay **max(request, actual usage)** for CPU and memory (https://modal.com/docs/guide/resources), so there is no idle discount.
  - Volumes $0.09/GiB-mo (1 TiB free). Egress $0.04/GiB; Starter includes 1 TiB/mo.
  - Starter is $0 with $30/mo credits; Team is $250 with $100 credits.
  - Filesystem/memory snapshot storage price: n/d.
- **Worked cost**:
  - 60 h on 1 core (2 vCPU) / 4 GiB: $8.52 + $5.76 = **$14.28**; $17.16 with 6 GiB.
  - Heavy: **$42.8**.
  - Starter's $30 credit covers the normal month; the heavy month nets ≈ $12.8.
- **Snapshots**:
  - Filesystem snapshots are diffs from the base image and are Images. 30-day default TTL; `ttl=None` retains them forever.
  - Directory snapshots are also available.
  - Memory snapshots (`_experimental_snapshot()` / `_experimental_from_snapshot`) are alpha. They **terminate the sandbox**, expire after 7 days, restore only on the exact same instance type, can't pin a region, can't snapshot while an exec runs, and don't restore exec-spawned background processes.
  - So memory snapshots are not true pause/resume.
- **Docker/FUSE**:
  - Require `runtime="vm"` (default is gVisor).
  - Docker run: start `dockerd` as the entrypoint, then `docker run` via exec.
  - Nested virtualization is Enterprise only.
- **Gotchas**:
  - **No Worker-compatible control plane.** The JS SDK uses `nice-grpc`; there is no documented public REST API for sandbox lifecycle. Either run a Modal Function as an HTTP proxy or a Node relay.
  - Default sandbox lifetime is 5 min (max 24 h).
  - Snapshot-then-restore is the only way to continue past 24 h.
  - PTY is a boolean on `exec` (stdout/stderr merged); no resize documented.
  - Disk is ephemeral (default 512 GiB quota; up to 3 TiB).
  - Disk requests raise memory billing at 20:1.
  - Max vCPU/GiB per sandbox n/d.
  - "Sandbox.from_snapshot" is `_experimental_from_snapshot` (Py) / `experimentalFromSnapshot` (JS).

### Vercel Sandbox

Sources: https://vercel.com/docs/sandbox/pricing (updated 2026-09-10), /sandbox, /sandbox/concepts/{snapshots,images,persistent-sandboxes,drives}, https://vercel.com/docs/rest-api, changelogs.

- **Pricing** (iad1; other regions differ):
  - Active CPU $0.128/h (time waiting on I/O excluded). Provisioned memory $0.0212/GB-h (1-min minimum). Creations $0.60/M. Snapshot storage $0.08/GB-mo. Drive storage $0.05/GB-mo.
  - Memory is tied to CPU: 2 GB per vCPU, vCPU = 1 or an even number up to 8 on Pro. 2 vCPU therefore means 4 GB; 6 GiB is not available at 2 vCPU.
  - Egress is billed only for sent data and exposed-port traffic. Downloads are free.
  - Hobby: 5 CPU-h, 420 GB-h, 45-min sessions, 10 concurrent. Too small.
  - Pro: usage runs against a $20/mo credit.
  - Vercel's own example: 1 vCPU/2 GB idle at 1% CPU = $31/mo if left running; stopped = $0.
- **Worked cost (2 vCPU / 4 GB)**:
  - Active CPU 34.5 × $0.128 = $4.42.
  - Memory 240 × $0.0212 = $5.09.
  - Snapshots 29 GB × $0.08 = $2.32.
  - Total **≈ $11.8**. Heavy **≈ $30.8**.
  - The $20 Pro credit offsets most of it, but the Pro seat fee applies; I did not re-verify the seat price.
- **Strengths**:
  - Active-CPU billing, like Cloudflare.
  - **Persistent sandboxes are the default:** stop auto-snapshots the FS, any SDK call auto-resumes, and each session gets a fresh timeout.
  - `Sandbox.fork`.
  - Ubuntu 26.04 managed base image.
  - 64 GB NVMe.
  - Docker and FUSE work.
  - Clean REST API.
- **Gotchas**:
  - No memory snapshot or pause (stop → filesystem snapshot → boot).
  - Snapshots expire 30 days after last use by default (retention is configurable).
  - Only 15 open ports per sandbox.
  - Custom images must be pushed to Vercel Container Registry as linux/amd64, and ENTRYPOINT/CMD are ignored. Run daemons via `runCommand`.
  - **No PTY in the SDKs** (CLI `--tty` only). A terminal UI would need a workaround.
  - 20–40 vCPU/min creation rate on Hobby.
  - WebSockets to the public URL can close while the sandbox continues.
  - Restore time n/d.

### Runloop

Sources: https://runloop.ai/pricing, https://docs.runloop.ai (lifecycle, sizes, snapshots, blueprints, tunnels, PTY, docker-in-docker), https://github.com/runloopai/api-client-ts.

- **Pricing** (billed per second, no minimums):
  - Devbox CPU $0.108/CPU-h. Memory $0.0252/GB-h. Devbox storage $0.00034236/GB-h (≈ $0.25/GB-mo). Snapshot and blueprint storage $0.000072/GB-h (≈ $0.052/GB-mo). Blueprint build $0.252/h.
  - Basic is $0 with 100 GB free storage, devboxes, blueprints and snapshots. **Pro is $250/mo with 1 TB storage and adds suspend/resume** and beta features.
  - Compute bills only while `initializing`, `running`, `suspending`, `resuming`. Suspended devboxes pay storage only.
  - Preset MEDIUM (2 CPU / 4 GB / 8 GB disk) = $0.3195/h. Custom 2 CPU / 4 GB / 12 GB ≈ $0.321/h.
- **Worked cost**:
  - 60 h × $0.321 = **$19.3** on Basic, using snapshots to persist (29 GB is inside the 100 GB free).
  - Pro for suspend/resume: $250 + $19.0 + ≈ $3.0 idle disk, about **$270**.
  - 6 GiB variant adds ≈ $3/mo.
  - Heavy: **≈ $57.8** Basic, ≈ $310 Pro.
- **Gotchas**:
  - **Suspend/resume preserves disk only. Memory and processes are lost.** It is Pro-only.
  - Basic users must snapshot and recreate.
  - Runloop warns devboxes are "ephemeral": snapshot regularly.
  - CPU is not discounted when idle.
  - Max keep-alive 48 h (default 1 h).
  - Disk max 64 GiB. Custom size granularity: CPU 0.5/1/even ≤16, memory 1 or even ≤64 GiB, disk even ≥2 GiB.
  - FUSE n/d.
  - Docker only on `-dnd` blueprints.
  - Trial limits: 3 running devboxes, 10 snapshots, 5 blueprints.
  - Region/start latency n/d; resume "typically seconds".

### Northflank

Sources: https://northflank.com/pricing, /product/sandboxes, https://northflank.com/docs/v1/application/sandboxes/{quickstart(sandboxes-on-northflank),configure-and-manage-sandboxes.md,examples.md,sandboxes-on-northflank-cloud}, /docs/v1/application/billing/resource-plans-and-quotas.md, /docs/v1/api/execute-command.md.

- **Pricing** (per second, no seat fees):
  - CPU $0.01667/vCPU-h and memory $0.00833/GB-h, billed in fixed plans: `nf-compute-100-2` = 1 vCPU / 2 GB = $0.0333/h; `nf-compute-200` = 2 vCPU / 4 GB = $0.0667/h; `nf-compute-400` = 4 vCPU / 8 GB = $0.13/h.
  - Ephemeral storage is free. Persistent NVMe disk is $0.11657/GiB-mo (billed while the volume exists, including while paused). Egress is $0.06/GB; ingress is free.
  - Sandbox free tier: up to $20/mo of resources, 2 services. Pay-as-you-go has no plan fee.
  - **BYOC** (own cloud): $0.02083 per node vCPU-h management fee, no memory/disk/egress charge from Northflank. You pay the cloud provider.
  - Backup/snapshot storage rate: not shown.
- **Worked cost (cloud)**:
  - Compute 60 h × $0.0667 = $4.00.
  - 12 GiB volume = $1.40.
  - Egress 20 GB = $1.20.
  - Total **≈ $6.6** plus backup storage (n/d). 8 GB plan ≈ $8.6.
  - Heavy **≈ $14.6**. Cheapest in the set, but it bills the full plan whenever the sandbox is running and has no active-CPU discount.
- **Gotchas**:
  - **Pause = processes killed and ephemeral storage wiped.** No memory or root-FS snapshot.
  - Only attached volumes persist, and they must be attached at create time. A Docker data-root, `node_modules` and toolchains outside the volume are lost on each pause.
  - Default per-instance quota is 8 vCPU / 16 GiB / **2 GiB ephemeral**. A 12 GB root disk needs a quota raise or volumes.
  - Region is fixed per project.
  - Exec/PTY is via the Node client/CLI. No documented raw WebSocket/REST for streaming exec or PTY resize, so Worker control is weak.
  - A "service per sandbox" model means you manage lifecycle through service create/scale/pause/resume. Resize restarts the sandbox.
  - Golden snapshots would be an OCI image you build and push, or volume clones. There is no runtime "snapshot of root FS → template".
  - Docker-in-sandbox is claimed on the product page; I found no detail page.

## 5. Fit against the brief (short)

| Need                                                                                  | Best                                                                                                             | Why                                                                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cheapest at this usage                                                                | Northflank (≈ $6.6)                                                                                              | Worker control and snapshot semantics are weak                                                                                    |
| Closest semantics (memory pause + golden snapshots + REST/WS + Worker + Docker + PTY) | **E2B**                                                                                                          | Costs $150/mo Pro floor + ≈ $10 usage. Max 8 GiB RAM                                                                              |
| Same semantics, cheaper                                                               | Daytona **Linux VM**                                                                                             | ≈ $13/mo with no plan fee, but check the tier network limits ($500 top-up), the 10 GiB disk cap and "VM from registry image only" |
| Low-cost active-CPU billing, FS persistence                                           | **Vercel Sandbox** (≈ $12)                                                                                       | No memory pause, no PTY in SDK, Docker and FUSE ✓                                                                                 |
| Skip                                                                                  | Modal (no Worker control plane, memory snapshots are alpha, $14–17), Runloop (suspend needs $250 Pro; disk only) |                                                                                                                                   |

- **Cloudflare is already cheap for this pattern** (≈ $6–7 reference, ≈ $21 heavy) because CPU is active-only. No provider here beats it by much except Northflank.
- Before replatforming, check why the owner's real bill hit >$10 in a few days (idle sleep not firing, a keepalive from the DO, or a busy daemon).
- E2B and Daytona self-host (KVM host needed) are the only realistic way to get "flat VM price", e.g. one bare-metal box running E2B Embed/Daytona OSS. That is out of scope for this file.
