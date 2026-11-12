// @effect-diagnostics nodeBuiltinImport:off processEnv:off -- probes of the host that runs the tests.
// What the Container's scripts need of the host that runs their tests, beyond bash and git: GNU coreutils, util-linux's
// `flock` and `setsid`, and `/proc`. The Container and CI run Linux, which has them all; a macOS host lacks them, so a
// test that needs one is skipped there. Under CI each counts as there, so a missing tool fails its tests instead.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const underCi = process.env["CI"] !== undefined;

/** Whether `command` is on the host: it answers `--version`, as the GNU and util-linux tools do. */
const present = (command: string): boolean =>
  underCi || spawnSync(command, ["--version"]).status === 0;

/**
 * Whether the host's `command` is GNU's: its `--version` names `package`. Answering `--version` is not enough for
 * coreutils: on macOS, Vite Task runs a cached task's `stat` as uutils' (`stat (uutils coreutils)`), whose `--printf`
 * differs from GNU's.
 */
export const isGnu = (command: string, gnuPackage: string): boolean =>
  underCi || String(spawnSync(command, ["--version"]).stdout ?? "").includes(`(GNU ${gnuPackage})`);

/**
 * GNU coreutils, probed by its `stat`: `stat --printf`, `touch -d @<epoch>`, and a `head -c` that reads no more of a pipe
 * than it prints.
 */
export const hasGnuCoreutils = isGnu("stat", "coreutils");

/** util-linux's `flock`, which keeps two Sessions' scripts from running at once. */
export const hasFlock = present("flock");

/** util-linux's `setsid`, which detaches a service from the script that started it. */
export const hasSetsid = present("setsid");

/** `/proc`, where the Build's clean-up finds what its scripts left running. */
export const hasProc = underCi || existsSync("/proc/self/stat");
