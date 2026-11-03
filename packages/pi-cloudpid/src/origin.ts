// @effect-diagnostics *:off -- a program on the owner's machine, not Effect code (the bundle carries only `effect/Predicate`).
/**
 * Matching the checkout to an Environment (docs/architecture/mcp-endpoint.md → The `/cloudpid` command → The
 * Environment): the repo's `origin` and each Environment Repo's URL are both normalized to `https://host/path` and
 * compared.
 */

/** `[user@]host:path`: not a Windows drive (`C:\repos`), whose host is one letter and whose path has backslashes. */
const SCP_STYLE = /^(?:[^@/\s\\]+@)?([^:/\s\\]{2,}):(?!\/)([^\\]+)$/;

const tidy = (path: string): string =>
  path
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");

/**
 * `https://host/path`, lower-cased, for an `origin` as git prints it, or undefined for one that is not on a host (a
 * local path, a `file:` URL, an empty string). Scp-style (`git@github.com:owner/repo.git`), `ssh://`, `git://`,
 * `http://` and `https://` are all `https://`; a user and password, `.git` and trailing slashes are dropped. An ssh or
 * git port is dropped with the scheme (it is not the https port); an http or https port is kept.
 */
export const normalizeRepoUrl = (raw: string): string | undefined => {
  const text = raw.trim();

  if (text === "") return undefined;

  if (!text.includes("://")) {
    const scp = SCP_STYLE.exec(text);

    if (scp === null) return undefined;

    const [, host = "", path = ""] = scp;
    const clean = tidy(path.replace(/^\/+/, ""));

    return host === "" || clean === "" ? undefined : `https://${host}/${clean}`.toLowerCase();
  }

  let url: URL;

  try {
    url = new URL(text);
  } catch {
    return undefined;
  }

  if (!["ssh:", "git:", "http:", "https:"].includes(url.protocol) || url.hostname === "") {
    return undefined;
  }

  const path = tidy(decodeURIComponent(url.pathname).replace(/^\/+/, ""));

  if (path === "") return undefined;

  const web = url.protocol === "http:" || url.protocol === "https:";
  const port = web && url.port !== "" ? `:${url.port}` : "";

  return `https://${url.hostname}${port}/${path}`.toLowerCase();
};

/** The Repos of an Environment as `environments_list` gives them. */
export interface EnvironmentRepos {
  readonly repos: ReadonlyArray<{ readonly url: string }>;
}

/** The Environments with a Repo whose URL is `origin`'s, in the order given. */
export const matchEnvironments = <T extends EnvironmentRepos>(
  environments: ReadonlyArray<T>,
  origin: string,
): ReadonlyArray<T> => {
  const wanted = normalizeRepoUrl(origin);

  if (wanted === undefined) return [];

  return environments.filter((environment) =>
    environment.repos.some((repo) => normalizeRepoUrl(repo.url) === wanted),
  );
};
