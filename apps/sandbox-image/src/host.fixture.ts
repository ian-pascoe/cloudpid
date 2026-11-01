// @effect-diagnostics nodeBuiltinImport:off processEnv:off -- probes of the host that runs the tests.
// What the Container's scripts need of the host that runs their tests, beyond bash and git: GNU coreutils, util-linux's
// `flock` and `setsid`, and `/proc`. The Container and CI run Linux, which has them all; a macOS host lacks them, so a
// test that needs one is skipped there. Under CI each counts as there, so a missing tool fails its tests instead.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const underCi = process.env["CI"] !== undefined;

const answers = (command: string): boolean =>
  underCi || spawnSync(command, ["--version"]).status === 0;

/** GNU coreutils: `stat --printf`, `touch -d @<epoch>`, and a `head -c` that reads no more of a pipe than it prints. */
export const hasGnuCoreutils = answers("stat");

/** util-linux's `flock`, which keeps two Sessions' scripts from running at once. */
export const hasFlock = answers("flock");

/** util-linux's `setsid`, which detaches a service from the script that started it. */
export const hasSetsid = answers("setsid");

/** `/proc`, where the Build's clean-up finds what its scripts left running. */
export const hasProc = underCi || existsSync("/proc/self/stat");
