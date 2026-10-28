// The Settings page (docs/architecture/client-and-protocol.md → Settings page; GLOSSARY.md → Settings page): the
// breadcrumb with the Scope picker, and the section the path names at its Scope, which every part inside reads from
// `SettingsScope`. The list of sections is the sidebar's (`nav.tsx`): a phone shows it alone at `/settings/:scope`,
// and a wide screen goes on to the Scope's first section. A section the Scope does not have goes to its first section
// too, and an Environment that is not listed says so, with a way back to Global.

import { type EnvironmentRecord, GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { useEffect } from "react";
import { environmentListAtom, environmentsErrorAtom } from "../environments-state.ts";
import { InAppLink } from "../in-app-link.tsx";
import { redirect, settingsPath, type SettingsView } from "../router.ts";
import { SkillOwnerPage } from "../skills-owner.tsx";
import { SkillRepoPage } from "../skills-repo.tsx";
import { SkillPage } from "../skills-skill.tsx";
import { AgentChangesSettingsSection } from "./agent-changes.tsx";
import { SettingsBreadcrumb } from "./breadcrumb.tsx";
import { ContainerSection, EnvironmentLimitsSection, SetupSection } from "./container.tsx";
import { EnvironmentListSection, EnvironmentSection } from "./environments.tsx";
import {
  GeneralSection,
  GlobalLimitsSection,
  InstructionsSection,
  ModelsSection,
  ToolsSection,
} from "./global-settings.tsx";
import { NotificationsSection } from "./notifications.tsx";
import { Pending } from "./parts.tsx";
import { SettingsScope } from "./scope.tsx";
import { SecretsSection } from "./secrets.tsx";
import { isSectionAt, leadOnPath, type SectionSlug } from "./sections.ts";
import { SkillsSettingsSection } from "./skills.tsx";
import { VariablesSection } from "./variables.tsx";
import { WorkspacesSection } from "./workspaces.tsx";

/** The width from which the list of sections and a section show side by side (Tailwind's `md`). */
const WIDE = "(min-width: 48rem)";

/** Global's section `slug`. */
const GlobalSection = ({ slug }: { slug: SectionSlug }) => {
  switch (slug) {
    case "general":
      return <GeneralSection />;
    case "instructions":
      return <InstructionsSection />;
    case "models":
      return <ModelsSection />;
    case "tools":
      return <ToolsSection />;
    case "limits":
      return <GlobalLimitsSection />;
    case "environments":
      return <EnvironmentListSection />;
    case "notifications":
      return <NotificationsSection />;
    default:
      return <SharedSection slug={slug} scope={GLOBAL_SCOPE} />;
  }
};

/** Environment `environment`'s section `slug`. */
const EnvironmentScopeSection = ({
  slug,
  environment,
}: {
  slug: SectionSlug;
  environment: EnvironmentRecord;
}) => {
  switch (slug) {
    case "environments":
      return <EnvironmentSection environment={environment} />;
    case "container":
      return <ContainerSection scope={environment.id} />;
    case "setup":
      return <SetupSection scope={environment.id} />;
    case "limits":
      return <EnvironmentLimitsSection scope={environment.id} />;
    default:
      return <SharedSection slug={slug} scope={environment.id} />;
  }
};

/** A section both Scopes have, shown at Scope `scope`. */
const SharedSection = ({ slug, scope }: { slug: SectionSlug; scope: string }) => {
  switch (slug) {
    case "workspaces":
      return <WorkspacesSection scope={scope} />;
    case "skills":
      return <SkillsSettingsSection />;
    case "variables":
      return <VariablesSection scope={scope} />;
    case "secrets":
      return <SecretsSection scope={scope} />;
    case "agent-changes":
      return <AgentChangesSettingsSection scope={scope} />;
    default:
      return null;
  }
};

/** What `view` shows at Scope `scope`, the Environment being `environment` (null at Global). */
const ViewBody = ({
  scope,
  view,
  environment,
}: {
  scope: string;
  view: SettingsView;
  environment: EnvironmentRecord | null;
}) => {
  switch (view.kind) {
    case "index":
      return null;
    case "section":
      if (!isSectionAt(scope, view.section)) return null;

      return environment === null ? (
        <GlobalSection slug={view.section} />
      ) : (
        <EnvironmentScopeSection slug={view.section} environment={environment} />
      );
    case "skillOwner":
      return <SkillOwnerPage owner={view.owner} />;
    case "skillRepo":
      return <SkillRepoPage owner={view.owner} repo={view.repo} />;
    case "skill":
      return <SkillPage owner={view.owner} repo={view.repo} skill={view.skill} />;
  }
};

/** What an Environment's Scope shows while its id names none listed. */
const NotFound = ({ scope }: { scope: string }) => (
  <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pt-6 md:px-8 md:pt-8">
    <h1 className="text-lg font-semibold">Environment not found</h1>
    <p className="text-sm text-muted-foreground">
      No environment has the id <span className="font-mono text-foreground">{scope}</span>. It may
      have been deleted.
    </p>
    <InAppLink
      href={settingsPath(GLOBAL_SCOPE)}
      className="self-start text-sm underline underline-offset-2 hover:text-muted-foreground"
    >
      Go to Global settings
    </InAppLink>
  </div>
);

/** Replace the path, where the view leads elsewhere: the list on a wide screen, or a section the Scope lacks. */
const useLeadOn = (scope: string, view: SettingsView) => {
  useEffect(() => {
    const path = leadOnPath(scope, view, window.matchMedia(WIDE).matches);

    if (path !== null) redirect(path);
  }, [scope, view]);
};

/** The Settings page at Scope `scope` (`*` for Global, or an Environment's id), showing `view`. */
export const SettingsPage = ({ scope, view }: { scope: string; view: SettingsView }) => {
  const environments = useAtomValue(environmentListAtom);
  const listError = useAtomValue(environmentsErrorAtom);
  const atGlobal = scope === GLOBAL_SCOPE;

  const environment = Arr.findFirst(environments ?? [], (known) => known.id === scope).pipe(
    Option.getOrNull,
  );

  useLeadOn(scope, view);

  const body = atGlobal ? (
    <ViewBody scope={scope} view={view} environment={null} />
  ) : environments === null ? (
    <Pending problem={listError} className="px-4 pt-6 md:px-8" />
  ) : environment === null ? (
    <NotFound scope={scope} />
  ) : (
    <ViewBody scope={scope} view={view} environment={environment} />
  );

  return (
    <SettingsScope.Provider value={scope}>
      <SettingsBreadcrumb scope={scope} view={view} />
      {/* `relative` makes the scroller the containing block of the `sr-only` labels in the forms. */}
      <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain">{body}</div>
    </SettingsScope.Provider>
  );
};
