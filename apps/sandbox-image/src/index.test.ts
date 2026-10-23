// The sandbox image's seam with the Workspace DO: the computerd inside it must be the version of
// `@cloudflare/computer` the DO runs (docs/spec.md → Known risks: pin versions and keep the image and package in
// lockstep). A mismatch speaks a different sync protocol and fails only once a Container starts.
// @effect-diagnostics nodeBuiltinImport:off preferEffectArray:off
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sandboxImageContext } from "@cloudpid/sandbox-image";

const dockerfile = readFileSync(join(sandboxImageContext, "Dockerfile"), "utf8");

/** The version of `@cloudflare/computer` installed for `workspace`, a directory below the repository root. */
const installedComputer = (workspace: string): string => {
  // SAFETY: the file is the package's own manifest, which has a version; `exports` hides it from `require`.
  const manifest = JSON.parse(
    readFileSync(
      join(
        sandboxImageContext,
        "..",
        "..",
        "..",
        workspace,
        "node_modules",
        "@cloudflare",
        "computer",
        "package.json",
      ),
      "utf8",
    ),
  ) as { version: string };

  return manifest.version;
};

it("takes computerd from the image of the @cloudflare/computer version the Workspace DO runs", () => {
  const pinned = /^ARG COMPUTERD_VERSION=(\S+)$/m.exec(dockerfile)?.[1];

  // The Workspace DO's package, and the one that drives it.
  expect(installedComputer("apps/server")).toBe(pinned);
  expect(installedComputer("packages/computer-env")).toBe(pinned);
  expect(dockerfile).toMatch(
    /^FROM .*ghcr\.io\/cloudflare\/computer-computerd-linux-x64:\$\{COMPUTERD_VERSION\}@sha256:[0-9a-f]{64}/m,
  );
});

it("keeps computerd's store on the Container's disk, outside the mount, so a restored snapshot is not sent every file", () => {
  const env = (name: string) =>
    new RegExp(`^\\s*(?:ENV\\s+)?${name}=(\\S+?)\\s*\\\\?$`, "m").exec(dockerfile)?.[1];

  const store = env("COMPUTERD_DB") ?? "";
  const mount = env("MOUNT_POINT") ?? "";

  // Absolute (computerd refuses a relative path), not under the mount, and in a directory the image makes.
  expect(store).toMatch(/^\/[^/]/);
  expect(`${store}/`.startsWith(`${mount}/`)).toBe(false);
  expect(dockerfile).toContain(`mkdir -p ${store.slice(0, store.lastIndexOf("/"))}\n`);
});

/** The apt packages the last stage installs: the mise stage installs curl only. */
const installed = (): string[] => {
  const stage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  // Up to the next command: the list may go on over continued lines.
  const install = /apt-get install -y --no-install-recommends([^&]*)/.exec(stage)?.[1] ?? "";

  return install.split(/\s+/).filter((word) => /^[a-z0-9][a-z0-9.+-]*$/.test(word));
};

it("runs Ubuntu 24.04 LTS", () => {
  expect(dockerfile).toMatch(/^FROM --platform=linux\/amd64 ubuntu:24\.04@sha256:[0-9a-f]{64}$/m);
  expect(dockerfile).not.toMatch(/^FROM .*debian/m);
});

it("carries a C toolchain, so native npm and pip packages build", () => {
  expect(installed()).toEqual(
    expect.arrayContaining([
      "build-essential",
      "pkg-config",
      "libssl-dev",
      "zlib1g-dev",
      "libffi-dev",
    ]),
  );
});

it("carries the everyday command-line tools agents and scripts expect (#169)", () => {
  expect(installed()).toEqual(
    expect.arrayContaining([
      "fuse3",
      "libfuse2t64",
      "ca-certificates",
      "curl",
      "wget",
      "jq",
      "ripgrep",
      "fd-find",
      "unzip",
      "zip",
      "xz-utils",
      "procps",
      "psmisc",
      "lsof",
      "iproute2",
      "dnsutils",
      "netcat-openbsd",
      "less",
      "file",
      "tree",
      "openssh-client",
      "gnupg",
      "sudo",
      "sqlite3",
      "tzdata",
      "rsync",
      "socat",
      "net-tools",
      "iputils-ping",
      "bubblewrap",
      "locales",
      "time",
    ]),
  );
  // Debian and Ubuntu name fd's binary fdfind; the image gives it its own name too.
  expect(dockerfile).toContain("ln -s /usr/bin/fdfind /usr/local/bin/fd");
});

it("carries Docker, with Compose and Buildx, for Start Scripts to run services in", () => {
  expect(installed()).toEqual(
    expect.arrayContaining(["docker.io", "docker-compose-v2", "docker-buildx"]),
  );
});

it("leaves the versioned Toolchains to mise: no apt git, node or python is asked for", () => {
  for (const toolchain of ["git", "gh", "nodejs", "python3", "python3-pip", "pipx"]) {
    expect(installed()).not.toContain(toolchain);
  }
});

it("pins every base image by digest, so a rebuild does not move to another release", () => {
  const images = [...dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)].map(
    (match) => match[1],
  );

  expect(images).toHaveLength(3);

  for (const image of images) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
});
