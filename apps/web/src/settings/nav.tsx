// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- JSX lists of sections are native arrays; a lookup by Scope and view, not a combinator.

// The Settings page's navigation, in the sidebar's place while the page is shown (docs/architecture/client-and-protocol.md
// → Settings page): the Scope (its picker on a phone, where the breadcrumb is not shown with the list), then the
// Scope's sections, each with its icon and a dot while it has unsaved changes. Collapsed, the rail shows the sections'
// icons alone.

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import { environmentListAtom } from "../environments-state.ts";
import { InAppLink } from "../in-app-link.tsx";
import { cn } from "../lib/utils.ts";
import { settingsPath, type SettingsView } from "../router.ts";
import type { SectionForm } from "./drafts.ts";
import { formOf } from "./forms.ts";
import { useScopeName } from "./scope.tsx";
import { ScopePicker } from "./scope-picker.tsx";
import {
  isSectionAt,
  sectionIcon,
  sectionLabel,
  sectionsAt,
  type SectionSlug,
} from "./sections.ts";

/** The section `view` shows: a Skill directory page is the Skills section's; the list of sections shows none. */
export const currentSection = (scope: string, view: SettingsView): SectionSlug | null => {
  switch (view.kind) {
    case "index":
      return null;
    case "section":
      return isSectionAt(scope, view.section) ? view.section : null;
    default:
      return "skills";
  }
};

/**
 * The sections the navigation lists at Scope `scope`: none for an Environment the listing does not have, whose page
 * says it is not found; the Scope's sections otherwise, also while the listing has not answered.
 */
const useListedSections = (scope: string): readonly SectionSlug[] => {
  const environments = useAtomValue(environmentListAtom);

  const unknown =
    scope !== GLOBAL_SCOPE &&
    environments !== null &&
    !environments.some((environment) => environment.id === scope);

  return unknown ? [] : sectionsAt(scope);
};

/** The dot of a section whose form has unsaved changes, said to assistive technology as part of the link. */
const FormMark = ({
  form,
  scope,
  rail,
}: {
  form: Pick<SectionForm<never, never>, "dirty">;
  scope: string;
  rail: boolean;
}) =>
  useAtomValue(form.dirty(scope)) ? (
    <>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full bg-foreground",
          rail ? "absolute top-1.5 right-1.5" : "ml-auto",
        )}
        aria-hidden
      />
      <span className="sr-only">, unsaved changes</span>
    </>
  ) : null;

/** A section's unsaved mark, if it has a form. */
const UnsavedMark = ({
  slug,
  scope,
  rail = false,
}: {
  slug: SectionSlug;
  scope: string;
  rail?: boolean;
}) => {
  const form = formOf(slug, scope);

  return form === undefined ? null : <FormMark form={form} scope={scope} rail={rail} />;
};

/** The Scope's sections, as links. */
const SectionLinks = ({ scope, current }: { scope: string; current: SectionSlug | null }) => {
  const sections = useListedSections(scope);

  return (
    <ul className="flex flex-col gap-0.5">
      {sections.map((slug) => {
        const Icon = sectionIcon(slug);

        return (
          <li key={slug}>
            <InAppLink
              href={settingsPath(scope, slug)}
              aria-current={slug === current ? "page" : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
                slug === current && "bg-accent font-medium text-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{sectionLabel(slug, scope)}</span>
              <UnsavedMark slug={slug} scope={scope} />
            </InAppLink>
          </li>
        );
      })}
    </ul>
  );
};

/** The navigation in the sidebar's column: the Scope, then its sections. */
export const SettingsNav = ({ scope, view }: { scope: string; view: SettingsView }) => {
  const name = useScopeName(scope);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-y-contain px-2 pb-3">
      <div className="px-1">
        <h2 className="hidden truncate px-2 py-1 text-sm font-semibold md:block">{name}</h2>
        <ScopePicker scope={scope} view={view} className="md:hidden" />
      </div>
      <nav aria-label="Settings sections">
        <SectionLinks scope={scope} current={currentSection(scope, view)} />
      </nav>
    </div>
  );
};

/** The sections' icons on the collapsed rail, each named by its tooltip and to assistive technology. */
export const SettingsRailLinks = ({ scope, view }: { scope: string; view: SettingsView }) => {
  const current = currentSection(scope, view);
  const sections = useListedSections(scope);

  return (
    <ul aria-label="Settings sections" className="flex flex-col items-center gap-0.5">
      {sections.map((slug) => {
        const Icon = sectionIcon(slug);
        const label = sectionLabel(slug, scope);

        return (
          <li key={slug}>
            <InAppLink
              href={settingsPath(scope, slug)}
              aria-current={slug === current ? "page" : undefined}
              title={label}
              className={cn(
                "relative flex size-9 items-center justify-center rounded-md transition-colors hover:bg-accent",
                slug === current && "bg-accent text-accent-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden />
              <span className="sr-only">{label}</span>
              <UnsavedMark slug={slug} scope={scope} rail />
            </InAppLink>
          </li>
        );
      })}
    </ul>
  );
};
