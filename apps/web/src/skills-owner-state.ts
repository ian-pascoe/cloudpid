// The owner page's state (`/skills/:owner`; ADR-0026, docs/architecture/client-and-protocol.md → Skills page): the owner's
// repos that the Skill directory (skills.sh) lists Skills of, grouped by the Registry from its search, and what the "Open a
// repo" field turns what is typed into: a repo page of the owner, for a repo the directory does not list.
import * as Atom from "effect/reactivity/Atom";
import { RegistryClient } from "./registry.ts";
import { skillRepoPath } from "./router.ts";

/**
 * The repos the Skill directory lists of `owner`, the most installed first, or its `SkillDirectoryError` (skills.sh did
 * not answer). It is a search, so it is at most 200 results and fuzzy: the answer says when the limit was hit.
 */
export const skillOwnerAtom = Atom.family((owner: string) =>
  RegistryClient.query("listOwnerRepos", { owner }),
);

/** What "Open a repo" does with what was typed: the repo's page, or what is wrong with it. */
export type OpenRepo =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

/**
 * The page of the repo named by `typed` among `owner`'s: the repo's name (`skills`), or with the owner in front
 * (`mattpocock/skills`, as GitHub shows it; the owner's case does not matter). Anything else is not a repo of the owner.
 * Whether GitHub has the repo is for its page to say.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain function over what was typed, called from React.
export const openRepoPath = (owner: string, typed: string): OpenRepo => {
  const name = typed.trim();

  if (name === "") return { ok: false, message: `Type the name of a repo of ${owner}.` };

  const parts = name.split("/");
  const [first, second] = parts;
  const withOwner = parts.length === 2 && first?.toLowerCase() === owner.toLowerCase();
  const repo = withOwner ? second : parts.length === 1 ? first : undefined;

  if (repo === undefined || repo === "" || /\s/.test(repo)) {
    return {
      ok: false,
      message: `“${name}” is not a repo of ${owner}: type its name, such as skills, or ${owner}/skills.`,
    };
  }

  return { ok: true, path: skillRepoPath(owner, repo) };
};
