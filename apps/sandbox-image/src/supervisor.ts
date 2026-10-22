// The contract of the image's entrypoint, `image/supervise` (docs/spec.md → Container and Toolchains → Exit reports),
// with the Workspace DO, which imports it: no Node built-ins here, since it runs in a Worker. The script repeats these
// values; `supervisor.test.ts` fails when they differ.

/**
 * The host the supervisor posts its report to. Nothing answers it but the Workspace DO, which intercepts it for each
 * Container it starts, as computer does `computer.internal` for computerd.
 */
export const EXIT_REPORT_HOST = "cloudpid.internal";

/** The path of the report on that host. */
export const EXIT_REPORT_PATH = "/container-exit";

/** How many of computerd's last lines the supervisor keeps and sends. */
export const EXIT_REPORT_LINES = 200;

/** The most of those lines it sends, in bytes: the end of them when they are longer. */
export const EXIT_REPORT_BYTES = 32_768;
