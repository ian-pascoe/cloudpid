// @effect-diagnostics missingPipeableSignature:off
// An Environment's Repos (`docs/architecture/workspace.md` → Filesystem and tools, ADR-0016): each Workspace clones every one into a
// directory of its own below `/workspace`, named by the owner or taken from the clone URL. Both the web app (to check
// input as it is typed) and the server (before a name reaches a path or a URL reaches `git`) use these, so the rules are
// in one place.
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** A Workspace's root: one directory per repo below it. */
export const WORKSPACE_ROOT = "/workspace";

/** The longest repo directory name. */
export const MAX_REPO_NAME_LENGTH = 100;

/**
 * The name of a repo's directory directly below `/workspace`: letters, digits, dots, underscores and dashes, starting
 * with a letter or digit, so it is never `.`, `..`, hidden, an option, or a path.
 */
export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const RepoName = Schema.String.check(
  Schema.isPattern(REPO_NAME),
  Schema.isMaxLength(MAX_REPO_NAME_LENGTH),
);

/** Whether `name` is a valid repo directory name (`RepoName`). */
export const isRepoName = (name: string): boolean =>
  REPO_NAME.test(name) && name.length <= MAX_REPO_NAME_LENGTH;

/** The directory of repo `name` in a Workspace: its clone. */
export const repoDirectory = (name: string): string => `${WORKSPACE_ROOT}/${name}`;

/**
 * The directory a Session works in when a conversation names no `cwd`: its Workspace's one repo, or the root when the
 * Workspace has none or several.
 */
export const workspaceDirectory = (repos: ReadonlyArray<string>): string =>
  repos.length === 1 ? repoDirectory(repos[0] ?? "") : WORKSPACE_ROOT;

/** A Workspace's id: eight lowercase hex digits. Never `new`. */
export const WORKSPACE_ID = /^[0-9a-f]{8}$/;

/** A Workspace's id, as a payload carries it: `WORKSPACE_ID`. */
export const WorkspaceId = Schema.String.check(Schema.isPattern(WORKSPACE_ID));

/** Whether `id` is a Workspace's id (`WorkspaceId`). */
export const isWorkspaceId = (id: string): boolean => WORKSPACE_ID.test(id);

/** The longest branch a Workspace may be made on, or from. */
export const MAX_BRANCH_LENGTH = 200;

const BRANCH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Why `name` cannot be a Workspace's branch, or undefined when it can: segments of letters, digits, dots, underscores
 * and dashes split by single slashes, none hidden or ending in `.lock` or a dot, no `..`, at most 200 characters, and
 * not `HEAD`. Stricter than git's own rules (`git check-ref-format --branch`), so the name is never an option, a range,
 * a revision expression or anything a shell would read.
 */
export const branchProblem = (name: string): string | undefined => {
  if (name === "") return "Give the branch a name";

  if (name.length > MAX_BRANCH_LENGTH) return `Use at most ${MAX_BRANCH_LENGTH} characters`;

  if (name === "HEAD") return "HEAD is not a branch name";

  if (name.includes("..")) return "A branch name may not contain ..";

  return Arr.every(
    name.split("/"),
    (segment) =>
      BRANCH_SEGMENT.test(segment) && !segment.endsWith(".lock") && !segment.endsWith("."),
  )
    ? undefined
    : "Use letters, digits, dots, underscores and dashes, in parts split by single slashes";
};

/** A branch a new Workspace may be on or made from, as a payload carries it: one `branchProblem` finds nothing wrong with. */
export const BranchName = Schema.String.check(Schema.makeFilter(branchProblem));

/**
 * The placeholder branch of an Environment's spare Workspace (ADR-0016), made ahead of the Session that takes it: its
 * clones are on it until then, and the Workspace that takes it switches them to its own branch.
 */
export const SPARE_BRANCH = "cloudpid/spare";

/** Why `name` cannot be the branch the owner names for a new Workspace: `branchProblem`'s, or it is `SPARE_BRANCH`. */
export const ownBranchProblem = (name: string): string | undefined =>
  branchProblem(name) ??
  (name === SPARE_BRANCH
    ? `${SPARE_BRANCH} is kept for spare workspaces: name another`
    : undefined);

/** The longest repo address a person may enter. */
export const MAX_REPO_SOURCE_LENGTH = 300;

/** A repo to clone: the `https` URL `git clone` gets, and the directory it clones into unless the owner names another. */
export type RepoSource = { readonly url: string; readonly name: string };

const SHORTHAND = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

const PRIVATE_SUFFIXES = [".internal", ".local", ".localhost", ".lan", ".home.arpa"];

/** Whether `hostname` is a public-looking DNS name: dotted, with a top-level label that is not a number. */
const isPublicHost = (hostname: string): boolean => {
  const labels = hostname.split(".");

  return (
    labels.length >= 2 &&
    Arr.every(labels, (label) => label.length <= 63 && HOST_LABEL.test(label)) &&
    /[a-z]/.test(labels[labels.length - 1] ?? "") &&
    !Arr.some(PRIVATE_SUFFIXES, (suffix) => hostname.endsWith(suffix))
  );
};

const withoutGitSuffix = (segment: string): string =>
  segment.endsWith(".git") ? segment.slice(0, -".git".length) : segment;

const named = (url: string, last: string): Result.Result<RepoSource, string> => {
  const name = withoutGitSuffix(last);

  return isRepoName(name)
    ? Result.succeed({ url, name })
    : Result.fail(
        `"${name}" is not a usable directory name: use letters, digits, dots, underscores and dashes`,
      );
};

/**
 * Read what the owner entered as the repo to clone: `owner/repo` (a GitHub repo) or an `https` URL of a public-looking
 * host with a path of plain segments. Everything else fails with the reason: other schemes (`file:`, `ssh:`, `ext::`),
 * credentials, ports, queries, fragments, options, single-label and numeric hosts, and paths with `..`, escapes or
 * spaces, so nothing the result holds can be taken for an option, a path or a command by `git` or a shell.
 */
export const parseRepoSource = (input: string): Result.Result<RepoSource, string> => {
  const text = input.trim();

  if (text === "") return Result.fail("Enter a repo as owner/repo or an https URL");

  if (text.length > MAX_REPO_SOURCE_LENGTH) return Result.fail("That address is too long");

  const short = SHORTHAND.exec(text);

  if (short !== null) {
    return named(
      `https://github.com/${short[1]}/${withoutGitSuffix(short[2] ?? "")}.git`,
      short[2] ?? "",
    );
  }

  if (!/^https:\/\/[^\s?#@%\\]+$/.test(text)) {
    return Result.fail("Enter a repo as owner/repo or a plain https URL");
  }

  const url = URL.parse(text);

  if (url === null || url.protocol !== "https:") return Result.fail("Enter an https URL");

  if (url.username !== "" || url.password !== "" || url.port !== "") {
    return Result.fail("The URL may not carry credentials or a port");
  }

  if (!isPublicHost(url.hostname)) return Result.fail(`${url.hostname} is not a public host`);

  const segments = Arr.filter(url.pathname.split("/"), (segment) => segment !== "");

  if (segments.length < 2 || !Arr.every(segments, (segment) => PATH_SEGMENT.test(segment))) {
    return Result.fail("The URL must end in a path like /owner/repo");
  }

  if (Arr.some(segments, (segment) => /^\.+$/.test(segment))) {
    return Result.fail("The URL's path may not contain . or ..");
  }

  return named(
    `https://${url.hostname}/${Arr.join(segments, "/")}`,
    segments[segments.length - 1] ?? "",
  );
};

/**
 * An Environment or Workspace operation that failed, with a message for a person: a repo address that is not valid, a
 * Workspace that is not there, a Container that could not be restarted.
 */
export class EnvironmentError extends Schema.TaggedError<
  EnvironmentError,
  { readonly brand: unique symbol }
>()("EnvironmentError", {
  message: Schema.String,
}) {}
