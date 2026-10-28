// @effect-diagnostics preferEffectArray:off -- JSX lists of tabs are native arrays.

// The Skills section of the Settings page (`/settings/:scope/skills`; docs/architecture/client-and-protocol.md → Settings
// page) at the Scope the page shows (`SettingsScope`): its heading, the search bar above the tabs (`?q=`), the tab bar
// (Installed · All time · Trending (24h) · Hot, the tab in `?tab=`), and the tab shown, or the search's results in its
// place while a query is set. The Installed tab holds the Scope's own Skill management (`skills-installed.tsx`); the other
// tabs are the Skill directory's lists (`skills-directory.tsx`), and a row's Install opens the install confirm
// (`skills-install-dialog.tsx`). The Skill directory's pages below the section (an owner's `skills-owner.tsx`, a repo's
// `skills-repo.tsx`, a Skill's `skills-skill.tsx`) render in `SkillDirectoryFrame`. The page shell supplies the scroller,
// the breadcrumb and the Scope.

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import type { ReactNode } from "react";
import { InAppLink } from "../in-app-link.tsx";
import { cn } from "../lib/utils.ts";
import { SKILLS_TABS, skillsParamsAtom, skillsPath, type SkillsTab } from "../router.ts";
import { DirectoryTab, SearchResults, SkillsSearchBar } from "../skills-directory.tsx";
import { InstalledTab } from "../skills-installed.tsx";
import { InstallSkillsDialog } from "../skills-install-dialog.tsx";
import { skillsTabAtom } from "../skills-state.ts";
import { SettingsSection } from "./parts.tsx";
import { useSettingsScope } from "./scope.tsx";

/** Each tab's name, as the tab bar shows it. */
const TAB_LABELS: Readonly<Record<SkillsTab, string>> = {
  installed: "Installed",
  "all-time": "All time",
  trending: "Trending (24h)",
  hot: "Hot",
};

/**
 * The frame of the Skill directory's pages below the Skills section (an owner's, a repo's, a Skill's): the page's title
 * as the heading, and what the page shows. It has no scroller and no back button, as the Settings page's shell has
 * them; it mounts the install confirm (`skills-install-dialog.tsx`) that every page of the Skills section shares.
 */
export const SkillDirectoryFrame = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-6 pb-10 md:px-8 md:pt-8">
    <h1 className="truncate text-lg font-semibold">{title}</h1>
    {children}
    <InstallSkillsDialog />
  </div>
);

/** The tab bar: each tab a link to the section at the Scope with that tab, keeping the search. */
const SkillsTabBar = ({ shown, query }: { shown: SkillsTab | null; query: string }) => {
  const scope = useSettingsScope();

  return (
    <nav aria-label="Skills lists" className="-mb-2 flex gap-1 overflow-x-auto border-b">
      {SKILLS_TABS.map((tab) => (
        <InAppLink
          key={tab}
          href={skillsPath(scope, { tab, query })}
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
};

/** What a tab shows: the Installed tab, or one of the Skill directory's lists. */
const TabContent = ({ tab }: { tab: SkillsTab | null }) => {
  if (tab === null) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return tab === "installed" ? <InstalledTab /> : <DirectoryTab view={tab} />;
};

/**
 * The Skills section at the Scope the page shows: the tab `?tab=` names (else Installed when the Scope keeps any Skill,
 * otherwise All time), or the results of the search while `?q=` is set.
 */
export const SkillsSettingsSection = () => {
  const scope = useSettingsScope();
  const shown = useAtomValue(skillsTabAtom(scope));
  const params = useAtomValue(skillsParamsAtom);

  return (
    <SettingsSection
      title="Skills"
      description={
        scope === GLOBAL_SCOPE
          ? "Skills kept Global are served read-only in each environment's workspaces, unless the environment keeps its own of the same name."
          : "This environment's own skills, served read-only in its workspaces. They win over the Global ones of the same name."
      }
    >
      <div className="flex flex-col gap-6">
        <SkillsSearchBar />
        <SkillsTabBar shown={shown} query={params.query} />
        {params.query.trim() === "" ? (
          <TabContent tab={shown} />
        ) : (
          <SearchResults query={params.query} />
        )}
      </div>
      <InstallSkillsDialog />
    </SettingsSection>
  );
};
