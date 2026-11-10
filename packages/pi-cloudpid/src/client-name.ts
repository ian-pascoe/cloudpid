// @effect-diagnostics nodeBuiltinImport:off missingPipeableSignature:off -- runs on node, on the owner's machine; plain functions over values, called directly.
/**
 * The client's name, `X-Cloudpid-Client` (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Its commit):
 * the extension and the commit it runs from, which the endpoint shows as the Session's client.
 */
import { execFileSync } from "node:child_process";

/**
 * The HEAD of the git checkout `directory` is in, which `pi install git:github.com/ian-pascoe/cloudpid` makes; `dev`
 * outside one, or without git.
 */
export const sourceCommit = (directory: string): string => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev";
  }
};

/** Asked once per load of the extension: a `pi update` reloads it from the new commit. */
let loaded: string | undefined;

/** The `X-Cloudpid-Client` value of `commit` (the extension's own by default), trimmed to 40 characters by the endpoint. */
export const clientName = (
  commit: string = (loaded ??= sourceCommit(import.meta.dirname)),
): string => `pi-cloudpid/${commit.slice(0, 12)}`;
