// A fake GitHub for the Skill fetch, update and daily check tests: repos whose branches and tags move as commits are
// pushed, read through a `RepoReader` that counts each request, so a test can say how many a run spent. Blob SHAs are
// made of the content (as git's are), so a file changes its SHA exactly when its text does.
// @effect-diagnostics preferEffectArray:off preferEffectRecord:off asyncFunction:off missingPipeableSignature:off
import { GithubReadError, type RepoReader, type SkillRepo } from "./skill-fetch.ts";

export type Files = Readonly<Record<string, string>>;

/** The 40 hex digits of a string's hash: a stand-in for git's SHA that depends on the content alone. */
const shaOf = (text: string): string => {
  let hash = 5381;

  for (let at = 0; at < text.length; at += 1) {
    hash = (hash * 33) ^ text.charCodeAt(at);
    hash >>>= 0;
  }

  return hash.toString(16).padStart(8, "0").repeat(5);
};

export const fakeGithub = () => {
  /** Each repo's commits, by SHA. */
  const commits = new Map<string, { readonly repo: string; readonly files: Files }>();
  /** The commit each `<repo>@<ref>` (a branch or a tag; `main` is the default branch) names. */
  const refs = new Map<string, string>();
  const requests: string[] = [];
  const failures = new Map<string, GithubReadError>();
  let next = 1;

  const key = ({ owner, name }: SkillRepo) => `${owner}/${name}`;

  const resolve = (repo: SkillRepo, ref: string | null): string => {
    const named = refs.get(`${key(repo)}@${ref ?? "main"}`);

    if (named !== undefined) return named;

    if (ref !== null && commits.get(ref)?.repo === key(repo)) return ref;

    throw GithubReadError.of("not_found", `GitHub has no ref ${ref} in ${key(repo)}`);
  };

  const failing = (repo: SkillRepo) => {
    const failure = failures.get(key(repo));

    if (failure !== undefined) throw failure;
  };

  const treeOf = (commit: string) => {
    const files = commits.get(commit)?.files ?? {};

    return {
      truncated: false,
      entries: Object.entries(files).map(([path, text]) => ({
        path,
        type: "blob" as const,
        sha: shaOf(text),
        size: new TextEncoder().encode(text).length,
      })),
    };
  };

  const reader: RepoReader = {
    commit: async (repo, ref) => {
      requests.push(`commit ${key(repo)}@${ref ?? "HEAD"}`);
      failing(repo);

      return resolve(repo, ref);
    },
    tree: async (repo, commit) => {
      requests.push(`tree ${key(repo)}@${commit.slice(0, 7)}`);
      failing(repo);

      return treeOf(commit);
    },
    headTree: async (repo, ref) => {
      requests.push(`headTree ${key(repo)}@${ref ?? "HEAD"}`);
      failing(repo);

      return treeOf(resolve(repo, ref));
    },
    blob: async (repo, sha) => {
      requests.push(`blob ${key(repo)}@${sha.slice(0, 7)}`);
      failing(repo);

      for (const { repo: owner, files } of commits.values()) {
        if (owner !== key(repo)) continue;

        for (const text of Object.values(files)) {
          if (shaOf(text) === sha) return new TextEncoder().encode(text);
        }
      }

      throw GithubReadError.of("not_found", `no blob ${sha}`);
    },
  };

  return {
    reader,
    /** Every request made so far, in order. */
    requests,
    /** Push `files` as a new commit of `repo`'s branch or tag `ref` (`main`: the default branch); its SHA. */
    push: (repo: string, files: Files, ref = "main"): string => {
      const commit =
        `${(next++).toString(16).padStart(2, "0")}${shaOf(`${repo}${ref}${next}`)}`.slice(0, 40);

      commits.set(commit, { repo, files });
      refs.set(`${repo}@${ref}`, commit);

      return commit;
    },
    /** Make every request about `repo` fail as `failure`; `undefined` stops. */
    fail: (repo: string, failure: GithubReadError | undefined) => {
      if (failure === undefined) failures.delete(repo);
      else failures.set(repo, failure);
    },
    /** Forget the requests made so far. */
    reset: () => {
      requests.length = 0;
    },
  };
};

/** A `SKILL.md` that declares `name`. */
export const skillMd = (name: string, body = "Steps.") =>
  `---\nname: ${name}\ndescription: What ${name} does.\n---\n${body}\n`;
