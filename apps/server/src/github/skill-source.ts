// What a Skill source is, as written (ADR-0026, `docs/spec.md` → _Installing from GitHub_): a GitHub repo, with a Skill
// named, or a folder of a ref. Only GitHub is installed from; any other source goes through the agent and `npx skills`.
// @effect-diagnostics preferEffectArray:off

/** A source as the owner or the agent wrote it, parsed. */
export type SkillSourceInput = {
  readonly owner: string;
  readonly name: string;
  /** `owner/name`. */
  readonly repo: string;
  /** The ref named (a branch, tag or commit), or null for the repo's default branch. */
  readonly ref: string | null;
  /** The folder the source points at (`""` for the whole repo): only Skills at or below it are looked for. */
  readonly path: string;
  /** The Skill an `owner/repo@skill` names, or null. */
  readonly skill: string | null;
};

export type SkillSourceParse =
  | { readonly ok: true; readonly source: SkillSourceInput }
  | { readonly ok: false; readonly message: string };

/** What the forms are, for a message. */
export const SOURCE_FORMS =
  "`owner/repo`, `owner/repo@skill`, or a GitHub URL such as `https://github.com/owner/repo/tree/<ref>/<path>`";

/** A GitHub account's login: letters, digits and hyphens. */
const OWNER = "[A-Za-z0-9-]+";

/** A repo's name. */
const NAME = "[A-Za-z0-9_.-]+";

const SHORTHAND = new RegExp(`^(${OWNER})/(${NAME})(?:@(.+))?$`);

const URL_SOURCE = new RegExp(
  `^(?:https?://)?(?:www\\.)?github\\.com/(${OWNER})/(${NAME}?)(?:\\.git)?(?:/(.*))?$`,
  "i",
);

const refused = (input: string, why: string): SkillSourceParse => ({
  ok: false,
  message: `${JSON.stringify(input)} is not a source to install from: ${why}. Use ${SOURCE_FORMS}.`,
});

const decode = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** Why `path` is not a folder inside a repo, or undefined: no `..` segment, no backslash, nothing empty in it. */
const pathProblem = (path: string): string | undefined => {
  if (path.includes("\\")) return "the path may not hold a backslash";

  return path.split("/").some((segment) => segment === ".." || segment === ".")
    ? "the path may not hold a `.` or `..` segment"
    : undefined;
};

const make = (
  owner: string,
  name: string,
  parts: { ref?: string; path?: string; skill?: string },
): SkillSourceInput => ({
  owner,
  name,
  repo: `${owner}/${name}`,
  ref: parts.ref ?? null,
  path: parts.path ?? "",
  skill: parts.skill ?? null,
});

/**
 * `input` as a source: `owner/repo`, `owner/repo@skill`, or a GitHub URL (`https://github.com/owner/repo`, optionally
 * `/tree/<ref>` and a folder below it). As in the `skills` CLI, the first segment after `tree/` is the ref, so a branch
 * name with a slash cannot be named in a URL; a commit's SHA, a tag or a branch without one can.
 */
export const parseSkillSource = (input: string): SkillSourceParse => {
  const text = input.trim();

  if (text === "") return refused(input, "it is empty");

  const url = URL_SOURCE.exec(text.replace(/[?#].*$/, ""));

  if (url !== null) {
    const [, owner, name, rest] = url;

    if (owner === undefined || name === undefined) return refused(input, "it names no repo");

    const segments = (rest ?? "").split("/").filter((segment) => segment !== "");

    if (segments.length === 0) return { ok: true, source: make(owner, name, {}) };

    if (segments[0] !== "tree") {
      return refused(input, "after the repo, only `/tree/<ref>/<path>` can follow");
    }

    const ref = decode(segments[1] ?? "");

    if (ref === "") return refused(input, "`/tree/` names no ref");

    const path = segments.slice(2).map(decode).join("/");
    const problem = pathProblem(path);

    if (problem !== undefined) return refused(input, problem);

    return { ok: true, source: make(owner, name, { ref, path }) };
  }

  const shorthand = SHORTHAND.exec(text);

  if (shorthand === null) return refused(input, "it is not a GitHub repo");

  const [, owner, name, skill] = shorthand;

  if (owner === undefined || name === undefined) return refused(input, "it names no repo");

  if (skill !== undefined && skill.trim() === "") return refused(input, "`@` names no Skill");

  return {
    ok: true,
    source: make(owner, name.replace(/\.git$/, ""), skill === undefined ? {} : { skill }),
  };
};
