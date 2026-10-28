// @effect-diagnostics preferEffectArray:off -- JSX lists of files and copies are native arrays.

// A Skill's page (`/skills/:owner/:repo/:skill`, with `?ref=` and, for one of several Skills of a name, `?path=`; ADR-0026,
// docs/architecture/client-and-protocol.md → Skills page): the Skill as GitHub has it at the ref's head, read by the main
// Worker as the GitHub App (so a private repo the app can read works): its SKILL.md rendered and the files an install
// would take, the commit it was read at, its installs when skills.sh knows them, an Install button that opens the target
// picker, and where it is installed here with the marks, Update and Remove of the Installed tab (`skills-installed.tsx`).
// A repo that is not there, that the app cannot read, that has no such ref or Skill, that has too many skills to find one
// by its name, or a name that means several Skills, says so plainly.

import { type SkillView } from "@cloudpid/protocol";
import { skillSourceText } from "@cloudpid/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Download, ExternalLink } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { environmentNamesAtom } from "./environments-state.ts";
import { EVERY_ENVIRONMENT } from "./environments.ts";
import { byteSize, compactCount } from "./format.ts";
import { InAppLink } from "./in-app-link.tsx";
import { StaticMarkdown } from "./markdown.tsx";
import {
  skillOwnerPath,
  skillPagePath,
  skillRepoParamsAtom,
  skillRepoPath,
  SKILLS_PATH,
} from "./router.ts";
import { Credit } from "./skills-directory.tsx";
import { useInstallPicker } from "./skills-install-dialog.tsx";
import { SkillDialogs, SkillMarks, SkillRowActions } from "./skills-installed.tsx";
import { SkillsFrame } from "./skills-page.tsx";
import { skillRepoFailureOf, type SkillRepoFailure } from "./skills-repo-state.ts";
import {
  installedCopiesAtom,
  skillToInstall,
  skillViewAtom,
  skillViewKey,
  type SkillViewKey,
} from "./skills-skill-state.ts";
import { directoryBadges, githubFileUrl, skillMdBody } from "./skills.ts";

/** The Skill's folder on GitHub at `commit` (the one read, so what is shown is what is read). */
const githubFolderUrl = (repo: string, commit: string, path: string): string =>
  `https://github.com/${repo}/tree/${commit}${path === "" ? "" : `/${path.split("/").map(encodeURIComponent).join("/")}`}`;

/** Why the Skill cannot be shown, said plainly for each kind, with a way out where there is one. */
const SkillProblem = ({
  failure,
  page,
  retry,
}: {
  failure: SkillRepoFailure;
  page: SkillViewKey;
  retry: () => void;
}) => {
  const where = `${page.owner}/${page.repo}`;

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
        <div role="alert" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">
            {where} has no branch, tag or commit “{page.ref}”.
          </p>
          <p className="text-muted-foreground">
            The repo can be read.{" "}
            <InAppLink
              href={skillPagePath(page.owner, page.repo, page.skill, { path: page.path })}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Show the Skill on its default branch
            </InAppLink>
            .
          </p>
        </div>
      );
    case "no_skill":
      return (
        <div role="alert" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">
            {where} has no skill “{page.skill}”{page.ref === undefined ? "" : ` at ${page.ref}`}.
          </p>
          <p className="text-muted-foreground">
            {/* Asked for by name, the title says it all; a folder asked for has its own reason. */}
            {page.path !== undefined && <>{failure.message} </>}
            <InAppLink
              href={skillRepoPath(page.owner, page.repo, page.ref)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              See the skills in {where}
            </InAppLink>
            .
          </p>
        </div>
      );
    case "too_many":
      return (
        <div role="alert" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">
            {where} has too many skills to find “{page.skill}” by its name.
          </p>
          <p className="text-muted-foreground">
            {failure.message}{" "}
            <InAppLink
              href={skillRepoPath(page.owner, page.repo, page.ref)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              Pick it from the skills in {where}
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
          <p className="font-medium">GitHub did not give the skill {page.skill}.</p>
          <p className="text-muted-foreground">{failure.message}</p>
          <Button type="button" size="sm" variant="outline" onClick={retry}>
            Try again
          </Button>
        </div>
      );
  }
};

/** The Skills of the repo a name could mean, each a link to its own page by its folder. */
const Candidates = ({
  page,
  candidates,
}: {
  page: SkillViewKey;
  candidates: ReadonlyArray<{ name: string; description: string; path: string }>;
}) => (
  <div className="flex flex-col gap-3" role="status">
    <p className="text-sm">
      {candidates.length} skills in {page.owner}/{page.repo} are called “{page.skill}”. Which one?
    </p>
    <ul aria-label="Skills the name could mean" className="flex flex-col divide-y">
      {candidates.map((candidate) => (
        <li key={candidate.path} className="flex flex-col gap-0.5 py-3">
          <InAppLink
            href={skillPagePath(page.owner, page.repo, candidate.name, {
              ref: page.ref,
              path: candidate.path,
            })}
            className="w-fit font-mono text-sm font-medium hover:underline"
          >
            {candidate.name}
          </InAppLink>
          <p className="line-clamp-2 text-sm break-words text-muted-foreground">
            {candidate.description}
          </p>
          <span className="font-mono text-xs break-all text-muted-foreground">
            {candidate.path === "" ? "(repo root)" : candidate.path}
          </span>
        </li>
      ))}
    </ul>
  </div>
);

/** Where the Skill is installed: each scope that keeps a copy, with its marks, Update and Remove as on the Installed tab. */
const InstalledHere = ({ skill }: { skill: SkillView }) => {
  const installed = useAtomValue(installedCopiesAtom({ repo: skill.repo, path: skill.path }));
  const names = useAtomValue(environmentNamesAtom);

  return (
    <section aria-label="Installed here" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Installed here</h2>
      {installed.scopes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {installed.loading
            ? "Checking where it is installed…"
            : "Not installed in any environment."}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {installed.scopes.map(({ scope, skills, copies }) => (
            <li key={scope} className="flex flex-col gap-1 rounded-lg border p-3">
              <h3 className="text-xs font-medium text-muted-foreground">
                {scope === EVERY_ENVIRONMENT
                  ? "Every environment"
                  : (names[scope] ?? `Environment ${scope}`)}
              </h3>
              <ul className="flex flex-col gap-1">
                {copies.map((copy) => (
                  <li key={copy.name} className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-mono text-sm">{copy.name}</span>
                      {copy.source !== undefined && (
                        <span className="truncate font-mono text-xs text-muted-foreground">
                          {skillSourceText(copy.source)}
                        </span>
                      )}
                      <SkillMarks skill={copy} />
                    </span>
                    <SkillRowActions id={scope} skill={copy} />
                  </li>
                ))}
              </ul>
              <SkillDialogs id={scope} skills={skills} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

/** The files an install would take, each a link to the file on GitHub at the commit read. */
const Files = ({ skill }: { skill: SkillView }) => (
  <section aria-label="Files" className="flex flex-col gap-2">
    <h2 className="text-sm font-semibold">
      {skill.files.length === 1 ? "1 file" : `${skill.files.length} files`}
    </h2>
    <ul className="flex flex-col gap-0.5">
      {skill.files.map((file) => {
        // The SKILL.md of the folder may be written `skill.md`; the link is to the file as GitHub has it.
        const onGithub = file.path === "SKILL.md" ? skill.skillMdFile : file.path;

        return (
          <li key={file.path} className="flex items-baseline justify-between gap-3 text-sm">
            <a
              href={githubFileUrl(
                skill.repo,
                skill.commit,
                skill.path === "" ? onGithub : `${skill.path}/${onGithub}`,
              )}
              target="_blank"
              rel="noreferrer noopener"
              className="min-w-0 truncate font-mono text-xs hover:underline"
              title={`${file.path} on GitHub`}
            >
              {file.path}
            </a>
            {file.size !== undefined && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {byteSize(file.size)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
    {skill.refused !== undefined && (
      <p role="status" className="text-xs text-amber-600 dark:text-amber-400">
        An install would refuse this skill: {skill.refused}.
      </p>
    )}
  </section>
);

/** What the Skill is: its description, installs, badges, the commit read, Install, where it is installed, SKILL.md and its files. */
const SkillDetails = ({ skill, page }: { skill: SkillView; page: SkillViewKey }) => {
  const pick = useInstallPicker();
  const badges = directoryBadges(skill.installed);
  const body = skillMdBody(skill.skillMd);
  const folder = skill.path === "" ? "" : `${skill.path}/`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="truncate font-mono text-base font-semibold">{skill.name}</h2>
            <p className="text-sm break-words text-muted-foreground">{skill.description}</p>
          </div>
          <Button
            type="button"
            className="shrink-0"
            onClick={() => {
              pick(skillToInstall(skill, page.ref));
            }}
          >
            <Download />
            Install
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {skill.installs !== undefined && (
            <span title={`${skill.installs.toLocaleString("en-US")} installs`}>
              {compactCount(skill.installs)} installs
            </span>
          )}
          {badges.length > 0 && (
            <ul aria-label="Installed here" className="flex flex-wrap gap-x-2">
              {badges.map((badge) => (
                <li
                  key={badge}
                  className={
                    badge === "update available" ? "text-amber-600 dark:text-amber-400" : ""
                  }
                >
                  {badge}
                </li>
              ))}
            </ul>
          )}
          <span>
            Read at{" "}
            <a
              href={`https://github.com/${skill.repo}/commit/${skill.commit}`}
              target="_blank"
              rel="noreferrer noopener"
              className="font-mono underline underline-offset-2 hover:text-foreground"
              title={skill.commit}
            >
              {skill.commit.slice(0, 7)}
            </a>
            {skill.ref === null ? " (the default branch)" : ` (${skill.ref})`}
          </span>
          <a
            href={githubFolderUrl(skill.repo, skill.commit, skill.path)}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center gap-1 hover:text-foreground hover:underline"
          >
            {skill.path === "" ? "Repo root" : skill.path}
            <ExternalLink className="size-3" />
          </a>
        </div>
      </header>
      <InstalledHere skill={skill} />
      <section aria-label="SKILL.md" className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">SKILL.md</h2>
        <div className="rounded-lg border p-4">
          {body.trim() === "" ? (
            <p className="text-sm text-muted-foreground">
              SKILL.md has no text below its frontmatter.
            </p>
          ) : (
            <StaticMarkdown
              text={body}
              base={`https://github.com/${skill.repo}/blob/${skill.commit}/${folder}`}
            />
          )}
        </div>
      </section>
      <Files skill={skill} />
      {skill.installs !== undefined && <Credit />}
    </div>
  );
};

/** The Skill, or why there is none, or the Skills its name could mean, or that it is being read. */
const SkillBody = ({ page }: { page: SkillViewKey }) => {
  const answer = useAtomValue(skillViewAtom(page));
  const refresh = useAtomRefresh(skillViewAtom(page));
  const viewed = answer.pipe(AsyncResult.value, Option.getOrNull);
  const failure = skillRepoFailureOf(answer);

  if (viewed === null) {
    return failure === null ? (
      <p className="text-sm text-muted-foreground">
        Reading {page.skill} from {page.owner}/{page.repo} on GitHub…
      </p>
    ) : (
      <SkillProblem failure={failure} page={page} retry={refresh} />
    );
  }

  return viewed.status === "ambiguous" ? (
    <Candidates page={page} candidates={viewed.candidates} />
  ) : (
    <SkillDetails skill={viewed.skill} page={page} />
  );
};

/** The Skill's page: the breadcrumb (the owner and the repo link to their pages), the ref shown, and what the Skill is. */
export const SkillPage = ({
  owner,
  repo,
  skill,
}: {
  owner: string;
  repo: string;
  skill: string;
}) => {
  const { ref, path } = useAtomValue(skillRepoParamsAtom);
  const page = skillViewKey(owner, repo, skill, path, ref);

  return (
    <SkillsFrame title={skill}>
      <div className="-mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-1.5">
          <InAppLink href={SKILLS_PATH} className="hover:text-foreground hover:underline">
            Skills
          </InAppLink>
          <span aria-hidden>/</span>
          <InAppLink href={skillOwnerPath(owner)} className="hover:text-foreground hover:underline">
            {owner}
          </InAppLink>
          <span aria-hidden>/</span>
          <InAppLink
            href={skillRepoPath(owner, repo, ref)}
            className="hover:text-foreground hover:underline"
          >
            {repo}
          </InAppLink>
          <span aria-hidden>/</span>
          <span className="truncate text-foreground">{skill}</span>
        </nav>
        {ref !== undefined && (
          <span className="rounded-md border px-1.5 py-0.5 font-mono text-xs" title="The ref shown">
            {ref}
          </span>
        )}
      </div>
      <SkillBody key={`${owner}/${repo}/${skill}@${ref ?? ""}#${path ?? ""}`} page={page} />
    </SkillsFrame>
  );
};
