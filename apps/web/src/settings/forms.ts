// @effect-diagnostics missingPipeableSignature:off -- lookups by section and Scope, not combinators.

// The forms of the Settings page's sections that have a Save (docs/architecture/client-and-protocol.md → Settings page →
// Saving), each over the part of one saved value it edits. General, Models, Tools, Limits, Container and Setup are the
// same form at both Scopes (`scoped.ts`, ADR-0027): their fields are keyed by the path the Registry names them by, and
// at an Environment each is Inherited or Overridden. General, Models and Tools edit the Settings, Container and Setup the
// Container settings, and Limits both (the spend limit and the subagents' Limits, and the size limit). Variables are
// kept per Scope (Global's variables, or an Environment's own), and an Environment's Environment section edits its name.
// Instructions, at Global only, edit the Settings and are never overridden (#352 adds an Environment's own,
// which add up). `formOf` names the form of a section at a Scope, for the navigation's unsaved mark.

import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_MAX_SUBAGENT_WORKSPACES,
  type InstanceType,
  type ModelId,
  type RoleName,
  type Settings,
  type ThinkingLevel,
} from "@cloudpid/config";
import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { ignorePatternsFrom, parseVariables, variablesText } from "../environments.ts";
import {
  containerSettingsAtom,
  environmentNameResultAtom,
  globalVariablesResultAtom,
  readContainerSettings,
  readEnvironmentName,
  readGlobalVariables,
  writeContainerSettings,
  writeEnvironmentName,
  writeGlobalVariables,
} from "../environments-state.ts";
import { offeredFromText, offeredToText } from "../offered-tools.ts";
import { spendLimitFromText, spendLimitToText } from "../spend-limit.ts";
import { sectionForm, type SectionForm } from "./drafts.ts";
import {
  containerSource,
  type FieldSpec,
  type LimitsValue,
  limitsSource,
  scopedForm,
  settingsSource,
} from "./scoped.ts";
import type { SectionSlug } from "./sections.ts";

/** General: whether a move in the Session tree asks about a branch summary. */
export const generalForm = scopedForm(settingsSource, {
  "branchSummary.skipPrompt": {
    label: "the branch summary prompt",
    of: (settings) => settings.branchSummary.skipPrompt,
    into: (settings, skipPrompt: boolean) => ({ ...settings, branchSummary: { skipPrompt } }),
  },
});

/**
 * Instructions: Global's, as typed; their whitespace is part of what the agent reads, so they are compared exactly. They
 * add up rather than being overridden (ADR-0027), so the section is Global's only and none of its fields is ever marked.
 */
export const instructionsForm = scopedForm(settingsSource, {
  instructions: {
    label: "the instructions",
    of: (settings) => settings.instructions,
    into: (settings, instructions: string) => ({ ...settings, instructions }),
  },
});

/** A Role: its model and hint, one field. */
export type Role = Settings["roles"][RoleName];

const roleField = (name: RoleName): FieldSpec<Settings, Role> => ({
  label: `the ${name} role`,
  of: (settings) => settings.roles[name],
  into: (settings, role) => ({ ...settings, roles: { ...settings.roles, [name]: role } }),
});

/** Models: the default model and thinking level, and each Role, which is overridden by itself. */
export const modelsForm = scopedForm(settingsSource, {
  model: {
    label: "the default model",
    of: (settings) => settings.model,
    into: (settings, model: ModelId) => ({ ...settings, model }),
  },
  thinkingLevel: {
    label: "the thinking level",
    of: (settings) => settings.thinkingLevel,
    into: (settings, thinkingLevel: ThinkingLevel) => ({ ...settings, thinkingLevel }),
  },
  "roles.small": roleField("small"),
  "roles.medium": roleField("medium"),
  "roles.large": roleField("large"),
  "roles.xlarge": roleField("xlarge"),
});

/** Tools: the offered tools, as typed (a name per line), replaced whole. */
export const toolsForm = scopedForm(settingsSource, {
  "tools.offered": {
    label: "the offered tools",
    of: (settings) => offeredToText(settings.tools.offered),
    into: (settings, offered: string) => ({
      ...settings,
      tools: { ...settings.tools, offered: offeredFromText(offered) },
    }),
    same: (left: string, right: string) =>
      Arr.join(offeredFromText(left), "\n") === Arr.join(offeredFromText(right), "\n"),
  },
});

/** The number `text` holds, if it is a whole number of at least `least`. */
const wholeNumberOf = (text: string, least: number): number | undefined => {
  const trimmed = text.trim();
  const value = Number(trimmed);

  return /^\d+$/.test(trimmed) && value >= least ? value : undefined;
};

/** The subagents' Limits: the least each may be (the depth at least 1, the Subagent Workspace limit 0 for none). */
const SUBAGENT_LIMIT_LEAST = { maxSubagentDepth: 1, maxSubagentWorkspaces: 0 } as const;

/** Why `text` cannot be the subagents' Limit `key`, or null. */
export const subagentLimitProblem = (
  key: keyof typeof SUBAGENT_LIMIT_LEAST,
  text: string,
): string | null =>
  wholeNumberOf(text, SUBAGENT_LIMIT_LEAST[key]) === undefined
    ? `Enter a whole number of ${SUBAGENT_LIMIT_LEAST[key]} or more.`
    : null;

/** One of the subagents' Limits, an option of the subagents extension (`extensions.subagents.<key>`), as typed. */
const subagentLimit = (
  key: keyof typeof SUBAGENT_LIMIT_LEAST,
  label: string,
  fallback: number,
): FieldSpec<LimitsValue, string> => ({
  label,
  of: ({ settings }) => {
    const value = settings.extensions["subagents"]?.[key];

    return String(Predicate.isNumber(value) ? value : fallback);
  },
  into: (limits, text) => {
    const value = wholeNumberOf(text, SUBAGENT_LIMIT_LEAST[key]);

    if (value === undefined) return limits;

    const { extensions } = limits.settings;

    return {
      ...limits,
      settings: {
        ...limits.settings,
        extensions: { ...extensions, subagents: { ...extensions["subagents"], [key]: value } },
      },
    };
  },
  same: (left: string, right: string) => left.trim() === right.trim(),
});

/** Limits: the spend limit (empty for none), the subagents' Limits, and the size limit. */
export const limitsForm = scopedForm(limitsSource, {
  "spendLimit.perSession": {
    label: "the spend limit",
    of: ({ settings }) => spendLimitToText(settings.spendLimit.perSession),
    into: (limits, text: string) => ({
      ...limits,
      settings: {
        ...limits.settings,
        spendLimit: {
          perSession: spendLimitFromText(text) ?? limits.settings.spendLimit.perSession,
        },
      },
    }),
    same: (left: string, right: string) => {
      const typed = spendLimitFromText(left);

      return typed === undefined ? left === right : typed === spendLimitFromText(right);
    },
  },
  "extensions.subagents.maxSubagentDepth": subagentLimit(
    "maxSubagentDepth",
    "the subagent depth",
    DEFAULT_MAX_SUBAGENT_DEPTH,
  ),
  "extensions.subagents.maxSubagentWorkspaces": subagentLimit(
    "maxSubagentWorkspaces",
    "the Subagent Workspace limit",
    DEFAULT_MAX_SUBAGENT_WORKSPACES,
  ),
  maxInstance: {
    label: "the size limit",
    of: ({ container }) => container.maxInstance,
    into: (limits, maxInstance: InstanceType) => ({
      ...limits,
      container: { ...limits.container, maxInstance },
    }),
  },
});

/** Container: the size, the idle time and the Container-only paths as typed, and the Spare Workspace. */
export const containerSectionForm = scopedForm(containerSource, {
  instance: {
    label: "the size",
    of: (settings) => settings.instance,
    into: (settings, instance: InstanceType) => ({ ...settings, instance }),
  },
  idleMinutes: {
    label: "the idle time",
    of: (settings) => String(settings.idleMinutes),
    into: (settings, idle: string) => ({ ...settings, idleMinutes: Number(idle) }),
    same: (left: string, right: string) => left.trim() === right.trim(),
  },
  ignore: {
    label: "the Container-only paths",
    of: (settings) => Arr.join(settings.ignore, "\n"),
    into: (settings, ignore: string) => ({ ...settings, ignore: ignorePatternsFrom(ignore) }),
    same: (left: string, right: string) =>
      Arr.join(ignorePatternsFrom(left), "\n") === Arr.join(ignorePatternsFrom(right), "\n"),
  },
  spareWorkspace: {
    label: "the Spare Workspace",
    of: (settings) => settings.spareWorkspace,
    into: (settings, spareWorkspace: boolean) => ({ ...settings, spareWorkspace }),
  },
});

/** Setup: the Toolchains (a mise.toml), and the Setup and Start Scripts, each replaced whole. */
export const setupForm = scopedForm(containerSource, {
  toolchains: {
    label: "the Toolchains",
    of: (settings) => settings.toolchains,
    into: (settings, toolchains: string) => ({ ...settings, toolchains }),
  },
  setupScript: {
    label: "the Setup Script",
    of: (settings) => settings.setupScript,
    into: (settings, setupScript: string) => ({ ...settings, setupScript }),
  },
  startScript: {
    label: "the Start Script",
    of: (settings) => settings.startScript,
    into: (settings, startScript: string) => ({ ...settings, startScript }),
  },
});

/** Whether two texts of variables (`NAME=value` lines) mean the same variables, or are the same text. */
const sameVariables = (left: string, right: string): boolean => {
  const parsedLeft = parseVariables(left);
  const parsedRight = parseVariables(right);

  return Result.isSuccess(parsedLeft) && Result.isSuccess(parsedRight)
    ? variablesText(parsedLeft.success) === variablesText(parsedRight.success)
    : left === right;
};

/** The variables `text` sets, or `fallback` when it does not parse (the form saves only text that does). */
const variablesOf = (
  text: string,
  fallback: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => Result.getOrElse(parseVariables(text), () => fallback);

/**
 * An Environment's own Variables, as typed: each one overrides Global's of its name, and a Global one it does not name is
 * inherited. Its Save sends only the variables changed, as Overrides (`writeContainerSettings`). It has no Reset to
 * defaults.
 */
export const environmentVariablesForm = sectionForm({
  saved: containerSettingsAtom,
  fieldsOf: (settings) => ({ variables: variablesText(settings.variables) }),
  merge: (settings, { variables }) => ({
    ...settings,
    variables: variablesOf(variables, settings.variables),
  }),
  same: (left, right) => sameVariables(left.variables, right.variables),
  read: readContainerSettings,
  write: writeContainerSettings,
  keys: (id) => [`environment-settings:${id}`, "global", "builds"],
});

/**
 * Global's Variables, as typed: the variables kept Global. It has no Reset to defaults: the default is none, so a save
 * of it would reset every Global variable.
 */
export const globalVariablesForm = sectionForm({
  saved: () => globalVariablesResultAtom,
  fieldsOf: (variables: Readonly<Record<string, string>>) => ({
    variables: variablesText(variables),
  }),
  merge: (saved, { variables }) => variablesOf(variables, saved),
  same: (left, right) => sameVariables(left.variables, right.variables),
  read: () => readGlobalVariables,
  write: (_scope, before, after) => writeGlobalVariables(before, after),
  keys: () => ["global", "builds"],
});

/** An Environment's name, in its Environment section. It has no default. */
export const environmentNameForm = sectionForm({
  saved: environmentNameResultAtom,
  fieldsOf: (name: string) => ({ name }),
  merge: (_saved, { name }) => name.trim(),
  same: (left, right) => left.name.trim() === right.name.trim(),
  read: readEnvironmentName,
  write: (id, _before, name) => writeEnvironmentName(id, name),
  keys: () => ["environments"],
});

/** A form of any section, as the navigation reads it: whether it has unsaved changes. */
type AnyForm = Pick<SectionForm<never, never>, "dirty">;

/** The sections whose form is the same at both Scopes. */
const SCOPED_FORMS: Partial<Readonly<Record<SectionSlug, AnyForm>>> = {
  general: generalForm,
  models: modelsForm,
  tools: toolsForm,
  limits: limitsForm,
  container: containerSectionForm,
  setup: setupForm,
};

const GLOBAL_FORMS: Partial<Readonly<Record<SectionSlug, AnyForm>>> = {
  ...SCOPED_FORMS,
  instructions: instructionsForm,
  variables: globalVariablesForm,
};

const ENVIRONMENT_FORMS: Partial<Readonly<Record<SectionSlug, AnyForm>>> = {
  ...SCOPED_FORMS,
  environments: environmentNameForm,
  variables: environmentVariablesForm,
};

/** The form of section `slug` at Scope `scope` (`*` for Global), if the section has one. */
export const formOf = (slug: SectionSlug, scope: string): AnyForm | undefined =>
  (scope === GLOBAL_SCOPE ? GLOBAL_FORMS : ENVIRONMENT_FORMS)[slug];
