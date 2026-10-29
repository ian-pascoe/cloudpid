// @effect-diagnostics missingPipeableSignature:off -- builders and lookups by Scope, not combinators.

// A Settings section's fields at a Scope (ADR-0027; docs/architecture/client-and-protocol.md → Settings page → Scopes):
// one form serves both Scopes. At Global a field holds Global's own value, and names the Environments that override it;
// at an Environment it is Inherited (Global's value, followed until the owner overrides it) or Overridden (the
// Environment's own, kept until it is reset to Global). A form's draft holds each field with its mark, keyed by the
// field's path as the Registry names it (`model`, `roles.small`, `idleMinutes`), so a save sends only the fields the
// owner changed: at Global the value with them replaced, at an Environment its Overrides set or reset, never an
// inherited value. The sources below read and write each saved value at either Scope through the one read and write
// helper per RPC (`settings.ts`, `environments-state.ts`).

import {
  CONTAINER_SETTING_NAMES,
  type ContainerSettings,
  type ContainerSettingsOverrides,
  DEFAULT_CONTAINER_SETTINGS,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  DEFAULT_MAX_SUBAGENT_WORKSPACES,
  DEFAULT_SETTINGS,
  isContainerField,
  overrideValue,
  type Settings,
  type SettingsError,
  settingsFieldValue,
  withOverrideFields,
} from "@cloudpid/config";
import {
  type ContainerSettingsState,
  type EnvironmentError,
  GLOBAL_SCOPE,
  type GlobalContainerSettingsState,
  type OverridingEnvironment,
  type SettingsOverridesState,
  type SettingsState,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as Schema from "effect/Schema";
import {
  environmentSettingsAtom,
  globalSettingsAtom,
  readEnvironmentContainerSettings,
  readGlobalContainerSettings,
  writeContainerOverrides,
  writeGlobalContainerSettings,
} from "../environments-state.ts";
import type { RegistryClient, RegistryKey } from "../registry.ts";
import { appRuntime } from "../runtime.ts";
import {
  readSettings,
  readSettingsOverrides,
  settingsAtom,
  settingsOverridesAtom,
  writeSettings,
  writeSettingsOverrides,
} from "../settings.ts";
import { sameAsJson, sectionForm, type SectionForm } from "./drafts.ts";

const isGlobal = (scope: string): boolean => scope === GLOBAL_SCOPE;

/** A field as a form holds it: its value as typed, and whether the Environment inherits it (never at Global). */
export interface Marked<V> {
  readonly value: V;
  readonly inherited: boolean;
}

/** A section's fields, each with its mark. */
export type MarkedFields<F> = { readonly [K in keyof F]: Marked<F[K]> };

/** By field path, the Environments that override it. */
export type OverriddenIn = { readonly [field: string]: ReadonlyArray<OverridingEnvironment> };

/** A saved value at a Scope, in one shape at both. */
export interface AtScope<Value, Overrides> {
  /** What is in force at the Scope. */
  readonly inForce: Value;
  /** Global's in force: what a field the Environment does not override has. At Global, `inForce`. */
  readonly global: Value;
  /** The Environment's Overrides: exactly the fields set on purpose. Null at Global, which has none. */
  readonly overrides: Overrides | null;
  /** At Global, the Environments that override each field; empty at an Environment. */
  readonly overriddenIn: OverriddenIn;
  /** Why the Registry left some saved values out, or null. */
  readonly problem: string | null;
}

/** Why a saved value could not be read or written: the Registry's refusal, or the request's failure. */
export type ScopedError = SettingsError | EnvironmentError | RpcClientError;

/** Where a saved value is kept at each Scope, and how a field of it is overridden. */
export interface ScopedSource<Value, Overrides> {
  /** The saved value at Scope `scope`, as a Registry query. */
  readonly saved: (
    scope: string,
  ) => Atom.Atom<AsyncResult.AsyncResult<AtScope<Value, Overrides>, ScopedError>>;
  /** The saved value at Scope `scope`, read from the Registry now. */
  readonly read: (
    scope: string,
  ) => Effect.Effect<AtScope<Value, Overrides>, ScopedError, RegistryClient>;
  /**
   * Make the value at Scope `scope` `before` into `after`, which differ only in what the owner changed: at Global what
   * is in force, at an Environment its Overrides.
   */
  readonly write: (
    scope: string,
    before: AtScope<Value, Overrides>,
    after: AtScope<Value, Overrides>,
  ) => Effect.Effect<unknown, ScopedError, RegistryClient>;
  /** What a save at Scope `scope` changes, for the queries to ask again. */
  readonly keys: (scope: string) => ReadonlyArray<RegistryKey>;
  readonly defaults: Value;
  /** Whether `overrides` hold field `field`. */
  readonly isOverridden: (overrides: Overrides, field: string) => boolean;
  /** `overrides` with field `field` overridden as `value` has it, or, for `undefined`, reset to inherit again. */
  readonly withField: (overrides: Overrides, field: string, value: Value | undefined) => Overrides;
}

/**
 * One field of a section: its name as a sentence names it ("the default model", for "Override the default model"), and
 * its value as the form holds it, read from and put in the value.
 */
// Methods, not function properties, so a field of any typed value is a `FieldSpec<Value, unknown>`.
export interface FieldSpec<Value, V> {
  readonly label: string;
  of(value: Value): V;
  /** `value` with the field set to `typed`, which the form has checked. */
  into(value: Value, typed: V): Value;
  /** Whether two typed values mean the same; by default, whether they are equal as JSON. */
  same?(left: V, right: V): boolean;
}

/** A section's fields, by their paths, in the section's order. */
export type FieldSpecs<Value> = { readonly [path: string]: FieldSpec<Value, unknown> };

/** The typed value of each field of `S`, by path. */
export type FieldsOf<S> = {
  readonly [K in keyof S]: S[K] extends { of(value: never): infer V } ? V : never;
};

/** What a section shows of a field beside its value at a Scope. */
export interface ScopeView<Value, F> {
  /** What is in force at the Scope, as saved. */
  readonly inForce: Value;
  /** Each field inheriting Global's value: what a reset to Global puts in the draft. */
  readonly inherited: MarkedFields<F>;
  readonly overriddenIn: OverriddenIn;
  readonly problem: string | null;
}

/** The form of a section at either Scope. */
export interface ScopedForm<Value, F> extends SectionForm<MarkedFields<F>, ScopedError> {
  readonly defaults: MarkedFields<F>;
  /** What the section shows beside its fields at Scope `scope`; null until the saved value first answers. */
  readonly scopeView: (scope: string) => Atom.Atom<ScopeView<Value, F> | null>;
  /**
   * At Environment `scope`, reset every Override of the section as the Registry has them now, so each field inherits
   * Global's value again, and drop the section's draft.
   */
  readonly resetToGlobal: (scope: string) => Atom.AtomResultFn<void, void, ScopedError>;
  /** The fields' paths, in the section's order. */
  readonly paths: ReadonlyArray<keyof F & string>;
  /** Each field's name for people, by path. */
  readonly labels: { readonly [K in keyof F]: string };
}

/** Fields built one per key of `keys` by `make`. */
const fieldsFrom = <F>(
  keys: ReadonlyArray<keyof F & string>,
  make: <K extends keyof F & string>(key: K) => Marked<F[K]>,
): MarkedFields<F> =>
  // SAFETY: one entry per key of F, each made for its key.
  Record.fromEntries(Arr.map(keys, (key) => [key, make(key)] as const)) as MarkedFields<F>;

/** The form of a section whose fields `specs` (by path, in order) are kept in `source`, at either Scope. */
export const scopedForm = <Value, Overrides, S extends FieldSpecs<Value>>(
  source: ScopedSource<Value, Overrides>,
  specs: S,
): ScopedForm<Value, FieldsOf<S>> => {
  type F = FieldsOf<S>;

  // SAFETY: the specs are a plain object of the section's fields by path, which `Record.keys` lists in order.
  const keys = Record.keys(specs) as Array<keyof F & string>;
  // SAFETY: each spec reads and writes its own field's typed value, which `FieldsOf` names.
  const specOf = <K extends keyof F & string>(key: K) => specs[key] as FieldSpec<Value, F[K]>;

  const fieldsOf = (saved: AtScope<Value, Overrides>): MarkedFields<F> =>
    fieldsFrom<F>(keys, (key) => ({
      value: specOf(key).of(saved.inForce),
      inherited: saved.overrides !== null && !source.isOverridden(saved.overrides, key),
    }));

  const merge = (
    saved: AtScope<Value, Overrides>,
    fields: MarkedFields<F>,
  ): AtScope<Value, Overrides> =>
    saved.overrides === null
      ? {
          ...saved,
          inForce: Arr.reduce(keys, saved.inForce, (value, key) =>
            specOf(key).into(value, fields[key].value),
          ),
        }
      : {
          ...saved,
          overrides: Arr.reduce(keys, saved.overrides, (overrides: Overrides, key) =>
            source.withField(
              overrides,
              key,
              fields[key].inherited
                ? undefined
                : specOf(key).into(saved.inForce, fields[key].value),
            ),
          ),
        };

  // Two inherited fields are the same whatever Global's value was when each was read: both follow Global.
  const same = (left: MarkedFields<F>, right: MarkedFields<F>): boolean =>
    Arr.every(keys, (key) => {
      const [a, b] = [left[key], right[key]];
      const spec = specOf(key);

      return (
        a.inherited === b.inherited &&
        (a.inherited ||
          (spec.same === undefined ? sameAsJson(a.value, b.value) : spec.same(a.value, b.value)))
      );
    });

  const defaults = fieldsOf({
    inForce: source.defaults,
    global: source.defaults,
    overrides: null,
    overriddenIn: {},
    problem: null,
  });

  const form = sectionForm({
    saved: source.saved,
    fieldsOf,
    merge,
    same,
    defaults,
    read: source.read,
    write: source.write,
    keys: source.keys,
  });

  /** Each field inheriting `saved`'s Global value. */
  const inheritedOf = (saved: AtScope<Value, Overrides>): MarkedFields<F> =>
    fieldsFrom<F>(keys, (key) => ({ value: specOf(key).of(saved.global), inherited: true }));

  // Reset to Global at an Environment: the section's Overrides as the Registry has them now, every one reset, so an
  // Override made since the page read them goes too; any draft is dropped with them.
  const resetToGlobal = Atom.family((scope: string) =>
    appRuntime.fn((_: void, get) =>
      Effect.gen(function* () {
        const now = yield* source.read(scope);

        if (now.overrides !== null) yield* source.write(scope, now, merge(now, inheritedOf(now)));

        yield* Reactivity.invalidate(source.keys(scope));
        yield* get.result(source.saved(scope), { suspendOnWaiting: true }).pipe(Effect.ignore);
        get.set(form.draft(scope), undefined);
        get.set(form.justSaved(scope), true);
      }),
    ),
  );

  const scopeView = Atom.family((scope: string) =>
    Atom.map(source.saved(scope), (result) =>
      result.pipe(
        AsyncResult.value,
        Option.map((saved): ScopeView<Value, F> => ({
          inForce: saved.inForce,
          inherited: inheritedOf(saved),
          overriddenIn: saved.overriddenIn,
          problem: saved.problem,
        })),
        Option.getOrNull,
      ),
    ),
  );

  // SAFETY: one label per field of the specs.
  const labels = Record.map(specs, (spec) => spec.label) as ScopedForm<Value, F>["labels"];

  return { ...form, defaults, scopeView, resetToGlobal, paths: keys, labels };
};

// The Settings (model, Roles, tools, limits, …): Global's are written whole, an Environment's Overrides as a patch.

const SUBAGENT_LIMIT_DEFAULTS: ReadonlyMap<string, number> = new Map([
  ["maxSubagentDepth", DEFAULT_MAX_SUBAGENT_DEPTH],
  ["maxSubagentWorkspaces", DEFAULT_MAX_SUBAGENT_WORKSPACES],
]);

/**
 * `settings` without the subagents' Limits that are at their defaults, so Global keeps only what differs from the
 * defaults (the extension's options are not in the defaults, which would keep them all). An Environment's Override of
 * one at its default is kept: it pins the value against Global.
 */
const withoutDefaultLimits = (settings: Settings): Settings => {
  const subagents = settings.extensions["subagents"];

  if (subagents === undefined) return settings;

  const kept = Record.filter(subagents, (value, key) => SUBAGENT_LIMIT_DEFAULTS.get(key) !== value);
  const { subagents: _dropped, ...others } = settings.extensions;

  return {
    ...settings,
    extensions: Record.isEmptyRecord(kept) ? others : { ...others, subagents: kept },
  };
};

type SettingsAtScope = AtScope<Settings, Schema.Json>;

const globalSettingsAtScope = (state: SettingsState): SettingsAtScope => ({
  inForce: state.settings,
  global: state.settings,
  overrides: null,
  overriddenIn: state.overriddenIn,
  problem: state.problem ?? null,
});

const environmentSettingsAtScope = (state: SettingsOverridesState): SettingsAtScope => ({
  inForce: state.settings,
  global: state.global,
  overrides: state.overrides,
  overriddenIn: {},
  problem: state.problem ?? null,
});

/** The Settings: Global's (`getSettings`), or an Environment's Overrides over them (`getSettingsOverrides`). */
export const settingsSource: ScopedSource<Settings, Schema.Json> = {
  saved: Atom.family((scope: string) =>
    isGlobal(scope)
      ? Atom.map(settingsAtom, (result) => AsyncResult.map(result, globalSettingsAtScope))
      : Atom.map(settingsOverridesAtom(scope), (result) =>
          AsyncResult.map(result, environmentSettingsAtScope),
        ),
  ),
  read: (scope) =>
    isGlobal(scope)
      ? Effect.map(readSettings, globalSettingsAtScope)
      : Effect.map(readSettingsOverrides(scope), environmentSettingsAtScope),
  write: (scope, before, after) =>
    isGlobal(scope)
      ? writeSettings(withoutDefaultLimits(after.inForce))
      : writeSettingsOverrides(scope, before.overrides ?? {}, after.overrides ?? {}),
  // Global's and every Environment's Settings are on one key: a field inherited follows a save at Global.
  keys: () => ["settings"],
  defaults: DEFAULT_SETTINGS,
  isOverridden: (overrides, field) => Option.isSome(overrideValue(overrides, field)),
  withField: (overrides, field, value) =>
    Result.getOrElse(
      withOverrideFields(
        overrides,
        [
          value === undefined
            ? { field, reset: true }
            : { field, value: settingsFieldValue(value, field) },
        ],
        value ?? DEFAULT_SETTINGS,
      ),
      () => overrides,
    ),
};

// The Container settings (size, idle time, paths, scripts, …), but the variables, which the Variables section keeps.

type ContainerAtScope = AtScope<ContainerSettings, ContainerSettingsOverrides>;

const globalContainerAtScope = (state: GlobalContainerSettingsState): ContainerAtScope => ({
  inForce: state.settings,
  global: state.settings,
  overrides: null,
  overriddenIn: state.overriddenIn,
  problem: state.problem ?? null,
});

const environmentContainerAtScope = (state: ContainerSettingsState): ContainerAtScope => ({
  inForce: state.settings,
  global: state.global,
  overrides: state.overrides,
  overriddenIn: {},
  problem: state.problem ?? null,
});

const isContainerSetting = (field: string): field is keyof ContainerSettings =>
  Arr.contains(CONTAINER_SETTING_NAMES, field);

/** The Container settings: Global's (`getGlobalContainerSettings`), or an Environment's (`getEnvironmentSettings`). */
export const containerSource: ScopedSource<ContainerSettings, ContainerSettingsOverrides> = {
  saved: Atom.family((scope: string) =>
    isGlobal(scope)
      ? Atom.map(globalSettingsAtom, (result) => AsyncResult.map(result, globalContainerAtScope))
      : Atom.map(environmentSettingsAtom(scope), (result) =>
          AsyncResult.map(result, environmentContainerAtScope),
        ),
  ),
  read: (scope) =>
    isGlobal(scope)
      ? Effect.map(readGlobalContainerSettings, globalContainerAtScope)
      : Effect.map(readEnvironmentContainerSettings(scope), environmentContainerAtScope),
  write: (scope, before, after) =>
    isGlobal(scope)
      ? writeGlobalContainerSettings(before.inForce, after.inForce)
      : writeContainerOverrides(scope, before.overrides ?? {}, after.overrides ?? {}),
  keys: (scope) =>
    isGlobal(scope)
      ? ["global", "builds"]
      : // Global's answer names the Environments that override each field.
        [`environment-settings:${scope}`, "global", "builds"],
  defaults: DEFAULT_CONTAINER_SETTINGS,
  isOverridden: (overrides, field) => isContainerSetting(field) && overrides[field] !== undefined,
  withField: (overrides, field, value) => {
    if (!isContainerSetting(field)) return overrides;

    const { [field]: _reset, ...others } = overrides;

    return value === undefined ? others : { ...others, [field]: value[field] };
  },
};

// The Limits: the Settings' spend limit and subagents' Limits, and the Container settings' size limit, in one form.

/** The Limits' value: the Settings and the Container settings at one Scope. */
export interface LimitsValue {
  readonly settings: Settings;
  readonly container: ContainerSettings;
}

/** The Limits' Overrides: the Settings' and the Container settings' of one Environment. */
export interface LimitsOverrides {
  readonly settings: Schema.Json;
  readonly container: ContainerSettingsOverrides;
}

type LimitsAtScope = AtScope<LimitsValue, LimitsOverrides>;

const limitsAtScope = (settings: SettingsAtScope, container: ContainerAtScope): LimitsAtScope => ({
  inForce: { settings: settings.inForce, container: container.inForce },
  global: { settings: settings.global, container: container.global },
  overrides:
    settings.overrides === null || container.overrides === null
      ? null
      : { settings: settings.overrides, container: container.overrides },
  overriddenIn: { ...settings.overriddenIn, ...container.overriddenIn },
  problem:
    Arr.join(
      Arr.filter([settings.problem, container.problem], (problem) => problem !== null),
      "\n",
    ) || null,
});

/** One of the two values the Limits hold, at one Scope. */
const partOf = <Part extends keyof LimitsValue>(
  limits: LimitsAtScope,
  part: Part,
): AtScope<LimitsValue[Part], LimitsOverrides[Part]> => ({
  inForce: limits.inForce[part],
  global: limits.global[part],
  overrides: limits.overrides === null ? null : limits.overrides[part],
  overriddenIn: limits.overriddenIn,
  problem: limits.problem,
});

/** Whether a save changes `part` of the Limits: what is in force at Global, the Overrides at an Environment. */
const changes = (part: keyof LimitsValue, before: LimitsAtScope, after: LimitsAtScope): boolean =>
  !sameAsJson(before.inForce[part], after.inForce[part]) ||
  !sameAsJson(before.overrides?.[part], after.overrides?.[part]);

/** The Limits: the Settings' (`settingsSource`) and the Container settings' (`containerSource`), each saved by its own RPC. */
export const limitsSource: ScopedSource<LimitsValue, LimitsOverrides> = {
  saved: Atom.family((scope: string) =>
    Atom.readable((get) =>
      AsyncResult.map(
        AsyncResult.all([get(settingsSource.saved(scope)), get(containerSource.saved(scope))]),
        ([settings, container]) => limitsAtScope(settings, container),
      ),
    ),
  ),
  read: (scope) =>
    Effect.map(
      Effect.all([settingsSource.read(scope), containerSource.read(scope)]),
      ([settings, container]) => limitsAtScope(settings, container),
    ),
  write: (scope, before, after) =>
    Effect.all(
      [
        changes("settings", before, after)
          ? settingsSource.write(scope, partOf(before, "settings"), partOf(after, "settings"))
          : Effect.void,
        changes("container", before, after)
          ? containerSource.write(scope, partOf(before, "container"), partOf(after, "container"))
          : Effect.void,
      ],
      { discard: true },
    ),
  keys: (scope) => [...settingsSource.keys(scope), ...containerSource.keys(scope)],
  defaults: { settings: DEFAULT_SETTINGS, container: DEFAULT_CONTAINER_SETTINGS },
  isOverridden: (overrides, field) =>
    isContainerField(field)
      ? containerSource.isOverridden(overrides.container, field)
      : settingsSource.isOverridden(overrides.settings, field),
  withField: (overrides, field, value) =>
    isContainerField(field)
      ? {
          ...overrides,
          container: containerSource.withField(overrides.container, field, value?.container),
        }
      : {
          ...overrides,
          settings: settingsSource.withField(overrides.settings, field, value?.settings),
        },
};
