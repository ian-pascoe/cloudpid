// @effect-diagnostics preferEffectArray:off -- JSX lists of rows are native arrays.

// The owner page (`/skills/:owner`; ADR-0026, docs/architecture/client-and-protocol.md → Skills page): the repos the Skill
// directory (skills.sh) lists Skills of for a GitHub user or organization, each with its Skills and installs and opening
// its repo page, where GitHub gives the full list. The Registry builds the list from skills.sh's search, which is fuzzy and
// answers at most 200 results, so the page says the list may be incomplete. "Open a repo" opens any repo of the owner, for
// those skills.sh does not list. An owner the directory lists nothing of says so and still offers it, and skills.sh
// failing is a plain error with the field still there.

import { type OwnerRepo, SKILL_SEARCH_LIMIT, type SkillOwnerListing } from "@cloudpid/protocol";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { compactCount } from "./format.ts";
import { InAppLink } from "./in-app-link.tsx";
import { failureOf } from "./registry.ts";
import { navigate, skillRepoPath, SKILLS_PATH } from "./router.ts";
import { Credit, DirectoryError } from "./skills-directory.tsx";
import { SkillsFrame } from "./skills-page.tsx";
import { openRepoPath, skillOwnerAtom } from "./skills-owner-state.ts";

/**
 * "Open a repo": the repo's name (or `owner/repo`) opens its page, for a repo skills.sh does not list. Whether GitHub has the
 * repo is for its page to say.
 */
const OpenRepo = ({ owner }: { owner: string }) => {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <form
      aria-label="Open a repo"
      onSubmit={(event) => {
        event.preventDefault();

        const opened = openRepoPath(owner, typed);

        if (opened.ok) navigate(opened.path);
        else setProblem(opened.message);
      }}
      className="flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-2">
        <label htmlFor="skills-open-repo" className="sr-only">
          Repo of {owner}
        </label>
        <span className="font-mono text-sm text-muted-foreground">{owner}/</span>
        <Input
          id="skills-open-repo"
          value={typed}
          placeholder="repo"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={problem === null ? undefined : true}
          className="min-w-0 flex-1 font-mono"
          onChange={(event) => {
            setTyped(event.target.value);
            setProblem(null);
          }}
        />
        <Button type="submit" size="sm" variant="outline">
          Open a repo
        </Button>
      </div>
      {problem === null ? (
        <p className="text-xs text-muted-foreground">
          For a repo skills.sh does not list, or a private one the GitHub App can read.
        </p>
      ) : (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </form>
  );
};

/** One repo of the owner: its name linking to its repo page, how many Skills the directory found in it, and their installs. */
const OwnerRepoRow = ({ owner, repo }: { owner: string; repo: OwnerRepo }) => (
  <li className="flex items-center gap-3 py-2.5">
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <InAppLink
        href={skillRepoPath(owner, repo.repo)}
        className="truncate font-mono text-sm font-medium hover:underline"
      >
        {repo.repo}
      </InAppLink>
      <span className="text-xs text-muted-foreground">
        {repo.skills === 1 ? "1 skill" : `${repo.skills} skills`}
      </span>
    </div>
    <span
      className="w-14 shrink-0 text-right text-sm text-muted-foreground tabular-nums"
      title={`${repo.installs.toLocaleString("en-US")} installs`}
    >
      {compactCount(repo.installs)}
    </span>
  </li>
);

/** What the owner's repos are built from, said honestly: a fuzzy search of at most 200 results. */
const SearchLimit = ({ listing }: { listing: SkillOwnerListing }) => (
  <p className="text-xs text-muted-foreground">
    {listing.capped
      ? `skills.sh's search hit its limit of ${SKILL_SEARCH_LIMIT} results, so repos and Skills of ${listing.owner} are probably missing here. `
      : `This list comes from skills.sh's search, which is fuzzy and answers at most ${SKILL_SEARCH_LIMIT} results, so it may not show every repo or Skill. `}
    A repo's page lists what GitHub has in it.
  </p>
);

/** The owner's repos from the Skill directory, or why there are none, or that they are being asked for. */
const OwnerBody = ({ owner }: { owner: string }) => {
  const answer = useAtomValue(skillOwnerAtom(owner));
  const refresh = useAtomRefresh(skillOwnerAtom(owner));
  const listing = answer.pipe(AsyncResult.value, Option.getOrNull);
  const problem = failureOf(answer);

  if (listing === null) {
    return problem === null ? (
      <p className="text-sm text-muted-foreground">Asking skills.sh about {owner}…</p>
    ) : (
      <DirectoryError message={problem} retry={refresh} />
    );
  }

  if (listing.repos.length === 0) {
    return (
      <div className="flex flex-col gap-1 text-sm">
        <p role="status" className="font-medium">
          {owner} is not in the Skill directory.
        </p>
        <p className="text-muted-foreground">
          skills.sh lists no Skills of {owner}. {owner} may still have some on GitHub: open one of
          its repos by name.
        </p>
        <Credit />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <ul aria-label={`Repos of ${owner}`} className="flex flex-col divide-y">
        {listing.repos.map((repo) => (
          <OwnerRepoRow key={repo.repo} owner={owner} repo={repo} />
        ))}
      </ul>
      <SearchLimit listing={listing} />
      <Credit />
    </div>
  );
};

/**
 * The owner page: the breadcrumb back to the Skills page, a link to the owner on GitHub, "Open a repo", and the repos the
 * Skill directory lists of the owner.
 */
export const SkillOwnerPage = ({ owner }: { owner: string }) => (
  <SkillsFrame title={owner}>
    <div className="-mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
        <InAppLink href={SKILLS_PATH} className="hover:text-foreground hover:underline">
          Skills
        </InAppLink>
        <span aria-hidden>/</span>
        <span className="text-foreground">{owner}</span>
      </nav>
      <a
        href={`https://github.com/${encodeURIComponent(owner)}`}
        target="_blank"
        rel="noreferrer noopener"
        className="ml-auto flex items-center gap-1 text-xs hover:text-foreground hover:underline"
      >
        On GitHub
        <ExternalLink className="size-3" />
      </a>
    </div>
    <OpenRepo key={`open:${owner}`} owner={owner} />
    <OwnerBody key={`repos:${owner}`} owner={owner} />
  </SkillsFrame>
);
