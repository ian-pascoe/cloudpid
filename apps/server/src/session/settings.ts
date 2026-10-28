// What a Session reads from the settings (`docs/architecture/overview.md` → Settings). The overrides live in the Registry DO; the Session
// keeps the last it read, in its own storage, and hands the Harness live getters over that copy. The Harness reads its
// settings synchronously, so the Registry is read before a request is admitted (`refresh`), never inside a getter.
import { DEFAULT_SETTINGS, parseModelId, resolveLeniently, type Settings } from "@cloudpid/config";
import { type SubagentOptions, subagentOptions } from "@cloudpid/extensions/subagents";
import { reloadToolSearch, type ToolSearchOptions } from "@cloudpid/extensions/tool-search";
import type {
  AgentChange,
  Extension,
  CompactionPolicy,
  HarnessSettings,
  ModelRef,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equivalence from "effect/Equivalence";
import * as Layer from "effect/Layer";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";

/** How long reading the Registry may take before the Session carries on with what it last read. */
export const SETTINGS_TIMEOUT: Duration.Input = "2 seconds";

/** How long after a failed read the Session leaves the Registry alone, so a Registry that is down costs one timeout. */
export const SETTINGS_BACKOFF: Duration.Input = "30 seconds";

/** What the Session and its Harness use of the settings. */
export type SessionSettingsValues = {
  /** The agent a root conversation follows unless its Session picked its own. */
  readonly agent: {
    readonly model: ModelRef;
    readonly thinkingLevel: NonNullable<AgentChange["thinkingLevel"]>;
  };
  readonly compaction: CompactionPolicy;
  /** The model roles, depth cap, and toolsets subagents are spawned with. */
  readonly subagents: SubagentOptions;
  /** Which tools every conversation's model is offered; the rest are deferred. */
  readonly toolSearch: ToolSearchOptions;
  /** US dollars the Session may spend on model requests; `null` for no limit. */
  readonly spendLimit: number | null;
};

/** The parts of `settings` a Session uses. */
export const valuesFrom = (settings: Settings): SessionSettingsValues => ({
  agent: { model: parseModelId(settings.model), thinkingLevel: settings.thinkingLevel },
  compaction: settings.compaction,
  subagents: subagentOptions(
    Record.map(settings.roles, (role) => ({ model: parseModelId(role.model), hint: role.hint })),
    settings.extensions["subagents"],
  ),
  toolSearch: { offered: settings.tools.offered },
  spendLimit: settings.spendLimit.perSession,
});

export type SessionSettingsService = {
  /** The settings as last read, or the defaults: synchronous, for the Harness's getters. */
  readonly current: () => SessionSettingsValues;
  /**
   * Read the Registry now. A Registry that fails or is slow keeps the settings last read, and is logged: the Session
   * must not stop for it.
   */
  readonly refresh: Effect.Effect<void>;
};

/** The Session's settings. */
export class SessionSettings extends Context.Service<SessionSettings, SessionSettingsService>()(
  "@cloudpid/server/session/settings/SessionSettings",
) {}

/** What the subagents extension reads of the Session's settings: their subagent options, as last read. */
export const subagentSettings = Effect.map(SessionSettings, (settings) => ({
  current: () => settings.current().subagents,
}));

const sameTools = Arr.makeEquivalence(Equivalence.strictEqual<string>());

/**
 * The extensions that follow the settings (`SessionHostOptions.reload`): `tool_search`, built again over the installed
 * extensions' tools when the offered tools changed, so the tools it defers follow the settings.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const reloadSessionExtensions = (
  installed: readonly Extension[],
  values: SessionSettingsValues,
  previous: SessionSettingsValues,
): readonly Extension[] =>
  sameTools(values.toolSearch.offered, previous.toolSearch.offered)
    ? []
    : [reloadToolSearch(installed, values.toolSearch)];

/** What the tool search extension reads of the Session's settings: the offered tools, as last read. */
export const toolSearchSettings = Effect.map(SessionSettings, (settings) => ({
  current: () => settings.current().toolSearch,
}));

/** The parts of a Durable Object's `storage.kv` the settings use. */
export type SettingsKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

/** Where the overrides last read are kept. */
const OVERRIDES_KEY = "settings-overrides";

export type SessionSettingsOptions = {
  /** The Registry's saved overrides. */
  readonly read: Effect.Effect<Schema.Json>;
  /** The object's `storage.kv`, which keeps the overrides last read for an instance that starts with the Registry down. */
  readonly kv: SettingsKv;
  /** Defaults to `SETTINGS_TIMEOUT`. */
  readonly timeout?: Duration.Input;
  /** After a read fails, how long `refresh` leaves the Registry alone. Defaults to `SETTINGS_BACKOFF`. */
  readonly backoff?: Duration.Input;
};

/** The settings the overrides give, with what no longer resolves left out and logged. */
const resolveLogged = (overrides: Schema.Json) => {
  const { settings, dropped } = resolveLeniently(overrides);

  return dropped.length === 0
    ? Effect.succeed(settings)
    : Effect.logWarning(
        `Saved settings overrides that no longer apply are ignored:\n${Arr.join(dropped, "\n")}`,
      ).pipe(Effect.as(settings));
};

/** The Session's settings, starting from the overrides last kept in `kv`. */
export const sessionSettingsLayer = (
  options: SessionSettingsOptions,
): Layer.Layer<SessionSettings> =>
  Layer.effect(
    SessionSettings,
    Effect.gen(function* () {
      const { kv } = options;
      const kept = kv.get<Schema.Json>(OVERRIDES_KEY);

      let current = valuesFrom(kept === undefined ? DEFAULT_SETTINGS : yield* resolveLogged(kept));

      /** When the last read failed, while its backoff may still run. */
      let failedAt: number | undefined;

      const read = options.read.pipe(
        Effect.timeout(options.timeout ?? SETTINGS_TIMEOUT),
        Effect.flatMap((overrides) =>
          resolveLogged(overrides).pipe(
            Effect.tap((settings) =>
              Effect.sync(() => {
                kv.put(OVERRIDES_KEY, overrides);
                current = valuesFrom(settings);
              }),
            ),
          ),
        ),
        Effect.asVoid,
        Effect.andThen(
          Effect.sync(() => {
            failedAt = undefined;
          }),
        ),
        Effect.catchCause((cause) =>
          Clock.currentTimeMillis.pipe(
            Effect.tap((now) =>
              Effect.sync(() => {
                failedAt = now;
              }),
            ),
            Effect.andThen(
              Effect.logWarning(
                "Reading the settings from the Registry failed",
                Cause.pretty(cause),
              ),
            ),
          ),
        ),
      );

      const refresh = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          failedAt !== undefined &&
          now - failedAt < Duration.toMillis(options.backoff ?? SETTINGS_BACKOFF)
            ? Effect.void
            : read,
        ),
      );

      return { current: () => current, refresh } satisfies SessionSettingsService;
    }),
  );

/**
 * The Harness's settings over a Session's: `compaction` is read at every resolution, so what `refresh` last read
 * applies to the next request. Idle conversations keep no context or documents in memory: pi-durable 1.3.0 holds them
 * on `setTimeout` timers, and in Workers a pending timer, even an unreferenced one, keeps the object from being evicted
 * or hibernating. SQLite is local to the object, so reloading them is cheap. pi-durable main declines these timers in
 * Workers itself.
 */
export const harnessSettings = (settings: SessionSettingsService): HarnessSettings => ({
  contextRetentionMs: 0,
  documentRetentionMs: 0,
  get compaction() {
    return settings.current().compaction;
  },
});
