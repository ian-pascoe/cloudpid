// @effect-diagnostics preferEffectArray:off preferEffectRecord:off nodeBuiltinImport:off processEnv:off globalConsole:off -- native array methods over plain values (the bundle carries no Effect runtime); native object methods over plain values; runs on node, on the owner's machine; reads the owner's environment; a build script's output.
/**
 * Builds the extension (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → Distribution): `bun build
 * --target=node --format=esm` makes one `dist/index.js`, with the pi host packages external; `dist/package.json` has
 * `pi.extensions` and its peer dependencies and nothing else to install; the bundle is checked (`build-check.ts`).
 * `PI_CLOUDPID_SHA` (the CI job sets it to the `main` commit) is the build's commit, sent as `X-Cloudpid-Client`;
 * without it, `git rev-parse HEAD`.
 *
 *   bun --cwd packages/pi-cloudpid run build
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { bundleProblems, type Metafile } from "./build-check.ts";

const here = import.meta.dirname;
const dist = `${here}/dist`;

const source: {
  readonly description: string;
  readonly peerDependencies: { readonly [name: string]: string };
} = JSON.parse(readFileSync(`${here}/package.json`, "utf8"));

const sha = (() => {
  const given = process.env["PI_CLOUDPID_SHA"]?.trim();

  if (given !== undefined && given !== "") return given;

  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
})();

rmSync(dist, { recursive: true, force: true });

mkdirSync(dist, { recursive: true });

execFileSync(
  "bun",
  [
    "build",
    `${here}/src/index.ts`,
    "--target=node",
    "--format=esm",
    `--outfile=${dist}/index.js`,
    `--metafile=${dist}/metafile.json`,
    "--external=@earendil-works/*",
    "--external=typebox",
    `--define=process.env.PI_CLOUDPID_SHA=${JSON.stringify(sha)}`,
  ],
  { cwd: here, stdio: "inherit" },
);

const metafile: Metafile = JSON.parse(readFileSync(`${dist}/metafile.json`, "utf8"));
const problems = bundleProblems(metafile, Object.keys(source.peerDependencies));

// The metafile is for this check; a package installed from the branch has no use for it.
rmSync(`${dist}/metafile.json`);

if (problems.length > 0) {
  console.error(`pi-cloudpid's bundle is not one a laptop can load:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}

writeFileSync(
  `${dist}/package.json`,
  `${JSON.stringify(
    {
      name: "pi-cloudpid",
      version: "0.0.0",
      description: source.description,
      type: "module",
      pi: { extensions: ["./index.js"] },
      peerDependencies: source.peerDependencies,
    },
    null,
    2,
  )}\n`,
);

copyFileSync(`${here}/README.md`, `${dist}/README.md`);

console.log(`pi-cloudpid ${sha.slice(0, 12)}: dist/index.js, dist/package.json`);
