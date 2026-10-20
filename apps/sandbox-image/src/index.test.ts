// The sandbox image's seam with the Workspace DO: the computerd inside it must be the version of
// `@cloudflare/computer` the DO runs (docs/spec.md → Known risks: pin versions and keep the image and package in
// lockstep). A mismatch speaks a different sync protocol and fails only once a Container starts.
// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { sandboxImageContext } from "@cloudpid/sandbox-image";

const dockerfile = readFileSync(join(sandboxImageContext, "Dockerfile"), "utf8");

/** The version of the installed `@cloudflare/computer`, whose package.json its `exports` hide from `require`. */
const computerVersion = (): string => {
  // SAFETY: the file is the package's own manifest, which has a version.
  const manifest = JSON.parse(
    readFileSync(
      join(sandboxImageContext, "..", "node_modules", "@cloudflare", "computer", "package.json"),
      "utf8",
    ),
  ) as { version: string };

  return manifest.version;
};

it("takes computerd from the image of the @cloudflare/computer version the Workspace DO runs", () => {
  const pinned = /^ARG COMPUTERD_VERSION=(\S+)$/m.exec(dockerfile)?.[1];

  expect(pinned).toBe(computerVersion());
  expect(dockerfile).toMatch(
    /^FROM .*ghcr\.io\/cloudflare\/computer-computerd-linux-x64:\$\{COMPUTERD_VERSION\}/m,
  );
});
