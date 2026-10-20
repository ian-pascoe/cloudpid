# The Container is minimal, and Toolchains are reinstalled from a synced lockfile

The Container image holds only `debian:stable-slim`, `fuse3`, `ca-certificates`, `computerd`, and `mise`. Every other program is a mise Toolchain declared in `mise.toml` and `mise.lock` inside the Workspace, so it follows the project. The Toolchain binaries live under `/workspace/.mise`, which is on computer's `ignore` list, along with `node_modules`, `.venv`, `target/`, and caches. They stay on container-local disk, outside the synced SQLite filesystem. On start, the Container runs `mise install`, which does nothing if the tools are present, and disk snapshots taken after installs and idle stops make most restarts skip the download. The image must be glibc-based because computerd is a glibc Node SEA.

## Considered Options

- **Persist Toolchain binaries in the synced Workspace.** computerd keeps the synced tree in container memory and re-pushes all of it after every container restart. Node alone is 213 MB in 4,750 files. That costs cold-start time and RAM in proportion to its size, and eats into the Durable Object's 10 GB SQLite cap. FUSE is also roughly 2× slower than ext4 for package installs.
- **A fat image with preinstalled languages.** Simpler, but it pins every project to one image's versions and grows without bound.
