// computerd runs a command with `/bin/sh -c`, which is dash on the Ubuntu image, while `bash` promises bash: arrays,
// `[[ ]]`, process substitution. A command for the Container is wrapped to run in bash instead.

/** `script` as one argument of a POSIX shell: in single quotes, each quote itself closed, escaped, and reopened. */
export const quote = (script: string): string => `'${script.replaceAll("'", "'\\''")}'`;

/** A script for `/bin/sh -c` that runs `script` in bash, with bash's exit status and its own stdout and stderr. */
export const inBash = (script: string): string => `exec bash -c ${quote(script)}`;
