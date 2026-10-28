// The Settings page's header (docs/architecture/client-and-protocol.md → Settings page): the breadcrumb Settings /
// Scope / section, the Scope being its picker. A phone shows a back arrow to the Scope's list of sections in place of
// "Settings", since the list and the section take turns there.

import { ArrowLeft } from "lucide-react";
import { InAppLink } from "../in-app-link.tsx";
import { SETTINGS_PATH, settingsPath, type SettingsView } from "../router.ts";
import { currentSection } from "./nav.tsx";
import { ScopePicker } from "./scope-picker.tsx";
import { sectionLabel } from "./sections.ts";

const Separator = ({ className }: { className?: string }) => (
  <li aria-hidden className={className ?? "text-muted-foreground"}>
    /
  </li>
);

export const SettingsBreadcrumb = ({ scope, view }: { scope: string; view: SettingsView }) => {
  const section = currentSection(scope, view);
  // A Skill directory page is below the Skills section, which its own breadcrumb goes on from.
  const below = view.kind !== "section" && view.kind !== "index";

  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2 md:px-4">
      <InAppLink
        href={settingsPath(scope)}
        aria-label="All sections"
        title="All sections"
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden />
      </InAppLink>
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex min-w-0 items-center gap-1 text-sm">
          <li className="hidden md:block">
            <InAppLink
              href={SETTINGS_PATH}
              className="rounded-sm px-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              Settings
            </InAppLink>
          </li>
          <Separator className="hidden text-muted-foreground md:block" />
          <li className="min-w-0">
            <ScopePicker scope={scope} view={view} />
          </li>
          {section !== null && (
            <>
              <Separator />
              <li className="min-w-0 truncate px-1">
                {below ? (
                  <InAppLink
                    href={settingsPath(scope, section)}
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {sectionLabel(section, scope)}
                  </InAppLink>
                ) : (
                  <span aria-current="page" className="font-medium">
                    {sectionLabel(section, scope)}
                  </span>
                )}
              </li>
            </>
          )}
        </ol>
      </nav>
    </header>
  );
};
