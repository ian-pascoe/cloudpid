# The Container is minimal, and Toolchains are reinstalled from a synced lockfile

The Container image holds only `debian:stable-slim`, `fuse3`, `ca-certificates`, `computerd`, and `mise`. Every other program is a mise Toolchain declared in `mise.toml` and `mise.lock` inside the Workspace, so it follows the project. The Toolchain binaries live on the Container's own disk, in mise's default directories, and `node_modules`, `.venv`, `target/`, and caches are on computer's `ignore` list. They stay on container-local disk, outside the synced SQLite filesystem. Before the first command of each Container start, the Workspace DO runs `mise install`, which does nothing if the tools are present, and disk snapshots taken after installs and idle stops make most restarts skip the download.

The Toolchains were first planned under `/workspace/.mise` on the `ignore` list. Deployed, computerd 0.5.1's FUSE fails `listxattr` with `ENOENT` on ignored paths, which broke Python's `shutil.copystat` (`python -m venv` could not copy ensurepip's wheels from its own install), so they stay off the mount: installs and `/tmp` then share one filesystem, which also keeps them clear of the `EXDEV` boundary. The image must be glibc-based because computerd is a glibc Node SEA.

## Considered Options

- **Persist Toolchain binaries in the synced Workspace.** computerd keeps the synced tree in container memory and re-pushes all of it after every container restart. Node alone is 213 MB in 4,750 files. That costs cold-start time and RAM in proportion to its size, and eats into the Durable Object's 10 GB SQLite cap. FUSE is also roughly 2× slower than ext4 for package installs.
- **A fat image with preinstalled languages.** Simpler, but it pins every project to one image's versions and grows without bound.
