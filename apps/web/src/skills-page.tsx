// @effect-diagnostics preferEffectArray:off -- JSX lists of tabs are native arrays.

// The Skills page (`/skills`; docs/architecture/client-and-protocol.md → Skills page): its header, the search bar above the
// tabs (`?q=`), the tab bar (Installed · All time · Trending (24h) · Hot, the tab in `?tab=`), and the tab shown, or the
// search's results in its place while a query is set. The Installed tab holds the owner's Skill management
// (`skills-installed.tsx`); the other tabs are the Skill directory's lists (`skills-directory.tsx`), and a row's Install
// opens the target picker (`skills-install-dialog.tsx`). The pages below `/skills` (an owner's, a repo's, a Skill's) are
// still to come and say so.

import { useAtomValue } from "@effect/atom-react";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { InAppLink } from "./in-app-link.tsx";
import { cn } from "./lib/utils.ts";
import {
  navigate,
  SKILLS_PATH,
  SKILLS_TABS,
  skillsParamsAtom,
  skillsPath,
  type SkillsParams,
  type SkillsTab,
} from "./router.ts";
import { DirectoryTab, SearchResults, SkillsSearchBar } from "./skills-directory.tsx";
import { InstalledTab } from "./skills-installed.tsx";
import { InstallSkillsDialog } from "./skills-install-dialog.tsx";
import { skillsTabAtom } from "./skills-state.ts";

/** Each tab's name, as the tab bar shows it. */
const TAB_LABELS: Readonly<Record<SkillsTab, string>> = {
  installed: "Installed",
  "all-time": "All time",
  trending: "Trending (24h)",
  hot: "Hot",
};

/**
 * The page's frame: the back button a phone needs, the title, and what the page shows, and the install target picker (`skills-install-dialog.tsx`)
 * that every page of `/skills` shares.
 */
export const SkillsFrame = ({ title, children }: { title: string; children: ReactNode }) => (
  // `relative` makes the scroller the containing block of the `sr-only` labels in the forms, as on the Environments page.
  <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => {
            navigate("/");
          }}
          aria-label="Back to sessions"
          className="-ml-2 rounded-md p-2 hover:bg-accent md:hidden"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h1 className="truncate text-lg font-semibold">{title}</h1>
      </div>
      {children}
    </div>
    <InstallSkillsDialog />
  </div>
);

/**
 * The tab bar: each tab a link to the page with that tab, keeping the search. The Environment filter belongs to the
 * Installed tab, so a link to another tab drops it.
 */
const SkillsTabBar = ({ shown, params }: { shown: SkillsTab | null; params: SkillsParams }) => (
  <nav aria-label="Skills lists" className="-mb-2 flex gap-1 overflow-x-auto border-b">
    {SKILLS_TABS.map((tab) => (
      <InAppLink
        key={tab}
        href={skillsPath({
          tab,
          query: params.query,
          environment: tab === "installed" ? params.environment : undefined,
        })}
        aria-current={tab === shown ? "page" : undefined}
        className={cn(
          "-mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground",
          tab === shown && "border-foreground font-medium text-foreground",
        )}
      >
        {TAB_LABELS[tab]}
      </InAppLink>
    ))}
  </nav>
);

/**
 * The Skills page's shell: the title, the search bar (`search`, above the tabs), the tab bar (`shown` is the tab that is
 * current, none while the default is being worked out), and the tab shown (`children`).
 */
export const SkillsShell = ({
  search,
  shown,
  params,
  children,
}: {
  search?: ReactNode;
  shown: SkillsTab | null;
  params: SkillsParams;
  children: ReactNode;
}) => (
  <SkillsFrame title="Skills">
    {search}
    <SkillsTabBar shown={shown} params={params} />
    {children}
  </SkillsFrame>
);

/** What a tab shows: the Installed tab, or one of the Skill directory's lists. */
const TabContent = ({ tab }: { tab: SkillsTab | null }) => {
  if (tab === null) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return tab === "installed" ? <InstalledTab /> : <DirectoryTab view={tab} />;
};

/**
 * The Skills page: the tab `?tab=` names (else Installed when any Skill is installed, otherwise All time), or the results
 * of the search while `?q=` is set.
 */
export const SkillsPage = () => {
  const shown = useAtomValue(skillsTabAtom);
  const params = useAtomValue(skillsParamsAtom);

  return (
    <SkillsShell search={<SkillsSearchBar />} shown={shown} params={params}>
      {params.query.trim() === "" ? (
        <TabContent tab={shown} />
      ) : (
        <SearchResults query={params.query} />
      )}
    </SkillsShell>
  );
};

/** A page below `/skills` (an owner's, a repo's or a Skill's, named by `path`), until it comes. */
export const SkillDirectoryPage = ({ path }: { path: string }) => (
  <SkillsFrame title={path}>
    <p className="text-sm text-muted-foreground">
      This page is coming soon.{" "}
      <InAppLink href={SKILLS_PATH} className="underline underline-offset-2 hover:text-foreground">
        Back to skills
      </InAppLink>
    </p>
  </SkillsFrame>
);
