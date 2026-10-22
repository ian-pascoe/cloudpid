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

it("carries a C toolchain, so native npm and pip packages build", () => {
  const packages = /apt-get install -y --no-install-recommends ([^\\\n]+)/g;
  // The last stage's install: the mise stage installs curl only.
  const installed = [...dockerfile.matchAll(packages)].at(-1)?.[1]?.trim().split(/\s+/) ?? [];

  expect(installed).toEqual(expect.arrayContaining(["gcc", "g++", "make", "libc6-dev"]));
});

it("pins every base image by digest, so a rebuild does not move to another release", () => {
  const images = [...dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gm)].map(
    (match) => match[1],
  );

  expect(images).toHaveLength(3);

  for (const image of images) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
});
