# The Workspace Container's image (docs/spec.md → Container and Toolchains, ADR-0004): debian:stable-slim, fuse3,
# ca-certificates, computerd, and mise. Everything else is a mise Toolchain. The image is glibc-based because computerd
# is a glibc Node SEA, and linux/amd64 because that is what Cloudflare Containers run.

# Keep in step with the version of @cloudflare/computer the Workspace DO runs (apps/sandbox-image/src/index.test.ts
# fails when they differ): the Workspace and computerd speak a sync protocol that is not stable across releases.
ARG COMPUTERD_VERSION=0.5.1
ARG MISE_VERSION=v2026.10.15
ARG MISE_SHA256=e3b186d4c70627f27037be615becaf4acfb30e41fb6a1819486717dc94e4e2a9

# Every base image is pinned by digest as well as by tag, so a rebuild cannot move to another computerd build or Debian
# release (`libfuse2t64` is a trixie package name). Refresh a digest together with its tag: computerd's is the manifest of
# `ghcr.io/cloudflare/computer-computerd-linux-x64:<COMPUTERD_VERSION>`, Debian's the index of `debian:stable-slim`.

# A single layer over scratch whose only content is the computerd binary at /usr/local/bin/computerd.
FROM --platform=linux/amd64 ghcr.io/cloudflare/computer-computerd-linux-x64:${COMPUTERD_VERSION}@sha256:63b743262f9e854bde861c5d4a08fb57539012997f6b9e7d231cb32667c65c6a AS computerd

# mise is fetched and checked in a stage of its own, so the image keeps no curl.
FROM --platform=linux/amd64 debian:stable-slim@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5 AS mise
ARG MISE_VERSION
ARG MISE_SHA256
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /mise https://github.com/jdx/mise/releases/download/${MISE_VERSION}/mise-${MISE_VERSION}-linux-x64 \
 && echo "${MISE_SHA256}  /mise" | sha256sum -c - \
 && chmod 755 /mise

FROM --platform=linux/amd64 debian:stable-slim@sha256:eb593cf2c358cacef45ca0a424bbc7d30cfa3466265fc2662b9466a0ca6ba1c5

RUN apt-get update \
 && apt-get install -y --no-install-recommends fuse3 libfuse2t64 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=computerd /usr/local/bin/computerd /usr/local/bin/computerd
COPY --from=mise /mise /usr/local/bin/mise

# computerd mounts its file system at MOUNT_POINT, so commands see the Workspace's files at /workspace. FUSE_MOUNT=auto
# mounts through /dev/fuse where the platform exposes it (Cloudflare Containers) and falls back to a userspace shim
# where it does not. mise's shims put the programs it installs on PATH.
ENV PORT=8080 \
    MOUNT_POINT=/workspace \
    FUSE_MOUNT=auto \
    PATH=/root/.local/share/mise/shims:${PATH}
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/computerd"]
