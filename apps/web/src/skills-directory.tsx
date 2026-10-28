// @effect-diagnostics preferEffectArray:off globalTimers:off -- JSX lists of rows and pages are native arrays; the search waits a moment after the last keystroke, timed by a React effect.

// The Skills page's Skill directory (ADR-0026, GLOSSARY.md → Skill directory, docs/architecture/client-and-protocol.md →
// Skills page): the search bar above the tabs, the All time, Trending (24h) and Hot lists that skills.sh ranks, and the
// results of a search that replace them. Each row shows its rank, name, source, installs (compact) and where the Skill is
// installed here, links to its pages, and has Install, which opens the target picker. skills.sh being down is a plain
// error here; the Installed tab does not depend on it.

import type { DirectorySkill, SkillDirectoryView } from "@cloudpid/protocol";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Download, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { compactCount } from "./format.ts";
import { InAppLink } from "./in-app-link.tsx";
import { failureOf } from "./registry.ts";
import {
  replaceSearch,
  skillPagePath,
  skillRepoPath,
  SKILLS_PATH,
  skillsParamsAtom,
  skillsPath,
} from "./router.ts";
import { useInstallPicker } from "./skills-install-dialog.tsx";
import {
  skillDirectoryPageAtom,
  skillDirectoryPageKey,
  skillDirectoryPagesAtom,
  skillDirectorySearchAtom,
} from "./skills-state.ts";
import { changeText, directoryBadges, githubSource } from "./skills.ts";

/** The fewest characters skills.sh searches for. */
const MIN_QUERY_LENGTH = 2;

/** How long the search bar waits after a keystroke before it searches. */
const TYPING_PAUSE_MS = 300;

/** The credit for the data, a small link and nothing more: no Vercel branding. */
const Credit = () => (
  <p className="text-xs text-muted-foreground">
    <a
      href="https://skills.sh"
      target="_blank"
      rel="noreferrer noopener"
      className="underline underline-offset-2 hover:text-foreground"
    >
      Data from skills.sh
    </a>
  </p>
);

/**
 * The search bar above the tabs: what is typed is `?q=` in the URL a moment after the last keystroke (replacing the
 * history entry, so typing leaves no trail of pages), and the results replace the list while it is not empty. Clearing it
 * brings the list back.
 */
export const SkillsSearchBar = () => {
  const params = useAtomValue(skillsParamsAtom);
  const [typed, setTyped] = useState(params.query);

  // Back and forward, or a link, change the query from outside.
  useEffect(() => {
    setTyped(params.query);
  }, [params.query]);

  useEffect(() => {
    if (typed === params.query) return undefined;

    const timer = setTimeout(() => {
      replaceSearch(skillsPath({ ...params, query: typed }).slice(SKILLS_PATH.length));
    }, TYPING_PAUSE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [typed, params]);

  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        replaceSearch(skillsPath({ ...params, query: typed }).slice(SKILLS_PATH.length));
      }}
      className="relative"
    >
      <label htmlFor="skills-search" className="sr-only">
        Search skills
      </label>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id="skills-search"
        type="search"
        value={typed}
        onChange={(event) => {
          setTyped(event.target.value);
        }}
        placeholder="Search skills on skills.sh"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        data-1p-ignore
        className="w-full pl-9"
      />
    </form>
  );
};

/**
 * One row of the Skill directory: its rank (on a list, not a search), the name linking to the Skill's page, the source
 * linking to its repo's page, its installs, the Hot list's change, where it is installed here, and Install. A phone shows
 * the name, source and installs.
 */
const DirectoryRow = ({ skill, rank }: { skill: DirectorySkill; rank: number | null }) => {
  const pick = useInstallPicker();
  const github = githubSource(skill.source);
  const badges = directoryBadges(skill.installed);

  return (
    <li className="flex items-center gap-3 py-2.5">
      {rank !== null && (
        <span className="hidden w-10 shrink-0 text-right text-sm text-muted-foreground tabular-nums sm:block">
          {rank}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {github === null ? (
          <span className="truncate font-mono text-sm font-medium">{skill.name}</span>
        ) : (
          <InAppLink
            href={skillPagePath(github.owner, github.repo, skill.skillId)}
            className="truncate font-mono text-sm font-medium hover:underline"
          >
            {skill.name}
          </InAppLink>
        )}
        {github === null ? (
          <span className="truncate font-mono text-xs text-muted-foreground">{skill.source}</span>
        ) : (
          <InAppLink
            href={skillRepoPath(github.owner, github.repo)}
            className="truncate font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {skill.source}
          </InAppLink>
        )}
        {badges.length > 0 && (
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
        )}
      </div>
      {skill.change !== undefined && (
        <span
          className="hidden shrink-0 text-sm tabular-nums sm:block"
          title={`${skill.installsYesterday ?? 0} installs yesterday`}
        >
          {changeText(skill.change)}
        </span>
      )}
      <span
        className="w-14 shrink-0 text-right text-sm text-muted-foreground tabular-nums"
        title={`${skill.installs.toLocaleString("en-US")} installs`}
      >
        {compactCount(skill.installs)}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={github === null}
        title={github === null ? "Only skills from a GitHub repo can be installed" : undefined}
        aria-label={`Install ${skill.name} from ${skill.source}`}
        onClick={() => {
          pick({ source: skill.source, skills: [skill.skillId] });
        }}
      >
        <Download />
        Install
      </Button>
    </li>
  );
};

/** Why a list or a search could not load, said plainly, with a way to ask again; the Installed tab is not affected. */
const DirectoryError = ({ message, retry }: { message: string; retry: () => void }) => (
  <div role="alert" className="flex flex-col items-start gap-2 text-sm">
    <p className="text-destructive">{message}</p>
    <p className="text-muted-foreground">
      The skills.sh list is not available right now. Skills you have installed are not affected.
    </p>
    <Button type="button" size="sm" variant="outline" onClick={retry}>
      Try again
    </Button>
  </div>
);

/** The head of the columns, for a list (a search has no rank). */
const ListHead = ({ view }: { view: SkillDirectoryView }) => (
  <div className="hidden items-center gap-3 border-b pb-1 text-xs text-muted-foreground sm:flex">
    <span className="w-10 shrink-0 text-right">#</span>
    <span className="flex-1">Skill</span>
    {view === "hot" && <span className="shrink-0">Change</span>}
    <span className="w-14 shrink-0 text-right">Installs</span>
    <span className="w-[5.5rem] shrink-0" />
  </div>
);

/** One page of a list: its rows from rank `first`, or why it did not load, or that it does. */
const DirectoryPage = ({ view, page }: { view: SkillDirectoryView; page: number }) => {
  const answer = useAtomValue(skillDirectoryPageAtom(skillDirectoryPageKey(view, page)));
  const refresh = useAtomRefresh(skillDirectoryPageAtom(skillDirectoryPageKey(view, page)));
  const rows = answer.pipe(AsyncResult.value, Option.getOrNull);
  const problem = failureOf(answer);

  if (rows === null) {
    return problem === null ? (
      <p className="py-2 text-sm text-muted-foreground">Loading…</p>
    ) : (
      <DirectoryError message={problem} retry={refresh} />
    );
  }

  return (
    <>
      {rows.skills.map((skill, at) => (
        <DirectoryRow
          key={`${skill.source}/${skill.skillId}`}
          skill={skill}
          rank={page * 200 + at + 1}
        />
      ))}
    </>
  );
};

/**
 * A Skill directory list (All time, Trending (24h) or Hot): its pages so far, 200 rows each, and Load more while the
 * last one says more follow.
 */
export const DirectoryTab = ({ view }: { view: SkillDirectoryView }) => {
  const [pages, setPages] = useAtom(skillDirectoryPagesAtom(view));

  const last = useAtomValue(skillDirectoryPageAtom(skillDirectoryPageKey(view, pages - 1)));

  const hasMore = last.pipe(
    AsyncResult.value,
    Option.exists((rows) => rows.hasMore),
  );

  const loading = last.waiting && AsyncResult.value(last).pipe(Option.isNone);

  return (
    <div className="flex flex-col gap-3">
      <ListHead view={view} />
      <ul aria-label={view} className="flex flex-col divide-y">
        {Array.from({ length: pages }, (_, page) => (
          <DirectoryPage key={page} view={view} page={page} />
        ))}
      </ul>
      {hasMore && (
        <Button
          type="button"
          variant="outline"
          className="self-center"
          disabled={loading}
          onClick={() => {
            setPages((now) => now + 1);
          }}
        >
          Load more
        </Button>
      )}
      <Credit />
    </div>
  );
};

/** What skills.sh found for `query`, a query it searches for: up to 200 fuzzy results, with no rank. */
const SearchAnswer = ({ query }: { query: string }) => {
  const answer = useAtomValue(skillDirectorySearchAtom(query));
  const refresh = useAtomRefresh(skillDirectorySearchAtom(query));
  const found = answer.pipe(AsyncResult.value, Option.getOrNull);
  const problem = failureOf(answer);

  if (found === null) {
    return problem === null ? (
      <p className="text-sm text-muted-foreground">Searching…</p>
    ) : (
      <DirectoryError message={problem} retry={refresh} />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {found.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing found for “{query}”.</p>
      ) : (
        <ul aria-label={`Results for ${query}`} className="flex flex-col divide-y">
          {found.map((skill) => (
            <DirectoryRow key={`${skill.source}/${skill.skillId}`} skill={skill} rank={null} />
          ))}
        </ul>
      )}
      <Credit />
    </div>
  );
};

/**
 * The search's results in place of the tab's list. A query shorter than skills.sh searches for says so instead of asking.
 */
export const SearchResults = ({ query }: { query: string }) => {
  const trimmed = query.trim();

  return trimmed.length < MIN_QUERY_LENGTH ? (
    <p className="text-sm text-muted-foreground">
      Type at least {MIN_QUERY_LENGTH} characters to search skills.sh.
    </p>
  ) : (
    <SearchAnswer query={trimmed} />
  );
};
