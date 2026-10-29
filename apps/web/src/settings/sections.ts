// @effect-diagnostics missingPipeableSignature:off -- lookups by section and Scope, not combinators.

// The Settings page's sections (docs/architecture/client-and-protocol.md → Settings page; GLOSSARY.md → Settings
// section): what each is called and shown with, which a Scope has and in what order, where the page opens, and where
// switching the Scope leads. A section a Scope does not have is not shown there; the page opens the Scope's first
// section in its place.

import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import {
  Bell,
  Box,
  Brain,
  Braces,
  FolderGit2,
  Gauge,
  GitFork,
  History,
  KeyRound,
  type LucideIcon,
  ScrollText,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import {
  settingsPath,
  type SettingsView,
  skillOwnerPath,
  skillPagePath,
  skillRepoPath,
} from "../router.ts";

/** Each section's slug, as its path names it. */
export type SectionSlug =
  | "general"
  | "instructions"
  | "models"
  | "tools"
  | "limits"
  | "container"
  | "setup"
  | "environments"
  | "workspaces"
  | "skills"
  | "variables"
  | "secrets"
  | "notifications"
  | "agent-changes";

/** How a section is shown in the navigation: its name (at Global, and at an Environment) and its icon. */
interface SectionLook {
  readonly global: string;
  readonly environment: string;
  readonly icon: LucideIcon;
}

const named = (label: string, icon: LucideIcon): SectionLook => ({
  global: label,
  environment: label,
  icon,
});

const SECTIONS: Readonly<Record<SectionSlug, SectionLook>> = {
  general: named("General", SlidersHorizontal),
  instructions: named("Instructions", ScrollText),
  models: named("Models", Brain),
  tools: named("Tools", Wrench),
  limits: named("Limits", Gauge),
  container: named("Container", Box),
  setup: named("Setup", SquareTerminal),
  // At Global the list of Environments; at an Environment its own name, Repos and deletion.
  environments: { global: "Environments", environment: "Environment", icon: FolderGit2 },
  workspaces: named("Workspaces", GitFork),
  skills: named("Skills", Sparkles),
  variables: named("Variables", Braces),
  secrets: named("Secrets", KeyRound),
  notifications: named("Notifications", Bell),
  "agent-changes": named("Agent changes", History),
};

/** Global's sections, in the navigation's order. */
const GLOBAL_SECTIONS: readonly SectionSlug[] = [
  "general",
  "instructions",
  "models",
  "tools",
  "limits",
  "environments",
  "workspaces",
  "skills",
  "variables",
  "secrets",
  "notifications",
  "agent-changes",
];

/** An Environment's sections, in the navigation's order: the Environment itself first. */
const ENVIRONMENT_SECTIONS: readonly SectionSlug[] = [
  "environments",
  "container",
  "setup",
  "limits",
  "workspaces",
  "skills",
  "variables",
  "secrets",
  "agent-changes",
];

const isGlobal = (scope: string): boolean => scope === GLOBAL_SCOPE;

/** The sections Scope `scope` (`*` for Global, or an Environment's id) has, in the navigation's order. */
export const sectionsAt = (scope: string): readonly SectionSlug[] =>
  isGlobal(scope) ? GLOBAL_SECTIONS : ENVIRONMENT_SECTIONS;

/** Whether Scope `scope` has a section of slug `slug`. */
export const isSectionAt = (scope: string, slug: string): slug is SectionSlug =>
  Arr.contains(sectionsAt(scope), slug);

/** The name of section `slug` at Scope `scope`. */
export const sectionLabel = (slug: SectionSlug, scope: string): string =>
  isGlobal(scope) ? SECTIONS[slug].global : SECTIONS[slug].environment;

/** The icon of section `slug`. */
export const sectionIcon = (slug: SectionSlug): LucideIcon => SECTIONS[slug].icon;

/** The section the page opens at Scope `scope`: General at Global, the Environment at an Environment. */
export const defaultSection = (scope: string): SectionSlug =>
  isGlobal(scope) ? "general" : "environments";

/**
 * Where the page at Scope `scope` showing `view` leads on to, replacing its path, or null to stay: a section the Scope
 * lacks leads to the Scope's first section, and so does the list of sections on a `wide` screen, where the sidebar
 * already lists them.
 */
export const leadOnPath = (scope: string, view: SettingsView, wide: boolean): string | null => {
  switch (view.kind) {
    case "index":
      return wide ? settingsPath(scope, defaultSection(scope)) : null;
    case "section":
      return isSectionAt(scope, view.section) ? null : settingsPath(scope, defaultSection(scope));
    case "skillOwner":
    case "skillRepo":
    case "skill":
      return null;
  }
};

/**
 * Where the Scope picker leads from view `view` (with query `search`) to Scope `to`: the same section when `to` has it,
 * else `to`'s first section; the Skills section keeps its tab and search, and a Skill directory page stays that page,
 * its ref and folder kept. The list of sections stays a list.
 */
export const scopeSwitchPath = (view: SettingsView, search: string, to: string): string => {
  switch (view.kind) {
    case "index":
      return settingsPath(to);
    case "section":
      return isSectionAt(to, view.section)
        ? `${settingsPath(to, view.section)}${view.section === "skills" ? search : ""}`
        : settingsPath(to, defaultSection(to));
    case "skillOwner":
      return `${skillOwnerPath(to, view.owner)}${search}`;
    case "skillRepo":
      return `${skillRepoPath(to, view.owner, view.repo)}${search}`;
    case "skill":
      return `${skillPagePath(to, view.owner, view.repo, view.skill)}${search}`;
  }
};
