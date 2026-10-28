// Container-only paths (GLOSSARY.md): the paths whose files only the Workspace's Container has. Outside the Workspace
// that is every path; inside it, those a launch's patterns name (computer's `ignore`, which computerd applies as
// `MOUNT_IGNORE`). The Workspace DO decides with these when a model tool's file operation, or a `bash` command, has to
// reach the Container (docs/architecture/workspace.md → Filesystem and tools, ADR-0018).
//
// The patterns are computer's (`checkIgnorePatterns` in `@cloudflare/computer/backends/container`): relative to the
// mount root, `/…` anchored at it, `**/…` at any depth, `*` within one segment, `**` a whole segment, a leading `!`
// taking a path back; the last pattern that matches decides. A pattern that matches a directory covers everything below
// it, so the last pattern that matches the path or one of its ancestors decides.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off

/** Where the Workspace is mounted, on the Container and in the Workspace DO's files. */
export const WORKSPACE_ROOT = "/workspace";

/** The harness's own files in the Workspace (temp files, spills, Attachments), always synced. */
export const HARNESS_ROOT = `${WORKSPACE_ROOT}/.cloudpid`;

/** What the harness appends to a launch's patterns so its own directory is never Container-only. */
const HARNESS_KEPT = ["!/.cloudpid", "!/.cloudpid/**"];

/** `patterns` with the harness's own directory taken back last, so nothing an Environment adds can make it local. */
export const withHarnessKept = (patterns: readonly string[]): readonly string[] => [
  ...patterns.filter((pattern) => !HARNESS_KEPT.includes(pattern.trim())),
  ...HARNESS_KEPT,
];

const escape = (text: string): string => text.replace(/[.+^${}()|[\]\\?]/g, "\\$&");

/** A pattern, compiled: whether it takes paths back, and the test of a path relative to the mount root. */
type CompiledPattern = { readonly exclude: boolean; readonly test: RegExp };

/** A pattern as a test of a path relative to the mount root (`repo/node_modules`, no leading slash). */
const compile = (raw: string): CompiledPattern => {
  const pattern = raw.trim();
  const exclude = pattern.startsWith("!");
  const body = (exclude ? pattern.slice(1) : pattern).replace(/^\/+|\/+$/g, "");
  const segments = body === "" ? [] : body.split("/");

  let source = "";

  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;

    if (segment === "**") {
      // Zero or more whole segments: with the separator after it, unless it ends the pattern.
      source += last ? ".*" : "(?:[^/]+/)*";
    } else {
      source += segment.split("*").map(escape).join("[^/]*") + (last ? "" : "/");
    }
  }

  return { exclude, test: new RegExp(`^${source}$`) };
};

/** Each path from the first segment of `relative` down to `relative` itself. */
const prefixes = (relative: string): string[] => {
  const segments = relative.split("/");

  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
};

/**
 * Whether `path` (absolute, normalized) is a Container-only path for a launch with `patterns`: every path outside the
 * Workspace, and the Workspace's paths the last covering pattern names. No patterns (a launch without any, or the local
 * Container, which keeps none) leaves every Workspace path synced.
 */
export const isContainerOnly = (path: string, patterns: readonly string[] | undefined): boolean => {
  if (path === WORKSPACE_ROOT) return false;

  if (!path.startsWith(`${WORKSPACE_ROOT}/`)) return true;

  if (patterns === undefined || patterns.length === 0) return false;

  const covered = prefixes(path.slice(WORKSPACE_ROOT.length + 1));
  let local = false;

  for (const pattern of patterns.map(compile)) {
    if (covered.some((prefix) => pattern.test.test(prefix))) local = !pattern.exclude;
  }

  return local;
};
