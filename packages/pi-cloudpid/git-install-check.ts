// @effect-diagnostics preferEffectArray:off nodeBuiltinImport:off processEnv:off globalConsole:off asyncFunction:off -- native array methods over plain values; runs on node, as a CI step; hands the environment to npm; a check script's output; a plain async script.
/**
 * Installs this repository as `pi install git:github.com/ian-pascoe/cloudpid` does and loads `/cloudpid` from it
 * (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Distribution): a copy of the working tree (the files
 * git tracks or would, so no `node_modules`), committed as a clone is, then pi's own production install, `npm install
 * --omit=dev --legacy-peer-deps --no-audit --no-fund`, which runs the root `prepare` (scripts/prepare.sh) too. It fails
 * when npm cannot install the workspaces (a `workspace:` version, which npm does not know), when `prepare` fails without
 * the development tools, or when the extension the root manifest names does not load or registers no `/cloudpid`.
 *
 *   bun run --cwd packages/pi-cloudpid git-install:check
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

const root = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "cloudpid-git-install-"));
const install = join(scratch, "cloudpid");
const agentDir = join(scratch, "agent");

const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
  execFileSync(command, [...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const fail = (message: string): never => {
  throw new Error(`git install check: ${message}`);
};

try {
  const files = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)
    .split("\0")
    .filter((file) => file !== "");

  for (const file of files) {
    const from = join(root, file);
    const to = join(install, file);

    mkdirSync(dirname(to), { recursive: true });

    // A deleted file git still tracks is not copied: the clone would not have it either.
    try {
      cpSync(from, to, { verbatimSymlinks: true });
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  }

  mkdirSync(agentDir);
  run("git", ["init", "--quiet"], install);
  run("git", ["add", "--all"], install);
  run(
    "git",
    [
      "-c",
      "user.name=check",
      "-c",
      "user.email=check@localhost",
      "commit",
      "--quiet",
      "-m",
      "clone",
    ],
    install,
  );

  // pi's arguments for a git source installed with npm (DefaultPackageManager → getGitDependencyInstallArgs).
  run("npm", ["install", "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund"], install);

  const manifest: { readonly pi?: { readonly extensions?: ReadonlyArray<string> } } = JSON.parse(
    readFileSync(join(install, "package.json"), "utf8"),
  );

  const entries = (manifest.pi?.extensions ?? []).map((entry) => resolve(install, entry));

  if (entries.length !== 1) fail(`the root manifest names ${entries.length} extensions, not 1`);

  const loaded = await discoverAndLoadExtensions(entries, install, agentDir);

  if (loaded.errors.length > 0)
    fail(`the extension did not load: ${JSON.stringify(loaded.errors)}`);

  const commands = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);

  if (!commands.includes("cloudpid"))
    fail(`no /cloudpid command, only ${JSON.stringify(commands)}`);

  console.log("git install check: npm installed the clone, and /cloudpid loads from it");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
