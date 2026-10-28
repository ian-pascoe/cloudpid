# Shared brief: cheaper Container backends for cloudpid

cloudpid is a single-user, always-on coding agent (like Claude Code / Codex cloud) running on Cloudflare Workers + Durable Objects.
Each agent "Workspace" gets its own Linux sandbox, today a **Cloudflare Container** (Firecracker-style VM, `schedulingPolicy: durable_object`).
The owner spent >$10 of Cloudflare Container compute in a few days and wants a cheaper backend; a big refactor is acceptable.

## What the sandbox must do today (requirements)

- Ubuntu 26.04 (glibc) image ~470 MB compressed / ~1.5 GB+ on disk, with mise toolchains (node, python, git, gh, pnpm, uv), build-essential, Docker (dockerd runs inside the sandbox for `docker compose` services; needs overlay2 + cgroup v2), earlyoom.
- Sizes used: 1 vCPU/3 GiB (default), 2 vCPU/6 GiB, up to ~3-4 vCPU/12 GiB; 12 GB disk. x86_64 preferred (arm64 possible but toolchain lockfiles are linux-x64).
- Exec of commands with streaming stdout/stderr; a **PTY** exec (interactive terminal with resize, streaming stdin).
- A filesystem-sync daemon (`computerd`, a Node SEA) runs inside and serves `/workspace` via **FUSE** (needs /dev/fuse) — this could be dropped in a refactor.
- **Disk snapshots** of the root filesystem (taken at idle stop, restored on next start, ~1-3 GB each, ~45-90 s to take today) and per-environment "Build" snapshots that new sandboxes start from (like a template/golden image made at runtime). Memory snapshots would be a bonus.
- **Scale to zero**: stopped after 2 min idle; started on the next command; cold/restore start target ~2-5 s.
- Unrestricted outbound internet; inbound access to dev-server ports (previews) from a Cloudflare Worker/Browser Run browser (no public URL needed, but a private/authenticated HTTP route is required).
- Must be controllable from a **Cloudflare Worker / Durable Object** (fetch + WebSocket only; no Node-only gRPC SDKs unless there's an HTTP/WebSocket API).
- Usage pattern: bursty, one human; typically 1-3 sandboxes running at a time, many hours idle per day; each running session may run builds/tests (tsc, vitest, pnpm install) that peg CPU for minutes.

## Cloudflare Containers baseline (verify current values)

Memory $0.0000025/GiB-s ($0.009/GiB-h), CPU $0.000020/vCPU-s active only ($0.072/vCPU-h), disk $0.00000007/GB-s, egress $0.025/GB; Workers Paid includes 25 GiB-h memory, 375 vCPU-min, 200 GB-h disk monthly.
Example: 1 vCPU/3 GiB/12 GB running 1 h idle ≈ $0.030; fully busy ≈ $0.10/h. 2 vCPU/6 GiB busy ≈ $0.20/h.

## Output rules

- Primary sources only (official pricing pages, docs, API references, GitHub repos of the project). Cite a URL for every price and capability claim; note the date you read it. If something is not documented, say "not documented" instead of guessing.
- For each provider produce: pricing model (per-second? minimum charge? idle/stopped charges? storage/snapshot charges? free tier / monthly minimum / plan fee), a worked cost for the **reference workload** below, and a capability table against the requirements above (✓ / ✗ / partial + note), plus notable limits (max sandbox lifetime, max concurrent, regions, cold start, persistence), API surface (REST/WebSocket? usable from a Worker?), and gotchas.
- Reference workload (per month): 60 h of sandbox running time on a 2 vCPU / 4-6 GiB / 12-20 GB sandbox, of which 15 h is CPU-busy at ~100% of 2 vCPU and the rest ~5% CPU; 3 environments' golden snapshots (~3 GB each) + ~10 workspace disk snapshots (~2 GB each) kept all month; 20 GB egress. Also give the cost of a "heavy" month at 3× that running time.
- Write markdown only to the file path given in your task. Do not edit any other files. Be thorough but terse: tables over prose.
