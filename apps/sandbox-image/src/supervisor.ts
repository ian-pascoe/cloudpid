// The contract of the image's entrypoint, `image/supervise` (docs/architecture/container.md → Exit reports),
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

/** A base64 payload of a `data:<mime>;base64,` run this long (or longer) is replaced by a marker in the kept lines. */
export const EXIT_REPORT_BASE64_MIN = 64;

/** What replaces such a payload in the kept lines. */
export const EXIT_REPORT_BASE64_MARKER = "[base64 dropped]";
