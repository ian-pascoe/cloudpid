// @effect-diagnostics missingPipeableSignature:off -- lookups by section and Scope, not combinators.

// The forms of the Settings page's sections that have a Save (docs/architecture/client-and-protocol.md → Settings page →
// Saving), each over the part of one saved value it edits: General, Instructions, Models, Tools and Limits the Settings; an
// Environment's Container, Setup, Limits (its size limit) and Variables its Container settings; Global's Variables the
// variables kept Global; an Environment's Environment section its name. `formOf` names the form of a section at a
// Scope, for the navigation's unsaved mark.

import {
  DEFAULT_SETTINGS,
  type ContainerSettings,
  type InstanceType,
  type Settings,
} from "@cloudpid/config";
import { GLOBAL_SCOPE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
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
import { readSettings, savedSettingsAtom, writeSettings } from "../settings.ts";
import { spendLimitFromText, spendLimitToText } from "../spend-limit.ts";
import { sectionForm, type SectionForm, type SectionFormSpec } from "./drafts.ts";
import type { SectionSlug } from "./sections.ts";

/** A form over the Settings (Global's, for now: the Scope is not read). */
const settingsForm = <Fields extends object>(
  spec: Pick<SectionFormSpec<Settings, Fields, never>, "fieldsOf" | "merge" | "same">,
) =>
  sectionForm({
    ...spec,
    saved: () => savedSettingsAtom,
    defaults: spec.fieldsOf(DEFAULT_SETTINGS),
    read: () => readSettings,
    // The Settings are saved whole: `after` is what is saved now with only what the owner changed replaced.
    write: (_scope, _before, after) => writeSettings(after),
    keys: () => ["settings"],
  });

/** General: whether a move in the Session tree asks about a branch summary. */
export const generalForm = settingsForm({
  fieldsOf: (settings) => ({ skipPrompt: settings.branchSummary.skipPrompt }),
  merge: (settings, { skipPrompt }) => ({ ...settings, branchSummary: { skipPrompt } }),
});

/** Instructions: Global's, as typed; their whitespace is part of what the agent reads, so they are compared exactly. */
export const instructionsForm = settingsForm({
  fieldsOf: ({ instructions }) => ({ instructions }),
  merge: (settings, { instructions }) => ({ ...settings, instructions }),
});

/** Models: the default model and thinking level, and the Roles. */
export const modelsForm = settingsForm({
  fieldsOf: ({ model, thinkingLevel, roles }) => ({ model, thinkingLevel, roles }),
  merge: (settings, { model, thinkingLevel, roles }) => ({
    ...settings,
    model,
    thinkingLevel,
    roles,
  }),
});

/** Tools: the offered tools, as typed (a name per line). */
export const toolsForm = settingsForm({
  fieldsOf: (settings) => ({ offered: offeredToText(settings.tools.offered) }),
  merge: (settings, { offered }) => ({
    ...settings,
    tools: { ...settings.tools, offered: offeredFromText(offered) },
  }),
  same: (left, right) =>
    Arr.join(offeredFromText(left.offered), "\n") ===
    Arr.join(offeredFromText(right.offered), "\n"),
});

/** Global's Limits: the spend limit, as typed (empty for none). */
export const globalLimitsForm = settingsForm({
  fieldsOf: (settings) => ({ spendLimit: spendLimitToText(settings.spendLimit.perSession) }),
  merge: (settings, { spendLimit }) => ({
    ...settings,
    spendLimit: { perSession: spendLimitFromText(spendLimit) ?? settings.spendLimit.perSession },
  }),
  same: (left, right) => {
    const typed = spendLimitFromText(left.spendLimit);

    return typed === undefined
      ? left.spendLimit === right.spendLimit
      : typed === spendLimitFromText(right.spendLimit);
  },
});

/**
 * A form over an Environment's Container settings, the Scope being the Environment's id. Its Save sends only the fields
 * changed, as Overrides (`writeContainerSettings`). It has no Reset to defaults: a field the Environment does not
 * override inherits Global's, not the defaults.
 */
const containerForm = <Fields extends object>(
  spec: Pick<SectionFormSpec<ContainerSettings, Fields, never>, "fieldsOf" | "merge" | "same">,
) =>
  sectionForm({
    ...spec,
    saved: containerSettingsAtom,
    read: readContainerSettings,
    write: writeContainerSettings,
    keys: (id) => [`environment-settings:${id}`, "builds"],
  });

/** What the Container section holds: the size, the idle time and the extra paths as typed, and the Spare Workspace. */
export interface ContainerFields {
  readonly instance: InstanceType;
  readonly idle: string;
  readonly ignore: string;
  readonly spareWorkspace: boolean;
}

/** An Environment's Container: its size, idle time, Container-only paths and Spare Workspace. */
export const containerSectionForm = containerForm<ContainerFields>({
  fieldsOf: (settings) => ({
    instance: settings.instance,
    idle: String(settings.idleMinutes),
    ignore: Arr.join(settings.ignore, "\n"),
    spareWorkspace: settings.spareWorkspace,
  }),
  merge: (settings, { instance, idle, ignore, spareWorkspace }) => ({
    ...settings,
    instance,
    idleMinutes: Number(idle),
    ignore: ignorePatternsFrom(ignore),
    spareWorkspace,
  }),
  same: (left, right) =>
    left.instance === right.instance &&
    left.spareWorkspace === right.spareWorkspace &&
    left.idle.trim() === right.idle.trim() &&
    Arr.join(ignorePatternsFrom(left.ignore), "\n") ===
      Arr.join(ignorePatternsFrom(right.ignore), "\n"),
});

/** An Environment's Setup: its Toolchains (a mise.toml), and its Setup and Start Scripts. */
export const setupForm = containerForm({
  fieldsOf: ({ toolchains, setupScript, startScript }) => ({
    toolchains,
    setupScript,
    startScript,
  }),
  merge: (settings, { toolchains, setupScript, startScript }) => ({
    ...settings,
    toolchains,
    setupScript,
    startScript,
  }),
});

/** An Environment's Limits: its size limit. */
export const environmentLimitsForm = containerForm({
  fieldsOf: ({ maxInstance }) => ({ maxInstance }),
  merge: (settings, { maxInstance }) => ({ ...settings, maxInstance }),
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

/** An Environment's own Variables, as typed. */
export const environmentVariablesForm = containerForm({
  fieldsOf: (settings) => ({ variables: variablesText(settings.variables) }),
  merge: (settings, { variables }) => ({
    ...settings,
    variables: variablesOf(variables, settings.variables),
  }),
  same: (left, right) => sameVariables(left.variables, right.variables),
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

const GLOBAL_FORMS: Partial<Readonly<Record<SectionSlug, AnyForm>>> = {
  general: generalForm,
  instructions: instructionsForm,
  models: modelsForm,
  tools: toolsForm,
  limits: globalLimitsForm,
  variables: globalVariablesForm,
};

const ENVIRONMENT_FORMS: Partial<Readonly<Record<SectionSlug, AnyForm>>> = {
  environments: environmentNameForm,
  container: containerSectionForm,
  setup: setupForm,
  limits: environmentLimitsForm,
  variables: environmentVariablesForm,
};

/** The form of section `slug` at Scope `scope` (`*` for Global), if the section has one. */
export const formOf = (slug: SectionSlug, scope: string): AnyForm | undefined =>
  (scope === GLOBAL_SCOPE ? GLOBAL_FORMS : ENVIRONMENT_FORMS)[slug];
