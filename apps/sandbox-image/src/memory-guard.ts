// The Container's memory guard (docs/spec.md → Container and Toolchains → Memory guard): earlyoom, which the image's
// supervisor runs beside computerd through `image/cloudpid-memory-guard`, and the note each command gets when the
// guard stopped a process while it ran. The Workspace DO imports it (through `toolchainEnv`): no Node built-ins here,
// since it runs in a Worker. The scripts in `image/` repeat these values; `memory-guard.test.ts` fails when they differ.

/** Where the image has the guard, which the supervisor starts. */
export const MEMORY_GUARD = "/usr/local/bin/cloudpid-memory-guard";

/**
 * The file every Container command's bash reads before the command (`image/command.bash`): when the command ends, it
 * prints the notes the guard left while it ran.
 */
export const COMMAND_BASH = "/usr/local/share/cloudpid/command.bash";

/**
 * `BASH_ENV` for a Container command: `COMMAND_BASH`, when the Container's image has it. bash expands the value before
 * it reads the file, so a Container still on an older image, which a deploy does not stop, reads nothing and says
 * nothing, where a plain path would make every command print that the file is missing.
 */
export const COMMAND_BASH_ENV = `$([ -r ${COMMAND_BASH} ] && echo ${COMMAND_BASH})`;

/** Where the guard leaves a note for each process it stops. */
export const MEMORY_NOTES_DIRECTORY = "/run/cloudpid-memory-guard";

/**
 * When the guard acts, as earlyoom's `-m` (percent of the memory available) and `-M` (KiB available): it stops the
 * largest process with SIGTERM below the lower of the two first values, and with SIGKILL below the lower of the
 * second. On the default `custom-1` (3 GiB) that is about 480 MB and 260 MB, on `custom-2` (6 GiB) about 950 MB and
 * 510 MB; a larger size stops at 1 GiB and 512 MiB. The Container has no swap, and on `custom-2` computerd's own pages
 * were being evicted at about 400 MB available (2026-10-23): above that, nothing stalled. Not yet measured on `custom-1`,
 * whose SIGKILL threshold is below that.
 */
export const MEMORY_GUARD_PERCENT = "15,8";

export const MEMORY_GUARD_KIB = "1048576,524288";

/**
 * The process names earlyoom never stops: computerd, which runs every command, the supervisor and the guard, as the
 * kernel keeps them (15 characters).
 */
export const MEMORY_GUARD_AVOID = "^(computerd|cloudpid-superv|cloudpid-memory)$";
