// Repos in a Workspace (`docs/spec.md` → Filesystem and tools): one directory per repo below `/workspace`, named by
// the owner or taken from the clone URL. Both the web app (to check input as it is typed) and the server (before a
// name reaches a path or a URL reaches `git`) use these, so the rules are in one place.
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** The Workspace root: one directory per repo below it. */
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

const isRepoName = (name: string): boolean =>
  REPO_NAME.test(name) && name.length <= MAX_REPO_NAME_LENGTH;

/** The directory of repo `name` in a Workspace. */
export const repoDirectory = (name: string): string => `${WORKSPACE_ROOT}/${name}`;

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

/** A Workspace operation that failed, with a message for a person: a clone that did not finish, a repo that is not there. */
export class WorkspaceError extends Schema.TaggedError<
  WorkspaceError,
  { readonly brand: unique symbol }
>()("WorkspaceError", {
  message: Schema.String,
}) {}
