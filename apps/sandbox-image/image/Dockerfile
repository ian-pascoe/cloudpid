# The Workspace Container's image (docs/spec.md → Container and Toolchains, ADR-0004): Ubuntu 24.04 LTS with fuse3, the
# everyday command-line tools, a C toolchain, Docker, computerd under its supervisor, and mise with its installs of the
# base mise.toml's Toolchains. Every program a project uses is a mise Toolchain; the image's installs are only found by mise for a
# Workspace that asks for those versions. The image is glibc-based because computerd is a glibc Node SEA, and
# linux/amd64 because that is what Cloudflare Containers run.

# Keep in step with the version of @cloudflare/computer the Workspace DO runs (apps/sandbox-image/src/index.test.ts
# fails when they differ): the Workspace and computerd speak a sync protocol that is not stable across releases.
ARG COMPUTERD_VERSION=0.6.0
ARG MISE_VERSION=v2026.10.17
ARG MISE_SHA256=fe6dd17e68e09682b31d2e7bb7bb755d22636ac1af5d94621e300f2ca9e9fe8a

# Every base image is pinned by digest as well as by tag, so a rebuild cannot move to another computerd build or Ubuntu
# point release. Refresh a digest together with its tag: computerd's is the manifest of
# `ghcr.io/cloudflare/computer-computerd-linux-x64:<COMPUTERD_VERSION>`, Ubuntu's the index of `ubuntu:24.04`.

# A single layer over scratch whose only content is the computerd binary at /usr/local/bin/computerd.
FROM --platform=linux/amd64 ghcr.io/cloudflare/computer-computerd-linux-x64:${COMPUTERD_VERSION}@sha256:2be45dcb1143bf4a7f15665c9a448fc991eacab0c880ae12c10031f7d764a3f8 AS computerd

# mise is fetched and checked in a stage of its own, so the image keeps no curl.
FROM --platform=linux/amd64 ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac AS mise
ARG MISE_VERSION
ARG MISE_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /mise https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-x64 \
 && echo "${MISE_SHA256}  /mise" | sha256sum -c - \
 && chmod 755 /mise

FROM --platform=linux/amd64 ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac

# The everyday tools agents and scripts expect (#169; some from exe.dev's exeuntu list), build-essential and the
# headers native npm and pip packages build against, and Docker for Start Scripts' services. Versioned Toolchains
# (Node, Python, pnpm, git, gh) are mise's, never apt's: mise's shims come first on PATH anyway, so a git an apt
# package pulled in would not shadow mise's. fd's binary is fdfind here; it gets its own name too.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates \
      curl wget jq ripgrep fd-find unzip zip xz-utils \
      procps psmisc lsof iproute2 dnsutils netcat-openbsd \
      less file tree openssh-client gnupg sudo sqlite3 tzdata \
      rsync socat net-tools iputils-ping bubblewrap locales time \
      build-essential pkg-config libssl-dev zlib1g-dev libffi-dev \
      docker.io docker-compose-v2 docker-buildx \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && sed -i 's/^# *en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# Docker's daemon without iptables or IP forwarding, which the Container's read-only /proc/sys refuses, and the helper
# a Start Script brings it up with (docs/spec.md → Container and Toolchains → Docker).
COPY daemon.json /etc/docker/daemon.json
COPY --chmod=755 cloudpid-dockerd /usr/local/bin/cloudpid-dockerd

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY --from=mise /mise /usr/local/bin/mise

# The base mise.toml's Toolchains (a copy of BASE_MISE_TOML, apps/sandbox-image/src/toolchains.ts, which a test keeps
# equal), installed into mise's system directory, /usr/local/share/mise/installs, where mise looks for a version a
# config asks for before it downloads one. Its lockfile is made here too and copied by the bootstrap next to the base
# file it writes, since `mise lock` downloads aqua and Python artifacts to checksum them. A Workspace asking for other
# versions installs them under /root as before. Refresh the versions in toolchains.ts and here together.
COPY mise.toml /usr/local/share/cloudpid/mise.toml
RUN cd /usr/local/share/cloudpid \
 && export MISE_GLOBAL_CONFIG_FILE=/usr/local/share/cloudpid/mise.toml MISE_TRUSTED_CONFIG_PATHS=/usr/local/share/cloudpid \
 && mise install --system \
 && mise lock --global --platform linux-x64 \
 && mise reshim --system \
 && rm -rf /root/.cache /root/.local /tmp/*

COPY --chmod=755 supervise /usr/local/bin/cloudpid-supervise

# computerd mounts its file system at MOUNT_POINT, so commands see the Workspace's files at /workspace. FUSE_MOUNT=auto
# mounts through /dev/fuse where the platform exposes it (Cloudflare Containers) and falls back to a userspace shim
# where it does not. mise keeps the Toolchains it installs on the Container's own disk, in its default place under
# /root, and its shims put them on PATH, before the shims of the image's own installs. PATH is the one variable
# computerd passes on to a command, so it is the one set here: mise's other settings reach a command in its exec
# environment (apps/sandbox-image/src/toolchains.ts).
# computerd keeps its copy of the Workspace in COMPUTERD_DB, on the Container's disk, so a snapshot holds it with its
# sync positions: a Container restored from one is sent only what changed since, not every file (docs/spec.md →
# Container and Toolchains → Snapshots). In memory, the default, it is rebuilt from the Workspace DO at each start.
ENV PORT=8080 \
    MOUNT_POINT=/workspace \
    FUSE_MOUNT=auto \
    COMPUTERD_DB=/var/lib/computerd/state.db \
    PATH=/root/.local/share/mise/shims:/usr/local/share/mise/shims:${PATH}
RUN mkdir -p /var/lib/computerd
EXPOSE 8080

# computerd runs under a supervisor that reports why it stopped, when it stops on its own, to the Workspace DO
# (`supervise`; docs/spec.md → Container and Toolchains → Exit reports).
ENTRYPOINT ["/usr/local/bin/cloudpid-supervise"]
