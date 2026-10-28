// @effect-diagnostics preferEffectArray:off -- JSX lists of rows are native arrays.

// The repo page (`/skills/:owner/:repo`, with `?ref=`; ADR-0026, docs/architecture/client-and-protocol.md → Skills page):
// every Skill GitHub has in the repo at the ref, read by the main Worker as the GitHub App (so a private repo the app can
// read is listed, and a repo skills.sh does not know is too), each with its description, its installs when skills.sh has
// them and where it is installed here, a checkbox, and Install selected, which opens the target picker at the ref. A row
// links to the Skill's page (#309). A repo that is not there, that the app cannot read, that has no such ref or no Skills
// says so plainly.

import { type RepoSkill, type SkillRepoListing } from "@cloudpid/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Download, ExternalLink } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { compactCount } from "./format.ts";
import { InAppLink } from "./in-app-link.tsx";
import {
  skillOwnerPath,
  skillPagePath,
  skillRepoParamsAtom,
  skillRepoPath,
  SKILLS_PATH,
} from "./router.ts";
import { Credit } from "./skills-directory.tsx";
import { useInstallPicker } from "./skills-install-dialog.tsx";
import { SkillsFrame } from "./skills-page.tsx";
import {
  checkedSkillsAtom,
  checkedSkillsOf,
  installSelected,
  skillRepoAtom,
  skillRepoFailureOf,
  skillRepoKey,
  type SkillRepoFailure,
  type SkillRepoKey,
} from "./skills-repo-state.ts";
import { directoryBadges } from "./skills.ts";

/** The repo's folder on GitHub, at `commit` (the one listed, so what is shown is what is read). */
const githubFolder = ({ owner, repo }: SkillRepoKey, commit: string, path: string): string =>
  `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tree/${commit}${path === "" ? "" : `/${path.split("/").map(encodeURIComponent).join("/")}`}`;

/** The badges of where a Skill is installed here, update available in amber. */
const Badges = ({ skill }: { skill: RepoSkill }) => {
  const badges = directoryBadges(skill.installed);

  return badges.length === 0 ? null : (
    <ul aria-label="Installed here" className="flex flex-wrap gap-x-2 text-xs">
      {badges.map((badge) => (
        <li
          key={badge}
          className={
            badge === "update available"
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground"
          }
        >
          {badge}
        </li>
      ))}
    </ul>
  );
};

/** One Skill of the repo: its checkbox, its name linking to the Skill's page, its description, its folder and badges, and its installs. */
const RepoSkillRow = ({
  skill,
  repo,
  commit,
  checked,
  onCheck,
}: {
  skill: RepoSkill;
  repo: SkillRepoKey;
  commit: string;
  checked: boolean;
  onCheck: (checked: boolean) => void;
}) => (
  <li className="flex items-start gap-3 py-3">
    <input
      type="checkbox"
      className="mt-1 size-4 shrink-0"
      checked={checked}
      aria-label={`Select ${skill.name}`}
      onChange={(event) => {
        onCheck(event.target.checked);
      }}
    />
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <InAppLink
        href={skillPagePath(repo.owner, repo.repo, skill.skillId, repo.ref)}
        className="truncate font-mono text-sm font-medium hover:underline"
      >
        {skill.name}
      </InAppLink>
      <p className="line-clamp-2 text-sm break-words text-muted-foreground">{skill.description}</p>
      <a
        href={githubFolder(repo, commit, skill.path)}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`${skill.name}'s folder on GitHub`}
        className="flex w-fit max-w-full items-center gap-1 truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        <span className="truncate">{skill.path === "" ? "(repo root)" : skill.path}</span>
        <ExternalLink className="size-3 shrink-0" />
      </a>
      <Badges skill={skill} />
    </div>
    {skill.installs !== undefined && (
      <span
        className="w-14 shrink-0 pt-0.5 text-right text-sm text-muted-foreground tabular-nums"
        title={`${skill.installs.toLocaleString("en-US")} installs`}
      >
        {compactCount(skill.installs)}
      </span>
    )}
  </li>
);

/** The Skills of the repo, with Install selected over the ones checked. */
const RepoSkills = ({ listing, repo }: { listing: SkillRepoListing; repo: SkillRepoKey }) => {
  const pick = useInstallPicker();
  const [checkedPaths, setChecked] = useAtom(checkedSkillsAtom(repo));
  // Only the Skills the listing has now count, whatever an earlier listing of the repo had checked.
  const checked = checkedSkillsOf(listing, checkedPaths);
  const toInstall = installSelected(listing, checkedPaths, repo.ref);
  const all = checked.length === listing.skills.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 border-b pb-2">
        <label className="flex items-center gap-3 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 shrink-0"
            checked={all}
            onChange={(event) => {
              setChecked(
                event.target.checked
                  ? new Set(listing.skills.map((skill) => skill.path))
                  : new Set<string>(),
              );
            }}
          />
          {listing.skills.length === 1 ? "1 skill" : `${listing.skills.length} skills`}
        </label>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={toInstall === null}
          onClick={() => {
            if (toInstall !== null) pick(toInstall);
          }}
        >
          <Download />
          Install selected{checked.length === 0 ? "" : ` (${checked.length})`}
        </Button>
      </div>
      <ul aria-label={`Skills in ${listing.repo}`} className="flex flex-col divide-y">
        {listing.skills.map((skill) => (
          <RepoSkillRow
            key={skill.path}
            skill={skill}
            repo={repo}
            commit={listing.commit}
            checked={checkedPaths.has(skill.path)}
            onCheck={(on) => {
              const next = new Set(checkedPaths);

              if (on) next.add(skill.path);
              else next.delete(skill.path);

              setChecked(next);
            }}
          />
        ))}
      </ul>
      {listing.omitted > 0 && (
        <p className="text-xs text-muted-foreground">
          The repo holds {listing.omitted} more SKILL.md files than are listed here. Install one
          from the Installed tab with its folder's GitHub URL.
        </p>
      )}
      {listing.skills.some((skill) => skill.installs !== undefined) && <Credit />}
    </div>
  );
};

/** What was in the repo that is not a Skill, so that an empty repo page can say why. */
const Unreadable = ({ listing }: { listing: SkillRepoListing }) =>
  listing.unreadable.length === 0 ? null : (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <p>
        {listing.unreadable.length === 1
          ? "1 SKILL.md cannot be read as a Skill:"
          : `${listing.unreadable.length} SKILL.md files cannot be read as Skills:`}
      </p>
      <ul className="flex flex-col gap-0.5">
        {listing.unreadable.map(({ path, message }) => (
          <li key={path} className="font-mono break-words">
            {path === "" ? "SKILL.md" : `${path}/SKILL.md`}: {message}
          </li>
        ))}
      </ul>
    </div>
  );

/** Why the repo cannot be listed, said plainly for each kind, with a way out where there is one. */
const RepoProblem = ({
  failure,
  repo,
  retry,
}: {
  failure: SkillRepoFailure;
  repo: SkillRepoKey;
  retry: () => void;
}) => {
  const where = `${repo.owner}/${repo.repo}`;

  switch (failure.kind) {
    case "not_found":
      return (
        <div role="alert" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{where} was not found, or the GitHub App cannot read it.</p>
          <p className="text-muted-foreground">
            GitHub answers the same for a repo that does not exist and for a private one the app is
            not installed on, so the two cannot be told apart. {failure.message}
          </p>
        </div>
      );
    case "bad_ref":
      return (
        <div role="alert" className="flex flex-col items-start gap-1 text-sm">
          <p className="font-medium">
            {where} has no branch, tag or commit “{repo.ref}”.
          </p>
          <p className="text-muted-foreground">
            The repo can be read.{" "}
            <InAppLink
              href={skillRepoPath(repo.owner, repo.repo)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Show its default branch
            </InAppLink>
            .
          </p>
        </div>
      );
    case "invalid":
      return (
        <div role="alert" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">That is not a repo GitHub can have.</p>
          <p className="text-muted-foreground">{failure.message}</p>
        </div>
      );
    default:
      return (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm">
          <p className="font-medium">GitHub did not list the skills in {where}.</p>
          <p className="text-muted-foreground">{failure.message}</p>
          <Button type="button" size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        </div>
      );
  }
};

/** The repo's listing, or why there is none, or that it is being read. */
const RepoBody = ({ repo }: { repo: SkillRepoKey }) => {
  const answer = useAtomValue(skillRepoAtom(repo));
  const refresh = useAtomRefresh(skillRepoAtom(repo));
  const listing = answer.pipe(AsyncResult.value, Option.getOrNull);
  const failure = skillRepoFailureOf(answer);

  if (listing === null) {
    return failure === null ? (
      <p className="text-sm text-muted-foreground">
        Reading {repo.owner}/{repo.repo} from GitHub…
      </p>
    ) : (
      <RepoProblem failure={failure} repo={repo} retry={refresh} />
    );
  }

  if (listing.skills.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-sm">
          {listing.repo} holds no skills{repo.ref === undefined ? "" : ` at ${repo.ref}`}: no folder
          with a SKILL.md that has a name and a description.
        </p>
        <Unreadable listing={listing} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <RepoSkills listing={listing} repo={repo} />
      <Unreadable listing={listing} />
    </div>
  );
};

/**
 * The repo page: the owner (linking to its page), the repo and the ref shown, a link to the repo on GitHub, and what the
 * repo holds.
 */
export const SkillRepoPage = ({ owner, repo }: { owner: string; repo: string }) => {
  const { ref } = useAtomValue(skillRepoParamsAtom);
  const key = skillRepoKey(owner, repo, ref);

  return (
    <SkillsFrame title={`${owner}/${repo}`}>
      <div className="-mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
          <InAppLink href={SKILLS_PATH} className="hover:text-foreground hover:underline">
            Skills
          </InAppLink>
          <span aria-hidden>/</span>
          <InAppLink href={skillOwnerPath(owner)} className="hover:text-foreground hover:underline">
            {owner}
          </InAppLink>
          <span aria-hidden>/</span>
          <span className="text-foreground">{repo}</span>
        </nav>
        {ref !== undefined && (
          <span className="rounded-md border px-1.5 py-0.5 font-mono text-xs" title="The ref shown">
            {ref}
          </span>
        )}
        <a
          href={`https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`}
          target="_blank"
          rel="noreferrer noopener"
          className="ml-auto flex items-center gap-1 text-xs hover:text-foreground hover:underline"
        >
          On GitHub
          <ExternalLink className="size-3" />
        </a>
      </div>
      <RepoBody key={`${owner}/${repo}@${ref ?? ""}`} repo={key} />
    </SkillsFrame>
  );
};
